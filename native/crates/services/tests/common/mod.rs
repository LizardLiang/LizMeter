#![allow(dead_code)]

use lizmeter_db::data_location::DataLocation;
use lizmeter_services::os::RecordingHost;
use lizmeter_services::Services;
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct Rig {
    pub _tmp: tempfile::TempDir,
    pub root: PathBuf,
    pub user_data: PathBuf,
    pub projects: PathBuf,
    pub host: Arc<RecordingHost>,
    pub svc: Arc<Services>,
}

pub fn rig() -> Rig {
    // The music release URLs point at a closed port: no test may reach GitHub.
    std::env::set_var("LIZMETER_YT_DLP_API_URL", "http://127.0.0.1:9/yt-dlp");
    std::env::set_var("LIZMETER_FFMPEG_API_URL", "http://127.0.0.1:9/ffmpeg");
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let user_data = root.join("userData");
    let projects = root.join("projects");
    std::fs::create_dir_all(&user_data).unwrap();
    std::fs::create_dir_all(&projects).unwrap();
    let host = Arc::new(RecordingHost::default());
    let (svc, _report) = Services::open(DataLocation::new(&user_data), host.clone(), &projects).unwrap();
    Rig { _tmp: tmp, root, user_data, projects, host, svc }
}

/// Calls a channel and remembers it, so a test can prove every channel was exercised.
pub struct Caller<'a> {
    pub svc: &'a Services,
    pub seen: Mutex<BTreeSet<String>>,
}

impl<'a> Caller<'a> {
    pub fn new(svc: &'a Services) -> Self {
        Caller { svc, seen: Mutex::new(BTreeSet::new()) }
    }

    pub fn call(&self, channel: &str, args: Vec<Value>) -> Value {
        self.seen.lock().unwrap().insert(channel.to_string());
        self.svc.dispatch(channel, &args).unwrap_or_else(|e| panic!("{channel} failed: {e}"))
    }

    pub fn call_err(&self, channel: &str, args: Vec<Value>) -> String {
        self.seen.lock().unwrap().insert(channel.to_string());
        self.svc.dispatch(channel, &args).expect_err(channel).to_string()
    }
}

pub mod mock;
