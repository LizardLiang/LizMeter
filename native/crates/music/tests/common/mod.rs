//! Test support: a local HTTP server, a fake yt-dlp executable and ffmpeg lookup.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Clone)]
pub struct Reply {
    pub status: u16,
    pub body: Vec<u8>,
    pub location: Option<String>,
}

impl Reply {
    pub fn ok(body: impl Into<Vec<u8>>) -> Self {
        Reply { status: 200, body: body.into(), location: None }
    }
    pub fn status(status: u16) -> Self {
        Reply { status, body: Vec::new(), location: None }
    }
    pub fn redirect(location: &str) -> Self {
        Reply { status: 302, body: Vec::new(), location: Some(location.to_string()) }
    }
}

type Routes = Arc<Mutex<HashMap<String, Vec<Reply>>>>;

/// A server on 127.0.0.1. A route with several replies serves them in order, then repeats the last.
pub struct Mock {
    pub base: String,
    routes: Routes,
    hits: Arc<Mutex<Vec<String>>>,
}

impl Mock {
    pub fn start() -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes: Routes = Arc::default();
        let hits: Arc<Mutex<Vec<String>>> = Arc::default();
        let (r, h) = (routes.clone(), hits.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (r, h) = (r.clone(), h.clone());
                std::thread::spawn(move || serve(stream, r, h));
            }
        });
        Mock { base, routes, hits }
    }

    pub fn route(&self, path: &str, replies: Vec<Reply>) {
        self.routes.lock().unwrap().insert(path.to_string(), replies);
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    pub fn host(&self) -> String {
        self.base.trim_start_matches("http://").split(':').next().unwrap().to_string()
    }

    pub fn hit_count(&self, path: &str) -> usize {
        self.hits.lock().unwrap().iter().filter(|p| p.as_str() == path).count()
    }
}

fn serve(mut stream: TcpStream, routes: Routes, hits: Arc<Mutex<Vec<String>>>) {
    let mut buf = [0u8; 4096];
    let mut req = Vec::new();
    while !req.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => req.extend_from_slice(&buf[..n]),
        }
    }
    let text = String::from_utf8_lossy(&req);
    let path = text.split_whitespace().nth(1).unwrap_or("/").to_string();
    hits.lock().unwrap().push(path.clone());
    let reply = {
        let mut r = routes.lock().unwrap();
        match r.get_mut(&path) {
            Some(v) if v.len() > 1 => v.remove(0),
            Some(v) if v.len() == 1 => v[0].clone(),
            _ => Reply::status(404),
        }
    };
    let reason = match reply.status {
        200 => "OK",
        302 => "Found",
        404 => "Not Found",
        _ => "Status",
    };
    let mut head = format!("HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, reason, reply.body.len());
    if let Some(l) = &reply.location {
        head.push_str(&format!("Location: {l}\r\n"));
    }
    head.push_str("\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&reply.body);
}

/// Path of a real ffmpeg for tests that decode audio: `LIZMETER_TEST_FFMPEG`, or `None` (the test
/// prints SKIP and returns).
pub fn ffmpeg() -> Option<PathBuf> {
    std::env::var_os("LIZMETER_TEST_FFMPEG").map(PathBuf::from).filter(|p| p.exists())
}

/// Writes a sine tone with ffmpeg; `extra` are output options (for example `-movflags +faststart`).
pub fn make_tone_with(ffmpeg: &Path, out: &Path, seconds: f64, hz: u32, extra: &[&str]) {
    let status = std::process::Command::new(ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
        .arg(format!("sine=frequency={hz}:duration={seconds}"))
        .args(extra)
        .arg(out)
        .status()
        .expect("run ffmpeg");
    assert!(status.success(), "ffmpeg could not make {}", out.display());
}

pub fn make_tone(ffmpeg: &Path, out: &Path, seconds: f64, hz: u32) {
    make_tone_with(ffmpeg, out, seconds, hz, &[]);
}

/// Compiles `stubs/fake_ytdlp.rs` once and returns the exe.
pub fn fake_ytdlp_exe() -> &'static Path {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let dir = std::env::temp_dir().join(format!("lizmeter-music-test-stub-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("fake-ytdlp.exe");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/stubs/fake_ytdlp.rs");
        let out = std::process::Command::new("rustc").arg(&src).arg("-O").arg("-o").arg(&exe).output().expect("rustc");
        assert!(out.status.success(), "stub build failed: {}", String::from_utf8_lossy(&out.stderr));
        exe
    })
}

/// A bin folder holding a fresh copy of the fake yt-dlp named `yt-dlp.exe`, with `fake.cfg` built
/// from `cfg` and the extra `files` (name, bytes) beside it. Returns the folder.
pub fn fake_bin_dir(root: &Path, cfg: &[(&str, &str)], files: &[(&str, &[u8])]) -> PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::copy(fake_ytdlp_exe(), bin.join("yt-dlp.exe")).unwrap();
    let text: String = cfg.iter().map(|(k, v)| format!("{k}={v}
")).collect();
    std::fs::write(bin.join("fake.cfg"), text).unwrap();
    for (name, bytes) in files {
        std::fs::write(bin.join(name), bytes).unwrap();
    }
    bin
}

/// `(role, pid)` lines the fake wrote.
pub fn read_pids(bin: &Path) -> Vec<(String, u32)> {
    std::fs::read_to_string(bin.join("pids.log"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once(' ').and_then(|(r, p)| p.trim().parse().ok().map(|p| (r.to_string(), p))))
        .collect()
}

pub fn read_args_log(bin: &Path) -> Vec<Vec<String>> {
    std::fs::read_to_string(bin.join("args.log"))
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

pub fn pid_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}
