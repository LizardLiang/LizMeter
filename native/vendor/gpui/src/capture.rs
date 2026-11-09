//! Frame readback for headless screenshot tests (LizMeter native spike).
//!
//! `request()` asks the renderer to copy the next presented frame into CPU memory;
//! `take()` returns it as tightly packed RGBA8. No desktop automation involved.

use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

/// A captured frame: width, height and RGBA8 pixels (row-major, un-premultiplied).
pub struct CapturedFrame {
    /// Width in device pixels.
    pub width: u32,
    /// Height in device pixels.
    pub height: u32,
    /// RGBA8 pixel data.
    pub rgba: Vec<u8>,
}

static REQUESTED: AtomicBool = AtomicBool::new(false);
static FRAME: Mutex<Option<CapturedFrame>> = Mutex::new(None);

/// Ask the renderer to capture the next frame it draws.
pub fn request() {
    REQUESTED.store(true, Ordering::SeqCst);
}

/// Take the captured frame, if one has been produced since `request()`.
pub fn take() -> Option<CapturedFrame> {
    FRAME.lock().unwrap().take()
}

#[allow(dead_code)]
pub(crate) fn is_requested() -> bool {
    REQUESTED.swap(false, Ordering::SeqCst)
}

#[allow(dead_code)]
pub(crate) fn store(frame: CapturedFrame) {
    *FRAME.lock().unwrap() = Some(frame);
}
