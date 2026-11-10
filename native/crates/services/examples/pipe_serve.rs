//! Headless pipe server for equivalence runs: `pipe_serve <data-dir> <pipe-path>`.
//!
//! Opens the services on `<data-dir>` (a scratch folder) and serves the named pipe at
//! `<pipe-path>` until the process is killed. It never reads `LIZMETER_PIPE_PATH` and refuses the default
//! pipe path, so a run can not reach the installed app.

use lizmeter_db::data_location::DataLocation;
use lizmeter_services::os::RecordingHost;
use lizmeter_services::pipe::{default_pipe_path, PipeServer};
use lizmeter_services::Services;
use std::sync::Arc;

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(data_dir), Some(path)) = (args.next(), args.next()) else {
        eprintln!("usage: pipe_serve <data-dir> <pipe-path>");
        std::process::exit(2);
    };
    if path.eq_ignore_ascii_case(default_pipe_path()) {
        eprintln!("refusing the default pipe path");
        std::process::exit(2);
    }
    std::fs::create_dir_all(&data_dir).expect("data dir");
    let host = Arc::new(RecordingHost::default());
    let (svc, _) = Services::open(DataLocation::new(&data_dir), host, std::path::Path::new(&data_dir).join("projects")).expect("open");
    let server = match PipeServer::start_at(svc.clone(), &path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[pipe] Server error: {e}");
            std::process::exit(3);
        }
    };
    println!("ready {}", server.path());
    // Held for the life of the process: the pipe closes when the process ends.
    let _keep = (server, svc);
    loop {
        std::thread::park();
    }
}
