//! In-process decoding of cached tracks. A cached file is AAC in MP4 (what yt-dlp saves), which
//! symphonia decodes inside the app, so play, seek and speed changes start within a few
//! milliseconds instead of waiting for an ffmpeg process to start (about a second on this machine).
//!
//! The file is recognised by its content, not its name: the Opus fallback is saved under the same
//! `.m4a` name. Anything this module cannot decode (Opus, a codec symphonia lacks, a speed outside
//! the stretch range) is left to the ffmpeg path by [`open`] returning `None`.

use crate::dsp::{Chain, MAX_TEMPO, MIN_TEMPO};
use crate::output::Feed;
use std::fs::File;
use std::path::Path;
use std::sync::Arc;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

/// A file opened and positioned at the start second, ready to decode.
pub struct Opened {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track_id: u32,
    rate: u32,
    /// Source frames between the packet the seek landed on and the requested second.
    skip: usize,
}

/// Opens `path` for in-process playback from `start_secs`, or `None` when ffmpeg has to do it.
pub fn open(path: &Path, start_secs: f64, tempo: f64) -> Option<Opened> {
    if !(MIN_TEMPO..=MAX_TEMPO).contains(&tempo) {
        return None;
    }
    let file = File::open(path).ok()?;
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&Hint::new(), stream, &FormatOptions { enable_gapless: true, ..Default::default() }, &MetadataOptions::default())
        .ok()?;
    let mut format = probed.format;
    let track = format.tracks().iter().find(|t| t.codec_params.codec != CODEC_TYPE_NULL)?;
    let (track_id, params) = (track.id, track.codec_params.clone());
    let rate = params.sample_rate?;
    let mut decoder = symphonia::default::get_codecs().make(&params, &DecoderOptions::default()).ok()?;
    let mut skip = 0;
    if start_secs > 0.0 {
        let to = SeekTo::Time { time: Time::from(start_secs), track_id: Some(track_id) };
        let seeked = format.seek(SeekMode::Accurate, to).ok()?;
        decoder.reset();
        let behind = seeked.required_ts.saturating_sub(seeked.actual_ts);
        skip = match params.time_base {
            Some(tb) => {
                let t = tb.calc_time(behind);
                ((t.seconds as f64 + t.frac) * rate as f64).round() as usize
            }
            None => behind as usize,
        };
    }
    Some(Opened { format, decoder, track_id, rate, skip })
}

/// Decodes on its own thread into `feed` until the file ends or the feed closes.
pub fn spawn(opened: Opened, feed: Arc<Feed>, tempo: f64) {
    let _ = std::thread::Builder::new().name("lizmeter-decode".into()).spawn(move || run(opened, feed, tempo));
}

fn run(mut o: Opened, feed: Arc<Feed>, tempo: f64) {
    let mut chain = Chain::new(o.rate, feed.rate, tempo);
    let mut buf: Option<SampleBuffer<f32>> = None;
    let mut stereo: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    let mut skip = o.skip;
    loop {
        if feed.is_closed() {
            return;
        }
        let packet = match o.format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => {
                feed.fail(format!("The audio file could not be read: {e}"));
                return;
            }
        };
        if packet.track_id() != o.track_id {
            continue;
        }
        let decoded = match o.decoder.decode(&packet) {
            Ok(d) => d,
            // A damaged packet is skipped, as ffmpeg does.
            Err(Error::DecodeError(_)) => continue,
            Err(e) => {
                feed.fail(format!("The audio could not be decoded: {e}"));
                return;
            }
        };
        let channels = decoded.spec().channels.count();
        if channels == 0 || decoded.frames() == 0 {
            continue;
        }
        let b = buf.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec()));
        if b.capacity() < decoded.frames() * channels {
            *b = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        }
        b.copy_interleaved_ref(decoded);
        stereo.clear();
        for f in b.samples().chunks_exact(channels) {
            stereo.push(f[0]);
            stereo.push(if channels > 1 { f[1] } else { f[0] });
        }
        let mut frames = &stereo[..];
        if skip > 0 {
            let drop = skip.min(frames.len() / 2);
            skip -= drop;
            frames = &frames[drop * 2..];
            if frames.is_empty() {
                continue;
            }
        }
        out.clear();
        chain.process(frames, &mut out);
        if !out.is_empty() && !feed.push(&out) {
            return;
        }
    }
    out.clear();
    chain.finish(&mut out);
    if !out.is_empty() && !feed.push(&out) {
        return;
    }
    if !feed.is_closed() {
        feed.finish();
    }
}
