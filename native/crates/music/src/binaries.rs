//! `binary-manager.ts`: detect, download, verify and manage the yt-dlp and ffmpeg binaries kept in
//! `<userData>/bin`.
//!
//! Checksums fail closed, as in the Electron build: an unreachable or incomplete checksum file is
//! `CHECKSUM_UNAVAILABLE`, a wrong digest is `HASH_MISMATCH`, and nothing is installed in either case.

use crate::error::{MusicError, Result};
use crate::process::run_capture;
use lizmeter_core::{BinaryDownloadProgress, BinaryInfo, BinaryStatus, MusicErrorCode};
use reqwest::blocking::{Client, Response};
use reqwest::redirect::Policy;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const YT_DLP_API_URL: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const FFMPEG_API_URL: &str = "https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest";
const GITHUB_USER_AGENT: &str = "LizMeter/1.0";
const MAX_REDIRECTS: u32 = 5;
const ALLOWED_REDIRECT_HOSTS: [&str; 5] = [
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "github-releases.githubusercontent.com",
];

#[cfg(windows)]
const YT_DLP_FILE: &str = "yt-dlp.exe";
#[cfg(not(windows))]
const YT_DLP_FILE: &str = "yt-dlp";
#[cfg(windows)]
const FFMPEG_FILE: &str = "ffmpeg.exe";
#[cfg(not(windows))]
const FFMPEG_FILE: &str = "ffmpeg";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Where releases come from. The default is GitHub; tests point it at a local server.
#[derive(Debug, Clone)]
pub struct Sources {
    pub yt_dlp_api: String,
    pub ffmpeg_api: String,
    /// Hosts a redirect may name besides the GitHub delivery hosts.
    pub extra_allowed_hosts: Vec<String>,
    /// Accept `http:` redirects (tests only).
    pub allow_http: bool,
}

impl Default for Sources {
    fn default() -> Self {
        Sources { yt_dlp_api: YT_DLP_API_URL.into(), ffmpeg_api: FFMPEG_API_URL.into(), extra_allowed_hosts: Vec::new(), allow_http: false }
    }
}

impl Sources {
    /// The defaults, with the release URLs overridden by `LIZMETER_YT_DLP_API_URL` and
    /// `LIZMETER_FFMPEG_API_URL` in debug builds (a release build ignores them). The override's
    /// host is allowed as a redirect target and plain `http:` is accepted.
    pub fn from_env() -> Self {
        let mut s = Sources::default();
        if cfg!(debug_assertions) {
            for (var, slot) in [("LIZMETER_YT_DLP_API_URL", &mut s.yt_dlp_api), ("LIZMETER_FFMPEG_API_URL", &mut s.ffmpeg_api)] {
                if let Ok(v) = std::env::var(var) {
                    if let Some(host) = reqwest::Url::parse(&v).ok().and_then(|u| u.host_str().map(str::to_string)) {
                        s.extra_allowed_hosts.push(host);
                        s.allow_http = true;
                        *slot = v;
                    }
                }
            }
        }
        s
    }
}

#[derive(Deserialize)]
struct GitHubAsset {
    name: String,
    size: i64,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GitHubRelease {
    assets: Vec<GitHubAsset>,
}

pub struct BinaryManager {
    bin_dir: PathBuf,
    sources: Sources,
    downloading: AtomicBool,
    cached_status: Mutex<Option<BinaryStatus>>,
}

/// Clears the download flag however `download` ends.
struct DownloadFlag<'a>(&'a AtomicBool);

impl Drop for DownloadFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn err(code: MusicErrorCode, message: impl Into<String>) -> MusicError {
    MusicError::new(code, message)
}

impl BinaryManager {
    /// `user_data` is the folder that holds `bin/` and `music-cache/` (Electron's `userData`).
    pub fn new(user_data: &Path) -> Self {
        Self::with_sources(user_data, Sources::default())
    }

    pub fn with_sources(user_data: &Path, sources: Sources) -> Self {
        BinaryManager { bin_dir: user_data.join("bin"), sources, downloading: AtomicBool::new(false), cached_status: Mutex::new(None) }
    }

    /// The binary folder, created when missing.
    pub fn bin_dir(&self) -> PathBuf {
        let _ = fs::create_dir_all(&self.bin_dir);
        self.bin_dir.clone()
    }

    pub fn yt_dlp_path(&self) -> PathBuf {
        self.bin_dir().join(YT_DLP_FILE)
    }

    pub fn ffmpeg_path(&self) -> PathBuf {
        self.bin_dir().join(FFMPEG_FILE)
    }

    /// Existence plus a health check: each binary is run, and one that cannot start or exits with an
    /// error is deleted so the next download replaces it. A check that runs out of time keeps the
    /// file: yt-dlp unpacks itself on every start (3-4 s, longer under a virus scan), and a slow start
    /// is not a broken binary. The result is cached until a download finishes.
    pub fn check(&self) -> BinaryStatus {
        if let Some(s) = lock(&self.cached_status).clone() {
            return s;
        }
        let (yt, ff) = (self.yt_dlp_path(), self.ffmpeg_path());
        let mut yt_installed = yt.exists();
        let mut ff_installed = ff.exists();
        let mut version = None;
        if yt_installed {
            match run_capture(&yt, &["--version"], Duration::from_secs(5)) {
                Ok(o) if o.code == Some(0) => {
                    let v = o.stdout.trim();
                    version = (!v.is_empty()).then(|| v.to_string());
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                _ => {
                    yt_installed = false;
                    let _ = fs::remove_file(&yt);
                }
            }
        }
        if ff_installed {
            match run_capture(&ff, &["-version"], Duration::from_secs(5)) {
                Ok(o) if o.code == Some(0) => {}
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                _ => {
                    ff_installed = false;
                    let _ = fs::remove_file(&ff);
                }
            }
        }
        let status = BinaryStatus { yt_dlp_installed: yt_installed, ffmpeg_installed: ff_installed, yt_dlp_version: version };
        *lock(&self.cached_status) = Some(status.clone());
        status
    }

    /// Forgets the cached status (after a reset or a download).
    pub fn reset_cache(&self) {
        *lock(&self.cached_status) = None;
    }

    /// Download sizes and URLs from the releases API. A network failure returns the static fields
    /// with `error` set.
    pub fn info(&self) -> BinaryInfo {
        let static_fields = |error: Option<String>| BinaryInfo {
            yt_dlp_size: None,
            ffmpeg_size: None,
            storage_path: self.bin_dir().to_string_lossy().into_owned(),
            yt_dlp_filename: YT_DLP_FILE.into(),
            ffmpeg_filename: FFMPEG_FILE.into(),
            yt_dlp_url: None,
            ffmpeg_url: None,
            error,
        };
        let result = (|| -> std::result::Result<(GitHubRelease, GitHubRelease), String> {
            let http = self.http()?;
            let yt = self.fetch_release(&http, &self.sources.yt_dlp_api)?;
            let ff = self.fetch_release(&http, &self.sources.ffmpeg_api)?;
            Ok((yt, ff))
        })();
        match result {
            Ok((yt, ff)) => {
                let yt_asset = select_yt_dlp_asset(&yt.assets);
                let ff_asset = select_ffmpeg_asset(&ff.assets);
                BinaryInfo {
                    yt_dlp_size: yt_asset.map(|a| a.size),
                    ffmpeg_size: ff_asset.map(|a| a.size),
                    yt_dlp_url: yt_asset.map(|a| a.browser_download_url.clone()),
                    ffmpeg_url: ff_asset.map(|a| a.browser_download_url.clone()),
                    ..static_fields(None)
                }
            }
            Err(e) => static_fields(Some(format!("Failed to fetch binary info: {e}"))),
        }
    }

    /// Downloads yt-dlp and ffmpeg with SHA-256 verification. Each file is written beside its final
    /// name as `.tmp` and renamed, so an interrupted download never leaves a half binary. Progress
    /// is reported about every 100 ms.
    pub fn download(&self, on_progress: &mut dyn FnMut(BinaryDownloadProgress)) -> Result<()> {
        if self.downloading.swap(true, Ordering::SeqCst) {
            return Err(err(MusicErrorCode::DownloadInProgress, "Download already in progress"));
        }
        let _flag = DownloadFlag(&self.downloading);
        self.reset_cache();

        let bin_dir = self.bin_dir();
        let yt_final = self.yt_dlp_path();
        let ff_final = self.ffmpeg_path();
        let yt_tmp = with_suffix(&yt_final, ".tmp");
        let ff_archive_tmp = bin_dir.join("ffmpeg-archive.tmp");
        let ff_bin_tmp = with_suffix(&ff_final, ".tmp");

        let mut run = || -> Result<()> {
            let info = self.info();
            let (Some(yt_url), Some(ff_url)) = (info.yt_dlp_url.clone(), info.ffmpeg_url.clone()) else {
                return Err(err(
                    MusicErrorCode::NetworkError,
                    info.error.unwrap_or_else(|| "Could not determine download URLs. Check network connection.".into()),
                ));
            };
            let http = self.http().map_err(|e| err(MusicErrorCode::BinaryDownloadFailed, format!("Binary download failed: {e}")))?;

            self.download_file(&http, &yt_url, &yt_tmp, "yt-dlp", on_progress)?;
            self.verify_yt_dlp_checksum(&http, &yt_url, &yt_tmp)?;
            fs::rename(&yt_tmp, &yt_final).map_err(io_failure)?;

            self.download_file(&http, &ff_url, &ff_archive_tmp, "ffmpeg", on_progress)?;
            self.verify_ffmpeg_checksum(&http, &ff_url, &ff_archive_tmp)?;
            extract_ffmpeg_from_zip(&ff_archive_tmp, &ff_bin_tmp)?;
            fs::rename(&ff_bin_tmp, &ff_final).map_err(io_failure)?;
            Ok(())
        };
        let result = run();
        if result.is_err() {
            for p in [&yt_tmp, &ff_archive_tmp, &ff_bin_tmp] {
                let _ = fs::remove_file(p);
            }
        }
        let _ = fs::remove_file(&ff_archive_tmp);
        self.reset_cache();
        result
    }

    // --- HTTP ---

    fn http(&self) -> std::result::Result<Client, String> {
        Client::builder().redirect(Policy::none()).build().map_err(|e| e.to_string())
    }

    /// GET with manual redirects, so every hop is checked against the allowed hosts.
    fn get(&self, http: &Client, url: &str, accept: Option<&str>, timeout: Option<Duration>) -> std::result::Result<Response, String> {
        let mut current = url.to_string();
        let mut redirects = 0;
        loop {
            let mut req = http.get(&current).header("User-Agent", GITHUB_USER_AGENT);
            if let Some(a) = accept {
                req = req.header("Accept", a);
            }
            if let Some(t) = timeout {
                req = req.timeout(t);
            }
            let resp = req.send().map_err(|e| e.to_string())?;
            let status = resp.status().as_u16();
            if matches!(status, 301 | 302 | 307 | 308) {
                let location = resp.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
                current = self.redirect_url(&current, location.as_deref(), redirects)?;
                redirects += 1;
                continue;
            }
            return Ok(resp);
        }
    }

    pub fn redirect_url(&self, current: &str, location: Option<&str>, count: u32) -> std::result::Result<String, String> {
        if count >= MAX_REDIRECTS {
            return Err(format!("Too many redirects (maximum {MAX_REDIRECTS})"));
        }
        let Some(location) = location else {
            return Err(format!("Redirect with no location header from {current}"));
        };
        let base = reqwest::Url::parse(current).map_err(|e| e.to_string())?;
        let target = base.join(location).map_err(|e| e.to_string())?;
        if target.scheme() != "https" && !(self.sources.allow_http && target.scheme() == "http") {
            return Err(format!("Redirect protocol is not permitted: {}:", target.scheme()));
        }
        let host = target.host_str().unwrap_or("").to_lowercase();
        let allowed = ALLOWED_REDIRECT_HOSTS.contains(&host.as_str()) || self.sources.extra_allowed_hosts.iter().any(|h| h.eq_ignore_ascii_case(&host));
        if !allowed {
            return Err(format!("Redirect host is not permitted: {host}"));
        }
        Ok(target.to_string())
    }

    fn fetch_release(&self, http: &Client, url: &str) -> std::result::Result<GitHubRelease, String> {
        let resp = self.get(http, url, Some("application/vnd.github+json"), Some(Duration::from_secs(15)))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("GitHub API returned status {}", status.as_u16()));
        }
        let body = resp.text().map_err(|e| e.to_string())?;
        serde_json::from_str(&body).map_err(|e| format!("Failed to parse GitHub API response: {e}"))
    }

    fn fetch_text(&self, http: &Client, url: &str) -> std::result::Result<String, String> {
        let resp = self.get(http, url, None, Some(Duration::from_secs(10)))?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {}", status.as_u16()));
        }
        resp.text().map_err(|e| e.to_string())
    }

    fn download_file(&self, http: &Client, url: &str, dest: &Path, binary: &str, on_progress: &mut dyn FnMut(BinaryDownloadProgress)) -> Result<()> {
        let fail = |m: String| err(MusicErrorCode::BinaryDownloadFailed, format!("Binary download failed: {m}"));
        // The archive is about 80 MB: the bound is a ceiling for a stalled connection, not a pace.
        let mut resp = self.get(http, url, None, Some(Duration::from_secs(30 * 60))).map_err(fail)?;
        if !resp.status().is_success() {
            return Err(fail(format!("Download returned HTTP {} for {url}", resp.status().as_u16())));
        }
        let total = resp.content_length().unwrap_or(0) as i64;
        let mut file = fs::File::create(dest).map_err(|e| fail(e.to_string()))?;
        let mut buf = vec![0u8; 64 * 1024];
        let (mut downloaded, mut speed_accum) = (0i64, 0i64);
        let mut speed = 0f64;
        let (mut last_progress, mut last_speed) = (Instant::now(), Instant::now());
        loop {
            let n = resp.read(&mut buf).map_err(|e| fail(e.to_string()))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| fail(e.to_string()))?;
            downloaded += n as i64;
            speed_accum += n as i64;
            let now = Instant::now();
            if now.duration_since(last_speed) >= Duration::from_millis(500) {
                speed = (speed_accum as f64 / now.duration_since(last_speed).as_millis() as f64 * 1000.0).round();
                speed_accum = 0;
                last_speed = now;
            }
            if now.duration_since(last_progress) >= Duration::from_millis(100) {
                let percent = if total > 0 { (downloaded as f64 / total as f64 * 100.0).round() } else { 0.0 };
                on_progress(BinaryDownloadProgress { binary: binary.into(), percent, bytes_downloaded: downloaded, total_bytes: total, speed });
                last_progress = now;
            }
        }
        file.flush().map_err(|e| fail(e.to_string()))?;
        let percent = if total > 0 { 100.0 } else { 0.0 };
        on_progress(BinaryDownloadProgress { binary: binary.into(), percent, bytes_downloaded: downloaded, total_bytes: total, speed });
        Ok(())
    }

    // --- Checksums ---

    pub fn verify_yt_dlp_checksum(&self, http: &Client, binary_url: &str, file: &Path) -> Result<()> {
        // `SHA2-256SUMS` sits beside the binary in the same release.
        let checksum_url = match binary_url.rfind('/') {
            Some(i) => format!("{}/SHA2-256SUMS", &binary_url[..i]),
            None => binary_url.to_string(),
        };
        let content = self.fetch_text(http, &checksum_url).map_err(|e| checksum_unavailable("yt-dlp", &e))?;
        // The file is `yt-dlp.exe.tmp` on disk; the manifest lists `yt-dlp.exe`.
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let name = name.strip_suffix(".tmp").unwrap_or(&name).to_string();
        let Some(expected) = parse_checksum_file(&content, &name) else {
            return Err(err(MusicErrorCode::ChecksumUnavailable, format!("SHA256 verification unavailable for yt-dlp: no valid checksum entry for {name}")));
        };
        let actual = compute_sha256(file).map_err(|e| checksum_unavailable("yt-dlp", &e.to_string()))?;
        if !actual.eq_ignore_ascii_case(&expected) {
            return Err(err(MusicErrorCode::HashMismatch, format!("SHA256 hash mismatch for yt-dlp: expected {expected}, got {actual}")));
        }
        Ok(())
    }

    /// FFmpeg-Builds publishes one `checksums.sha256` per release, not a file per archive. The
    /// per-archive `<archive>.sha256` the Electron build asks for returns 404 on the real release,
    /// so the manifest is the fallback. Still fail closed: no entry anywhere is
    /// `CHECKSUM_UNAVAILABLE`, a wrong digest is `HASH_MISMATCH`.
    pub fn verify_ffmpeg_checksum(&self, http: &Client, archive_url: &str, archive: &Path) -> Result<()> {
        // The archive is saved under a generic temp name, so match the manifest against the
        // asset's file name from the trusted URL.
        let url = reqwest::Url::parse(archive_url).map_err(|e| checksum_unavailable("ffmpeg archive", &e.to_string()))?;
        let last = url.path().rsplit('/').next().unwrap_or("");
        let name = percent_decode(last);
        let manifest_url = match archive_url.rfind('/') {
            Some(i) => format!("{}/checksums.sha256", &archive_url[..i]),
            None => archive_url.to_string(),
        };

        let mut first_error: Option<String> = None;
        let mut expected: Option<String> = None;
        for checksum_url in [format!("{archive_url}.sha256"), manifest_url] {
            match self.fetch_text(http, &checksum_url) {
                Ok(content) => {
                    if let Some(h) = parse_checksum_file(&content, &name) {
                        expected = Some(h);
                        break;
                    }
                }
                Err(e) => {
                    first_error.get_or_insert(e);
                }
            }
        }
        let Some(expected) = expected else {
            return Err(match first_error {
                Some(e) => checksum_unavailable("ffmpeg archive", &e),
                None => err(MusicErrorCode::ChecksumUnavailable, format!("SHA256 verification unavailable for ffmpeg archive: no valid checksum entry for {name}")),
            });
        };
        let actual = compute_sha256(archive).map_err(|e| checksum_unavailable("ffmpeg archive", &e.to_string()))?;
        if !actual.eq_ignore_ascii_case(&expected) {
            return Err(err(MusicErrorCode::HashMismatch, format!("SHA256 hash mismatch for ffmpeg archive: expected {expected}, got {actual}")));
        }
        Ok(())
    }

    /// The HTTP client the downloads use (no automatic redirects).
    pub fn client(&self) -> Client {
        self.http().expect("http client")
    }
}

fn io_failure(e: std::io::Error) -> MusicError {
    err(MusicErrorCode::BinaryDownloadFailed, format!("Binary download failed: {e}"))
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

fn checksum_unavailable(binary: &str, reason: &str) -> MusicError {
    err(MusicErrorCode::ChecksumUnavailable, format!("SHA256 verification unavailable for {binary}: {reason}"))
}

fn select_yt_dlp_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    assets.iter().find(|a| a.name == YT_DLP_FILE)
}

/// The static Windows build: the shared build (about 0.5 MB) needs DLLs that are not on disk.
fn select_ffmpeg_asset(assets: &[GitHubAsset]) -> Option<&GitHubAsset> {
    assets.iter().find(|a| a.name.ends_with(".zip") && a.name.contains("win64") && !a.name.contains("shared") && !a.name.contains("sha256"))
}

/// Parses `<hash>  <filename>` lines and returns the hash for `filename`.
pub fn parse_checksum_file(content: &str, filename: &str) -> Option<String> {
    for line in content.split('\n') {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let parts: Vec<&str> = t.split_whitespace().collect();
        if parts.len() >= 2 {
            let hash = parts[0];
            let name = parts[parts.len() - 1];
            let is_hex = hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit());
            if is_hex && (name == filename || name.ends_with(&format!("/{filename}"))) {
                return Some(hash.to_string());
            }
        }
    }
    None
}

/// SHA-256 hex digest of a file, read in chunks (never the whole file in memory).
pub fn compute_sha256(path: &Path) -> std::io::Result<String> {
    let mut f = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

fn extract_ffmpeg_from_zip(zip_path: &Path, dest: &Path) -> Result<()> {
    let fail = |m: String| err(MusicErrorCode::BinaryDownloadFailed, m);
    let file = fs::File::open(zip_path).map_err(|e| fail(e.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| fail(e.to_string()))?;
    // The binary may sit inside a folder.
    let idx = (0..archive.len()).find(|&i| archive.by_index(i).map(|e| e.name().ends_with("ffmpeg.exe") && !e.is_dir()).unwrap_or(false));
    let Some(idx) = idx else {
        return Err(fail("ffmpeg.exe not found in downloaded archive".into()));
    };
    let mut entry = archive.by_index(idx).map_err(|e| fail(e.to_string()))?;
    let mut out = fs::File::create(dest).map_err(|e| fail(e.to_string()))?;
    std::io::copy(&mut entry, &mut out).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

/// `decodeURIComponent` for the ASCII-escaped file names GitHub uses.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
