//! Audio output: a [`Feed`] of interleaved stereo `f32` frames that the decoder fills and the
//! sound device (or a test sink) drains.
//!
//! The device side is [`OutputHandle`]: one stream for the life of the player, owned by its own
//! thread (`cpal::Stream` is not `Send`). It plays whatever [`Feed`] is current and writes silence
//! when there is none, the feed is paused, or the decoder has not delivered data yet.

use crate::error::{MusicError, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SizedSample};
use lizmeter_core::MusicErrorCode;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// Seconds of audio the decoder may run ahead of the device.
const BUFFER_SECONDS: usize = 2;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the player learns from a feed.
#[derive(Debug, Clone, PartialEq)]
pub enum FeedEvent {
    /// Every decoded frame was played.
    Ended,
    /// Decoding failed before the end.
    Failed(String),
}

/// One track's decoded audio, between the decoder and the device.
pub struct Feed {
    pub rate: u32,
    /// Where in the source (seconds) the first queued frame lies.
    pub start_secs: f64,
    /// Source seconds per played second (`atempo`).
    pub speed: f64,
    buf: Mutex<VecDeque<f32>>,
    space: Condvar,
    paused: AtomicBool,
    closed: AtomicBool,
    eof: AtomicBool,
    ended: AtomicBool,
    failed: Mutex<Option<String>>,
    /// Frames the device has played.
    played: AtomicU64,
    /// Gain as `f32` bits.
    gain: AtomicU32,
    underrun: AtomicBool,
    events: Sender<FeedEvent>,
}

impl Feed {
    pub fn new(rate: u32, start_secs: f64, speed: f64, paused: bool, gain: f32, events: Sender<FeedEvent>) -> Arc<Feed> {
        Arc::new(Feed {
            rate,
            start_secs,
            speed,
            buf: Mutex::new(VecDeque::new()),
            space: Condvar::new(),
            paused: AtomicBool::new(paused),
            closed: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            failed: Mutex::new(None),
            played: AtomicU64::new(0),
            gain: AtomicU32::new(gain.to_bits()),
            underrun: AtomicBool::new(false),
            events,
        })
    }

    /// Queues interleaved stereo samples. Blocks while the buffer is full. `false` means the feed
    /// was closed and the producer should stop.
    pub fn push(&self, samples: &[f32]) -> bool {
        let cap = self.rate as usize * 2 * BUFFER_SECONDS;
        let mut b = lock(&self.buf);
        while b.len() >= cap {
            if self.closed.load(Ordering::SeqCst) {
                return false;
            }
            b = self.space.wait_timeout(b, Duration::from_millis(50)).unwrap_or_else(|e| e.into_inner()).0;
        }
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        b.extend(samples.iter().copied());
        true
    }

    /// The decoder has delivered everything it will. The feed ends once the queue drains.
    pub fn finish(&self) {
        self.eof.store(true, Ordering::SeqCst);
    }

    /// The decoder failed. Frames already queued still play out.
    pub fn fail(&self, message: String) {
        let first = {
            let mut f = lock(&self.failed);
            let first = f.is_none();
            if first {
                *f = Some(message.clone());
            }
            first
        };
        self.eof.store(true, Ordering::SeqCst);
        if first {
            let _ = self.events.send(FeedEvent::Failed(message));
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.space.notify_all();
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, p: bool) {
        self.paused.store(p, Ordering::SeqCst);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn set_gain(&self, g: f32) {
        self.gain.store(g.to_bits(), Ordering::SeqCst);
    }

    pub fn has_ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    pub fn failure(&self) -> Option<String> {
        lock(&self.failed).clone()
    }

    /// True while the device wants frames and the decoder has none ready (and is not done).
    pub fn is_buffering(&self) -> bool {
        self.underrun.load(Ordering::SeqCst) && !self.eof.load(Ordering::SeqCst)
    }

    pub fn queued_frames(&self) -> usize {
        lock(&self.buf).len() / 2
    }

    pub fn played_frames(&self) -> u64 {
        self.played.load(Ordering::SeqCst)
    }

    /// Source position in seconds.
    pub fn position_secs(&self) -> f64 {
        self.start_secs + self.played_frames() as f64 / self.rate as f64 * self.speed
    }

    /// Source seconds decoded so far (played plus queued).
    pub fn decoded_secs(&self) -> f64 {
        self.start_secs + (self.played_frames() as f64 + self.queued_frames() as f64) / self.rate as f64 * self.speed
    }

    /// Fills `out` (interleaved, `channels` per frame) from the queue. Writes silence while paused,
    /// closed, or short of data; never blocks.
    pub fn fill(&self, out: &mut [f32], channels: usize) {
        out.fill(0.0);
        if channels == 0 || self.closed.load(Ordering::SeqCst) || self.paused.load(Ordering::SeqCst) {
            return;
        }
        let gain = f32::from_bits(self.gain.load(Ordering::Relaxed));
        let frames_wanted = out.len() / channels;
        let Ok(mut b) = self.buf.try_lock() else {
            self.underrun.store(true, Ordering::SeqCst);
            return;
        };
        let mut got = 0;
        for frame in 0..frames_wanted {
            if b.len() < 2 {
                break;
            }
            let l = b.pop_front().unwrap_or(0.0) * gain;
            let r = b.pop_front().unwrap_or(0.0) * gain;
            let o = &mut out[frame * channels..(frame + 1) * channels];
            match channels {
                1 => o[0] = (l + r) * 0.5,
                _ => {
                    o[0] = l;
                    o[1] = r;
                }
            }
            got += 1;
        }
        let drained = b.is_empty();
        drop(b);
        if got > 0 {
            self.played.fetch_add(got as u64, Ordering::SeqCst);
            self.space.notify_all();
        }
        self.underrun.store(got < frames_wanted, Ordering::SeqCst);
        if drained && self.eof.load(Ordering::SeqCst) && !self.ended.swap(true, Ordering::SeqCst) && self.failure().is_none() {
            let _ = self.events.send(FeedEvent::Ended);
        }
    }
}

struct OutputShared {
    current: Mutex<Option<Arc<Feed>>>,
    shutdown: AtomicBool,
    /// Test sinks record what they played.
    peak: AtomicU32,
    frames: AtomicU64,
}

impl OutputShared {
    fn fill(&self, out: &mut [f32], channels: usize) {
        let feed = self.current.try_lock().ok().and_then(|g| g.clone());
        match feed {
            Some(f) => {
                f.fill(out, channels);
                let peak = out.iter().fold(0f32, |m, s| m.max(s.abs()));
                if peak > 0.0 {
                    self.peak.fetch_max(peak.to_bits(), Ordering::SeqCst);
                    self.frames.fetch_add((out.len() / channels.max(1)) as u64, Ordering::SeqCst);
                }
            }
            None => out.fill(0.0),
        }
    }
}

/// The sound device, or a silent test sink with the same behaviour.
pub struct OutputHandle {
    shared: Arc<OutputShared>,
    rate: u32,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl OutputHandle {
    pub fn rate(&self) -> u32 {
        self.rate
    }

    /// Plays `feed` from now on (`None`: silence).
    pub fn set_feed(&self, feed: Option<Arc<Feed>>) {
        *lock(&self.shared.current) = feed;
    }

    pub fn current_feed(&self) -> Option<Arc<Feed>> {
        lock(&self.shared.current).clone()
    }

    /// Largest absolute sample a test sink saw (after gain). Zero for the device.
    pub fn peak(&self) -> f32 {
        f32::from_bits(self.shared.peak.load(Ordering::SeqCst))
    }

    /// Frames a test sink saw with sound in them.
    pub fn audible_frames(&self) -> u64 {
        self.shared.frames.load(Ordering::SeqCst)
    }

    /// The default output device, 32-bit float stereo mixed down or up to what the device takes.
    pub fn open_device() -> Result<OutputHandle> {
        let shared = Arc::new(OutputShared { current: Mutex::new(None), shutdown: AtomicBool::new(false), peak: AtomicU32::new(0), frames: AtomicU64::new(0) });
        let (tx, rx) = channel::<std::result::Result<u32, String>>();
        let s2 = shared.clone();
        let thread = std::thread::Builder::new()
            .name("lizmeter-audio".into())
            .spawn(move || {
                let built = build_stream(s2.clone());
                match built {
                    Ok((stream, rate)) => {
                        let _ = tx.send(Ok(rate));
                        // The stream lives on this thread until shutdown.
                        while !s2.shutdown.load(Ordering::SeqCst) {
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        drop(stream);
                    }
                    Err(e) => {
                        let _ = tx.send(Err(e));
                    }
                }
            })
            .map_err(|e| MusicError::new(MusicErrorCode::ExtractionFailed, format!("Audio thread failed to start: {e}")))?;
        match rx.recv() {
            Ok(Ok(rate)) => Ok(OutputHandle { shared, rate, thread: Mutex::new(Some(thread)) }),
            Ok(Err(e)) => Err(MusicError::new(MusicErrorCode::ExtractionFailed, format!("Audio output unavailable: {e}"))),
            Err(_) => Err(MusicError::new(MusicErrorCode::ExtractionFailed, "Audio output unavailable")),
        }
    }

    /// A silent sink that drains the feed at real-time pace, for tests and headless runs.
    pub fn open_null(rate: u32) -> OutputHandle {
        let shared = Arc::new(OutputShared { current: Mutex::new(None), shutdown: AtomicBool::new(false), peak: AtomicU32::new(0), frames: AtomicU64::new(0) });
        let s2 = shared.clone();
        let thread = std::thread::spawn(move || {
            let chunk = (rate / 100) as usize;
            let mut out = vec![0f32; chunk * 2];
            while !s2.shutdown.load(Ordering::SeqCst) {
                s2.fill(&mut out, 2);
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        OutputHandle { shared, rate, thread: Mutex::new(Some(thread)) }
    }
}

impl Drop for OutputHandle {
    fn drop(&mut self) {
        self.shared.shutdown.store(true, Ordering::SeqCst);
        if let Some(t) = lock(&self.thread).take() {
            let _ = t.join();
        }
    }
}

fn build_stream(shared: Arc<OutputShared>) -> std::result::Result<(cpal::Stream, u32), String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no default output device")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let rate = supported.sample_rate().0;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let stream = match format {
        cpal::SampleFormat::F32 => typed::<f32>(&device, &config, shared),
        cpal::SampleFormat::I16 => typed::<i16>(&device, &config, shared),
        cpal::SampleFormat::U16 => typed::<u16>(&device, &config, shared),
        cpal::SampleFormat::I32 => typed::<i32>(&device, &config, shared),
        other => return Err(format!("unsupported sample format {other:?}")),
    }?;
    stream.play().map_err(|e| e.to_string())?;
    Ok((stream, rate))
}

fn typed<T>(device: &cpal::Device, config: &cpal::StreamConfig, shared: Arc<OutputShared>) -> std::result::Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    let mut scratch: Vec<f32> = Vec::new();
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                scratch.resize(data.len(), 0.0);
                shared.fill(&mut scratch, channels);
                for (o, s) in data.iter_mut().zip(scratch.iter()) {
                    *o = T::from_sample(*s);
                }
            },
            |e| eprintln!("[music] audio stream error: {e}"),
            None,
        )
        .map_err(|e| e.to_string())
}
