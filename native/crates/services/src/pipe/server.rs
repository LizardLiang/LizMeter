//! The Windows named pipe listener. Node's `net.Server.listen` on a pipe path creates the first
//! instance with `FILE_FLAG_FIRST_PIPE_INSTANCE`, so a path another process already owns fails
//! with `EADDRINUSE` instead of being shared; this does the same, and the caller carries on
//! without a pipe (the Electron build logs `[pipe] Server error` and keeps running).

use super::{pipe_path, Connection, Protocol, Wire};
use crate::Services;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};

const BUFFER: u32 = 65_536;

/// A running pipe server. Dropping it stops accepting new connections.
pub struct PipeServer {
    path: String,
    proto: Arc<Protocol>,
    stop: Arc<AtomicBool>,
    pending: Arc<AtomicUsize>,
    stopped: bool,
}

fn wide(path: &str) -> Vec<u16> {
    std::ffi::OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
}

/// A raw handle that may cross to the thread that serves it.
struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

fn create_instance(path: &str, first: bool) -> std::io::Result<SendHandle> {
    let name = wide(path);
    let mut open_mode = PIPE_ACCESS_DUPLEX;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the call.
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            open_mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            None,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    Ok(SendHandle(handle))
}

/// What `listen` reports in Node for a pipe path that is already owned.
fn listen_error(path: &str, e: std::io::Error) -> String {
    match e.raw_os_error() {
        Some(5) | Some(231) => format!("listen EADDRINUSE: address already in use {path}"),
        _ => format!("listen {path}: {e}"),
    }
}

struct PipeWire {
    file: Option<File>,
}

impl Wire for PipeWire {
    fn write(&mut self, text: &str) {
        if let Some(f) = self.file.as_mut() {
            if f.write_all(text.as_bytes()).is_err() {
                self.file = None;
            }
        }
    }
    fn end(&mut self) {
        // Closing the server handle leaves written data readable by the peer until it is read.
        self.file = None;
    }
    fn writable(&self) -> bool {
        self.file.is_some()
    }
}

fn serve(handle: SendHandle, proto: Arc<Protocol>) {
    // SAFETY: the handle is a connected pipe instance this thread now owns.
    let file = unsafe { File::from_raw_handle(handle.0 .0) };
    let Ok(mut reader) = file.try_clone() else { return };
    let mut wire = PipeWire { file: Some(file) };
    let mut conn = Connection::new();
    let mut buf = vec![0u8; BUFFER as usize];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => conn.on_data(&proto, &buf[..n], &mut wire),
        }
        if conn.is_terminated() {
            break;
        }
    }
    conn.on_end(&proto, &mut wire);
}

impl PipeServer {
    /// Starts listening on [`pipe_path`]. Fails, leaving the pipe untouched, when another process
    /// already owns that path.
    pub fn start(svc: Arc<Services>) -> Result<PipeServer, String> {
        Self::start_at(svc, &pipe_path())
    }

    pub fn start_at(svc: Arc<Services>, path: &str) -> Result<PipeServer, String> {
        let first = create_instance(path, true).map_err(|e| listen_error(path, e))?;
        let proto = Protocol::new(svc);
        let stop = Arc::new(AtomicBool::new(false));
        let pending = Arc::new(AtomicUsize::new(0));
        spawn_listener(first, path, &proto, &stop, &pending);
        for _ in 1..BACKLOG {
            let instance = create_instance(path, false).map_err(|e| listen_error(path, e))?;
            spawn_listener(instance, path, &proto, &stop, &pending);
        }
        eprintln!("[pipe] Listening on {path}");
        Ok(PipeServer { path: path.to_string(), proto, stop, pending, stopped: false })
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    /// Bumped after every command that wrote; the UI polls it to refresh.
    pub fn change_counter(&self) -> Arc<AtomicU64> {
        self.proto.change_counter()
    }

    pub fn protocol(&self) -> &Arc<Protocol> {
        &self.proto
    }

    /// Stops accepting. Connections already open finish on their own threads.
    pub fn stop(&mut self) {
        if std::mem::replace(&mut self.stopped, true) {
            return;
        }
        self.stop.store(true, Ordering::SeqCst);
        // Wake each waiting instance with a throwaway client until none is left.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while self.pending.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < deadline {
            let _ = std::fs::OpenOptions::new().read(true).write(true).open(&self.path);
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
}

impl Drop for PipeServer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Pending instances kept waiting for a client at all times (libuv's default backlog), so a burst
/// of clients never finds the pipe busy while the next instance is being made.
const BACKLOG: usize = 4;

/// One waiting instance. When a client connects it makes the replacement first, then serves the
/// connection on this thread.
fn listener(instance: SendHandle, path: String, proto: Arc<Protocol>, stop: Arc<AtomicBool>, pending: Arc<AtomicUsize>) {
    // SAFETY: `instance` is a pipe handle this thread owns.
    let connected = unsafe { ConnectNamedPipe(instance.0, None) };
    // `ERROR_PIPE_CONNECTED`: the client got in before this call. `ERROR_NO_DATA`: it got in and
    // already closed; what it wrote is still waiting to be read.
    let ok = connected.is_ok()
        || matches!(&connected, Err(e) if e.code() == ERROR_PIPE_CONNECTED.to_hresult() || e.code() == ERROR_NO_DATA.to_hresult());
    if !stop.load(Ordering::SeqCst) {
        match create_instance(&path, false) {
            Ok(next) => spawn_listener(next, &path, &proto, &stop, &pending),
            Err(e) => eprintln!("[pipe] Server error: {e}"),
        }
    }
    pending.fetch_sub(1, Ordering::SeqCst);
    if ok && !stop.load(Ordering::SeqCst) {
        serve(instance, proto);
    } else {
        // SAFETY: closing the handle this thread owns.
        unsafe {
            let _ = CloseHandle(instance.0);
        }
    }
}

fn spawn_listener(instance: SendHandle, path: &str, proto: &Arc<Protocol>, stop: &Arc<AtomicBool>, pending: &Arc<AtomicUsize>) {
    // Counted before the stop flag is read, so `stop` cannot return while this one is being added.
    pending.fetch_add(1, Ordering::SeqCst);
    if stop.load(Ordering::SeqCst) {
        pending.fetch_sub(1, Ordering::SeqCst);
        // SAFETY: closing the handle this call owns.
        unsafe {
            let _ = CloseHandle(instance.0);
        }
        return;
    }
    let (path, proto, stop, counter) = (path.to_string(), proto.clone(), stop.clone(), pending.clone());
    let spawned = std::thread::Builder::new().name("pipe-conn".into()).spawn(move || listener(instance, path, proto, stop, counter));
    if spawned.is_err() {
        pending.fetch_sub(1, Ordering::SeqCst);
    }
}
