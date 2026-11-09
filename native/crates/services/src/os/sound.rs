//! The timer-complete chime. `useNotificationSound.ts` synthesises three sine notes with Web
//! Audio; this renders the same notes to a WAV in memory and plays it with `PlaySoundW`.

use std::sync::OnceLock;
use windows::core::PCWSTR;
use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};

pub const SAMPLE_RATE: u32 = 44_100;

/// E5, G#5, B5: frequency, start offset, duration (all in ms), peak gain.
const NOTES: [(f64, f64, f64, f64); 3] = [(659.25, 0.0, 1200.0, 0.22), (830.61, 220.0, 1100.0, 0.18), (987.77, 440.0, 1400.0, 0.15)];
const ATTACK_S: f64 = 0.008;
const FLOOR: f64 = 0.0001;

/// Mono 16-bit PCM samples of the chime, about 1.84 s.
pub fn render_chime() -> Vec<i16> {
    let total_s = NOTES.iter().map(|(_, start, dur, _)| (start + dur) / 1000.0).fold(0.0, f64::max);
    let n = (total_s * SAMPLE_RATE as f64).ceil() as usize;
    let mut mix = vec![0.0f64; n];
    for (freq, start_ms, dur_ms, peak) in NOTES {
        let start = start_ms / 1000.0;
        let dur = dur_ms / 1000.0;
        let first = (start * SAMPLE_RATE as f64) as usize;
        let last = (((start + dur) * SAMPLE_RATE as f64) as usize).min(n);
        for (i, slot) in mix.iter_mut().enumerate().take(last).skip(first) {
            let t = i as f64 / SAMPLE_RATE as f64 - start;
            // linearRampToValueAtTime then exponentialRampToValueAtTime, as in the Web Audio graph.
            let gain = if t < ATTACK_S {
                FLOOR + (peak - FLOOR) * t / ATTACK_S
            } else {
                peak * (FLOOR / peak).powf((t - ATTACK_S) / (dur - ATTACK_S))
            };
            *slot += (2.0 * std::f64::consts::PI * freq * t).sin() * gain;
        }
    }
    mix.into_iter().map(|v| (v.clamp(-1.0, 1.0) * i16::MAX as f64) as i16).collect()
}

/// A complete WAV file (RIFF header plus PCM data).
pub fn wav_bytes(samples: &[i16]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(SAMPLE_RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

static CHIME_WAV: OnceLock<Vec<u8>> = OnceLock::new();

/// Plays the chime without blocking. The buffer lives for the whole process because an
/// asynchronous memory sound reads it after this call returns.
pub fn play_chime() -> bool {
    let wav = CHIME_WAV.get_or_init(|| wav_bytes(&render_chime()));
    unsafe { PlaySoundW(PCWSTR(wav.as_ptr() as *const u16), None, SND_MEMORY | SND_ASYNC | SND_NODEFAULT).as_bool() }
}
