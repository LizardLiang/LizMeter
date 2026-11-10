//! Port of `electron/main/__tests__/binary-manager.test.ts`, against a local server.
mod common;

use common::{fake_ytdlp_exe, Mock, Reply};
use lizmeter_core::MusicErrorCode;
use lizmeter_music::binaries::{compute_sha256, parse_checksum_file, BinaryManager, Sources};
use sha2::{Digest, Sha256};
use std::io::Write;

fn sha(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn release(asset_url: &str, name: &str) -> Vec<u8> {
    serde_json::json!({ "assets": [{ "name": name, "size": 10, "browser_download_url": asset_url }] }).to_string().into_bytes()
}

struct Rig {
    mock: Mock,
    root: tempfile::TempDir,
    mgr: BinaryManager,
}

fn rig() -> Rig {
    let mock = Mock::start();
    let root = tempfile::tempdir().unwrap();
    let sources = Sources { yt_dlp_api: mock.url("/yt-api"), ffmpeg_api: mock.url("/ff-api"), extra_allowed_hosts: vec![mock.host()], allow_http: true };
    let mgr = BinaryManager::with_sources(root.path(), sources);
    mock.route("/yt-api", vec![Reply::ok(release(&mock.url("/dl/yt-dlp.exe"), "yt-dlp.exe"))]);
    mock.route("/ff-api", vec![Reply::ok(release(&mock.url("/dl/ffmpeg-win64.zip"), "ffmpeg-win64.zip"))]);
    Rig { mock, root, mgr }
}

fn zip_with_ffmpeg(content: &[u8]) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    {
        let mut w = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default();
        w.start_file("ffmpeg-n7-win64/bin/ffmpeg.exe", opts).unwrap();
        w.write_all(content).unwrap();
        w.finish().unwrap();
    }
    buf.into_inner()
}

fn download(r: &Rig) -> Result<(), lizmeter_music::MusicError> {
    r.mgr.download(&mut |_| {})
}

#[test]
fn fails_closed_with_checksum_unavailable_when_a_checksum_file_cannot_be_fetched() {
    let r = rig();
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::ok("yt-dlp")]);
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::status(404)]);
    let e = download(&r).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::ChecksumUnavailable);
    assert!(!r.root.path().join("bin/yt-dlp.exe").exists());
    assert!(!r.root.path().join("bin/yt-dlp.exe.tmp").exists());
}

#[test]
fn fails_closed_when_the_checksum_manifest_lacks_the_downloaded_filename() {
    let r = rig();
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::ok("yt-dlp")]);
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  another-file.exe\n", sha(b"yt-dlp")))]);
    assert_eq!(download(&r).unwrap_err().code, MusicErrorCode::ChecksumUnavailable);
}

#[test]
fn keeps_a_confirmed_hash_mismatch_distinct_and_removes_the_temp_file() {
    let r = rig();
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::ok("yt-dlp")]);
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  yt-dlp.exe\n", "0".repeat(64)))]);
    let e = download(&r).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::HashMismatch);
    assert!(e.message.contains("expected 000"));
    assert!(!r.root.path().join("bin/yt-dlp.exe").exists());
    assert!(!r.root.path().join("bin/yt-dlp.exe.tmp").exists());
}

#[test]
fn classifies_a_local_hashing_failure_as_unavailable_verification() {
    let r = rig();
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  yt-dlp.exe\n", sha(b"yt-dlp")))]);
    let missing = r.root.path().join("bin/yt-dlp.exe.tmp");
    let e = r.mgr.verify_yt_dlp_checksum(&r.mgr.client(), &r.mock.url("/dl/yt-dlp.exe"), &missing).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::ChecksumUnavailable);
}

#[test]
fn rejects_an_ffmpeg_checksum_for_a_different_archive_instead_of_trusting_its_first_token() {
    let r = rig();
    let yt = b"yt-dlp";
    let archive = b"not-needed-before-verification";
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::ok(yt.to_vec())]);
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  yt-dlp.exe\n", sha(yt)))]);
    r.mock.route("/dl/ffmpeg-win64.zip", vec![Reply::ok(archive.to_vec())]);
    r.mock.route("/dl/ffmpeg-win64.zip.sha256", vec![Reply::ok(format!("{}  different-archive.zip\n", sha(archive)))]);
    assert_eq!(download(&r).unwrap_err().code, MusicErrorCode::ChecksumUnavailable);
    assert!(!r.root.path().join("bin/ffmpeg-archive.tmp").exists());
}

#[test]
fn ffmpeg_falls_back_to_the_release_checksums_manifest_when_there_is_no_per_archive_file() {
    // The real FFmpeg-Builds release has `checksums.sha256` and no `<archive>.sha256`.
    let r = rig();
    let yt = std::fs::read(fake_ytdlp_exe()).unwrap();
    let archive = zip_with_ffmpeg(&yt);
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::ok(yt.clone())]);
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  yt-dlp.exe
", sha(&yt)))]);
    r.mock.route("/dl/ffmpeg-win64.zip", vec![Reply::ok(archive.clone())]);
    r.mock.route("/dl/ffmpeg-win64.zip.sha256", vec![Reply::status(404)]);
    r.mock.route("/dl/checksums.sha256", vec![Reply::ok(format!("{}  other.zip
{}  ffmpeg-win64.zip
", "1".repeat(64), sha(&archive)))]);
    download(&r).unwrap();
    assert!(r.mgr.ffmpeg_path().exists());
    // A wrong digest in the manifest is still a mismatch, not an install.
    let bad = rig();
    bad.mock.route("/dl/yt-dlp.exe", vec![Reply::ok(yt.clone())]);
    bad.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  yt-dlp.exe
", sha(&yt)))]);
    bad.mock.route("/dl/ffmpeg-win64.zip", vec![Reply::ok(archive)]);
    bad.mock.route("/dl/checksums.sha256", vec![Reply::ok(format!("{}  ffmpeg-win64.zip
", "2".repeat(64)))]);
    assert_eq!(download(&bad).unwrap_err().code, MusicErrorCode::HashMismatch);
    assert!(!bad.mgr.ffmpeg_path().exists());
}

#[test]
fn the_real_release_manifest_has_an_entry_for_the_archive_the_asset_filter_picks() {
    let manifest = include_str!("fixtures/ffmpeg-builds-checksums.sha256");
    let hash = parse_checksum_file(manifest, "ffmpeg-master-latest-win64-gpl.zip").expect("entry");
    assert_eq!(hash, "d291edb944522f517e344e1825364f22a94467b22ec54f34a0d33cb0fd331f3e");
    assert_eq!(parse_checksum_file(manifest, "ffmpeg-master-latest-win64-gpl-shared.zip").unwrap().len(), 64);
}

#[test]
fn rejects_redirects_to_hosts_outside_the_github_release_delivery_boundary() {
    let r = rig();
    r.mock.route("/yt-api", vec![Reply::redirect("https://evil.example/releases/latest")]);
    let info = r.mgr.info();
    assert!(info.error.unwrap().contains("Redirect host is not permitted"));
    assert_eq!(info.yt_dlp_url, None);
}

#[test]
fn rejects_a_plain_http_redirect_in_the_default_configuration() {
    let m = BinaryManager::new(tempfile::tempdir().unwrap().path());
    assert!(m.redirect_url("https://api.github.com/x", Some("http://github.com/y"), 0).unwrap_err().contains("protocol is not permitted"));
    assert_eq!(
        m.redirect_url("https://api.github.com/x", Some("/repos/y"), 0).unwrap(),
        "https://api.github.com/repos/y"
    );
    assert!(m.redirect_url("https://api.github.com/x", None, 0).unwrap_err().contains("no location header"));
}

#[test]
fn stops_redirect_loops_after_five_hops() {
    let r = rig();
    let loop_url = r.mock.url("/loop");
    r.mock.route("/yt-api", vec![Reply::redirect(&loop_url)]);
    r.mock.route("/loop", vec![Reply::redirect(&loop_url)]);
    let info = r.mgr.info();
    assert!(info.error.unwrap().contains("Too many redirects"));
    assert_eq!(r.mock.hit_count("/loop"), 5);
}

#[test]
fn a_full_download_installs_both_binaries_reports_progress_and_check_sees_them() {
    let r = rig();
    let yt = std::fs::read(fake_ytdlp_exe()).unwrap();
    let archive = zip_with_ffmpeg(&yt);
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::ok(yt.clone())]);
    r.mock.route("/dl/SHA2-256SUMS", vec![Reply::ok(format!("{}  yt-dlp.exe\n", sha(&yt)))]);
    r.mock.route("/dl/ffmpeg-win64.zip", vec![Reply::ok(archive.clone())]);
    r.mock.route("/dl/ffmpeg-win64.zip.sha256", vec![Reply::ok(format!("{}  ffmpeg-win64.zip\n", sha(&archive)))]);
    let mut events = Vec::new();
    r.mgr.download(&mut |p| events.push((p.binary.clone(), p.percent))).unwrap();
    assert!(events.iter().any(|(b, p)| b == "yt-dlp" && *p == 100.0));
    assert!(events.iter().any(|(b, p)| b == "ffmpeg" && *p == 100.0));
    assert_eq!(compute_sha256(&r.mgr.yt_dlp_path()).unwrap(), sha(&yt));
    assert_eq!(compute_sha256(&r.mgr.ffmpeg_path()).unwrap(), sha(&yt));
    assert!(!r.root.path().join("bin/ffmpeg-archive.tmp").exists());
    let status = r.mgr.check();
    assert!(status.yt_dlp_installed && status.ffmpeg_installed);
    assert_eq!(status.yt_dlp_version.as_deref(), Some("2099.01.01"));
}

#[test]
fn the_download_flag_clears_after_a_failure_so_a_retry_is_not_blocked() {
    let r = rig();
    r.mock.route("/dl/yt-dlp.exe", vec![Reply::status(404)]);
    assert_eq!(download(&r).unwrap_err().code, MusicErrorCode::BinaryDownloadFailed);
    assert_ne!(download(&r).unwrap_err().code, MusicErrorCode::DownloadInProgress);
}

#[test]
fn missing_download_urls_are_a_network_error() {
    let r = rig();
    r.mock.route("/yt-api", vec![Reply::status(500)]);
    let e = download(&r).unwrap_err();
    assert_eq!(e.code, MusicErrorCode::NetworkError);
    assert!(e.message.contains("GitHub API returned status 500"));
}

#[test]
fn check_deletes_a_binary_that_cannot_start() {
    let r = rig();
    let bin = r.mgr.bin_dir();
    std::fs::write(bin.join("yt-dlp.exe"), b"not an executable").unwrap();
    let status = r.mgr.check();
    assert!(!status.yt_dlp_installed);
    assert!(!bin.join("yt-dlp.exe").exists());
    assert!(!status.ffmpeg_installed);
}

#[test]
fn parses_checksum_manifests() {
    let h = "a".repeat(64);
    assert_eq!(parse_checksum_file(&format!("{h}  yt-dlp.exe\n"), "yt-dlp.exe"), Some(h.clone()));
    assert_eq!(parse_checksum_file(&format!("{h} *dir/yt-dlp.exe\n"), "yt-dlp.exe"), Some(h.clone()));
    assert_eq!(parse_checksum_file(&format!("{h}  other.exe\n"), "yt-dlp.exe"), None);
    assert_eq!(parse_checksum_file("nothex  yt-dlp.exe\n", "yt-dlp.exe"), None);
}
