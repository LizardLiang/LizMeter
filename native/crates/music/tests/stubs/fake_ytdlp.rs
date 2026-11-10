// A stand-in for yt-dlp used by the music tests. Behaviour comes from `fake.cfg` beside the exe
// (key=value lines); every call appends its arguments to `args.log` and its pid to `pids.log`.
use std::io::Write;

fn json_escape(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().unwrap().to_path_buf();
    let cfg_text = std::fs::read_to_string(dir.join("fake.cfg")).unwrap_or_default();
    let cfg = |k: &str| -> Option<String> {
        cfg_text.lines().find_map(|l| l.split_once('=').filter(|(key, _)| *key == k).map(|(_, v)| v.to_string()))
    };
    let line = format!("[{}]\n", args.iter().map(|a| json_escape(a)).collect::<Vec<_>>().join(","));
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("args.log")).and_then(|mut f| f.write_all(line.as_bytes()));
    let role = if args.iter().any(|a| a == "--version") {
        "version"
    } else if args.iter().any(|a| a == "--flat-playlist") {
        "playlist"
    } else if args.iter().any(|a| a == "--dump-json") {
        "meta"
    } else {
        "stream"
    };
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("pids.log"))
        .and_then(|mut f| f.write_all(format!("{role} {}\n", std::process::id()).as_bytes()));

    let delay = cfg("chunk_delay_ms").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    let out = std::io::stdout();
    let mut out = out.lock();
    match role {
        "version" => {
            let _ = writeln!(out, "{}", cfg("version").unwrap_or_else(|| "2099.01.01".into()));
        }
        "playlist" => {
            let text = std::fs::read_to_string(dir.join(cfg("playlist_file").unwrap_or_default())).unwrap_or_default();
            let limit = if args.iter().any(|a| a == "--playlist-items") { 2 } else { usize::MAX };
            for l in text.lines().filter(|l| !l.trim().is_empty()).take(limit) {
                let _ = writeln!(out, "{l}");
                let _ = out.flush();
                if delay > 0 {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                }
            }
            if cfg("hang_after_playlist").is_some() {
                std::thread::sleep(std::time::Duration::from_secs(600));
            }
        }
        "meta" => {
            let code: i32 = cfg("meta_exit").and_then(|v| v.parse().ok()).unwrap_or(0);
            if code != 0 {
                eprintln!("{}", cfg("stderr_msg").unwrap_or_else(|| "meta failed".into()));
                std::process::exit(code);
            }
            if cfg("meta_hang").is_some() {
                std::thread::sleep(std::time::Duration::from_secs(600));
            }
            let text = std::fs::read_to_string(dir.join(cfg("meta_file").unwrap_or_default())).unwrap_or_default();
            let _ = write!(out, "{text}");
        }
        _ => {
            let fmt = args.iter().position(|a| a == "-f").and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
            let mode = cfg("stream_mode").unwrap_or_else(|| "ok".into());
            let fail = |msg: &str| -> ! {
                eprintln!("{msg}");
                std::process::exit(1);
            };
            match mode.as_str() {
                "fail" => fail("stream failed"),
                "fail-m4a" if fmt.starts_with("bestaudio[ext=m4a]") => fail("m4a failed"),
                "hang" => {
                    if cfg("spawn_child").is_some() {
                        let child = std::process::Command::new("ping").args(["-n", "600", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
                        let _ = std::fs::OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(dir.join("pids.log"))
                            .and_then(|mut f| f.write_all(format!("child {}\n", child.id()).as_bytes()));
                    }
                    std::thread::sleep(std::time::Duration::from_secs(600));
                }
                _ => {
                    let data = std::fs::read(dir.join(cfg("stream_file").unwrap_or_default())).unwrap_or_default();
                    for chunk in data.chunks(16 * 1024) {
                        if out.write_all(chunk).is_err() {
                            return;
                        }
                        let _ = out.flush();
                        if delay > 0 {
                            std::thread::sleep(std::time::Duration::from_millis(delay));
                        }
                    }
                    if mode == "partial-fail" {
                        fail("stream cut off");
                    }
                }
            }
        }
    }
}
