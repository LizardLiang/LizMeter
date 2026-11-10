//! Signal processing for in-process playback: a streaming sample-rate converter and a WSOLA time
//! stretch (tempo change that keeps the pitch, like ffmpeg's `atempo`). Both work on interleaved
//! stereo `f32` and keep their state between calls, so a decoder can feed them packet by packet.

use std::f64::consts::PI;

/// Range the stretch handles well, the same range ffmpeg's `atempo` accepts in one filter.
pub const MIN_TEMPO: f64 = 0.5;
pub const MAX_TEMPO: f64 = 2.0;

type Frame = [f32; 2];

fn frames_of(interleaved: &[f32]) -> impl Iterator<Item = Frame> + '_ {
    interleaved.chunks_exact(2).map(|c| [c[0], c[1]])
}

fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-9 {
        1.0
    } else {
        (PI * x).sin() / (PI * x)
    }
}

/// Windowed-sinc resampler (Blackman window). Down-sampling lowers the cut-off so nothing above the
/// new Nyquist frequency folds back.
pub struct Resampler {
    /// Input frames per output frame.
    step: f64,
    cutoff: f64,
    half: usize,
    /// Input frames; the first `half - 1` are zeros so the first outputs have history.
    buf: Vec<Frame>,
    /// Position of the next output in `buf`.
    pos: f64,
}

impl Resampler {
    /// `None` when the rates already match.
    pub fn new(from: u32, to: u32) -> Option<Resampler> {
        if from == to || from == 0 || to == 0 {
            return None;
        }
        let cutoff = (to as f64 / from as f64).min(1.0);
        let half = (16.0 / cutoff).ceil() as usize;
        Some(Resampler { step: from as f64 / to as f64, cutoff, half, buf: vec![[0.0; 2]; half], pos: half as f64 })
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        self.buf.extend(frames_of(input));
        self.run(out);
    }

    /// Flushes the last frames (the signal continues as silence).
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        self.buf.extend(std::iter::repeat_n([0.0; 2], self.half));
        self.run(out);
    }

    fn run(&mut self, out: &mut Vec<f32>) {
        let half = self.half as isize;
        let mut weights = vec![0f64; 2 * self.half];
        while self.pos.floor() as isize + half < self.buf.len() as isize {
            let base = self.pos.floor() as isize;
            let frac = self.pos - base as f64;
            let mut sum = 0.0;
            for (k, w) in weights.iter_mut().enumerate() {
                // Distance of tap `base - half + 1 + k` from the output position.
                let d = (k as isize - half + 1) as f64 - frac;
                let win = 0.42 + 0.5 * (PI * d / self.half as f64).cos() + 0.08 * (2.0 * PI * d / self.half as f64).cos();
                *w = self.cutoff * sinc(self.cutoff * d) * win;
                sum += *w;
            }
            let (mut l, mut r) = (0.0f64, 0.0f64);
            let first = (base - half + 1) as usize;
            for (k, w) in weights.iter().enumerate() {
                let f = self.buf[first + k];
                l += f[0] as f64 * w;
                r += f[1] as f64 * w;
            }
            out.push((l / sum) as f32);
            out.push((r / sum) as f32);
            self.pos += self.step;
        }
        let drop = (self.pos.floor() as isize - half + 1).max(0) as usize;
        if drop > 0 {
            self.buf.drain(..drop);
            self.pos -= drop as f64;
        }
    }
}

/// Waveform-similarity overlap-add. Frames of `n` samples are cut from the input every
/// `hop * tempo` samples (searching a few samples either way for the best join) and laid down every
/// `hop` samples, so the output is `1 / tempo` as long and keeps its pitch.
pub struct Stretch {
    tempo: f64,
    n: usize,
    hop: usize,
    tol: usize,
    win: Vec<f32>,
    inp: Vec<Frame>,
    mono: Vec<f32>,
    /// Absolute input index of `inp[0]`.
    base: usize,
    total_in: usize,
    ola: Vec<Frame>,
    /// Absolute input position the next frame is cut near.
    nominal: f64,
    /// Absolute start of the previous cut.
    prev: Option<usize>,
    emitted: usize,
}

impl Stretch {
    /// `rate` is the sample rate the audio has; the frame is about 40 ms.
    pub fn new(rate: u32, tempo: f64) -> Stretch {
        let n = ((rate as f64 * 0.040) as usize / 2).max(64) * 2;
        let win = (0..n).map(|i| (0.5 - 0.5 * (2.0 * PI * i as f64 / n as f64).cos()) as f32).collect();
        Stretch {
            tempo,
            n,
            hop: n / 2,
            tol: (rate as usize / 200).max(16),
            win,
            inp: Vec::new(),
            mono: Vec::new(),
            base: 0,
            total_in: 0,
            ola: vec![[0.0; 2]; n],
            nominal: 0.0,
            prev: None,
            emitted: 0,
        }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        for f in frames_of(input) {
            self.mono.push((f[0] + f[1]) * 0.5);
            self.inp.push(f);
        }
        self.total_in += input.len() / 2;
        self.run(out, false);
    }

    /// Flushes the tail and trims the total to `input / tempo` frames.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        let pad = self.n + self.tol * 2 + self.hop;
        self.inp.extend(std::iter::repeat_n([0.0; 2], pad));
        self.mono.extend(std::iter::repeat_n(0.0, pad));
        self.run(out, true);
        let want = (self.total_in as f64 / self.tempo).round() as usize;
        if self.emitted > want {
            let excess = (self.emitted - want).min(out.len() / 2);
            out.truncate(out.len() - excess * 2);
            self.emitted = want;
        }
    }

    fn run(&mut self, out: &mut Vec<f32>, flushing: bool) {
        let ref_len = self.hop;
        loop {
            let nominal = self.nominal.round() as usize;
            if flushing && nominal >= self.total_in {
                break;
            }
            let have = self.base + self.inp.len();
            // The cut can start `tol` later than the nominal position and spans `n` frames.
            if nominal + self.tol + self.n > have {
                break;
            }
            let start = match self.prev {
                None => nominal,
                Some(prev) => {
                    let ref_start = prev + self.hop - self.base;
                    let lo = nominal.saturating_sub(self.tol).max(self.base);
                    let hi = nominal + self.tol;
                    let target = &self.mono[ref_start..ref_start + ref_len];
                    let mut best = (f64::NEG_INFINITY, nominal);
                    for c in lo..=hi {
                        let seg = &self.mono[c - self.base..c - self.base + ref_len];
                        let (mut dot, mut energy) = (0.0f64, 1e-6f64);
                        for (a, b) in seg.iter().zip(target) {
                            dot += (*a as f64) * (*b as f64);
                            energy += (*a as f64) * (*a as f64);
                        }
                        let score = dot / energy.sqrt();
                        if score > best.0 {
                            best = (score, c);
                        }
                    }
                    best.1
                }
            };
            let first = self.prev.is_none();
            let from = start - self.base;
            for i in 0..self.n {
                // The very first frame has no predecessor to fade out of: start at full level.
                let w = if first && i < self.hop { 1.0 } else { self.win[i] };
                let f = self.inp[from + i];
                self.ola[i][0] += f[0] * w;
                self.ola[i][1] += f[1] * w;
            }
            for f in &self.ola[..self.hop] {
                out.push(f[0]);
                out.push(f[1]);
            }
            self.emitted += self.hop;
            self.ola.drain(..self.hop);
            self.ola.extend(std::iter::repeat_n([0.0; 2], self.hop));
            self.prev = Some(start);
            self.nominal += self.hop as f64 * self.tempo;
            // Keep what the next search and reference still read.
            let keep_from = (start + self.hop).min((self.nominal.round() as usize).saturating_sub(self.tol));
            if keep_from > self.base {
                let drop = keep_from - self.base;
                self.inp.drain(..drop);
                self.mono.drain(..drop);
                self.base = keep_from;
            }
        }
    }
}

/// Resample to the output rate, then change the tempo. Either stage is absent when not needed.
pub struct Chain {
    resampler: Option<Resampler>,
    stretch: Option<Stretch>,
    scratch: Vec<f32>,
}

impl Chain {
    pub fn new(from_rate: u32, to_rate: u32, tempo: f64) -> Chain {
        Chain {
            resampler: Resampler::new(from_rate, to_rate),
            stretch: ((tempo - 1.0).abs() > 1e-9).then(|| Stretch::new(to_rate, tempo)),
            scratch: Vec::new(),
        }
    }

    /// Appends the converted frames to `out`.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        match (&mut self.resampler, &mut self.stretch) {
            (None, None) => out.extend_from_slice(input),
            (Some(r), None) => r.process(input, out),
            (None, Some(s)) => s.process(input, out),
            (Some(r), Some(s)) => {
                self.scratch.clear();
                r.process(input, &mut self.scratch);
                s.process(&self.scratch, out);
            }
        }
    }

    pub fn finish(&mut self, out: &mut Vec<f32>) {
        match (&mut self.resampler, &mut self.stretch) {
            (None, None) => {}
            (Some(r), None) => r.finish(out),
            (None, Some(s)) => s.finish(out),
            (Some(r), Some(s)) => {
                self.scratch.clear();
                r.finish(&mut self.scratch);
                s.process(&self.scratch, out);
                s.finish(out);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f64, secs: f64) -> Vec<f32> {
        let n = (rate as f64 * secs) as usize;
        (0..n)
            .flat_map(|i| {
                let v = (2.0 * PI * hz * i as f64 / rate as f64).sin() as f32 * 0.5;
                [v, v]
            })
            .collect()
    }

    /// Rising zero crossings per second of the left channel, away from the ends.
    fn frequency(samples: &[f32], rate: u32) -> f64 {
        let left: Vec<f32> = samples.chunks_exact(2).map(|c| c[0]).collect();
        let a = left.len() / 5;
        let b = left.len() - a;
        let crossings = left[a..b].windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f64 / ((b - a) as f64 / rate as f64)
    }

    fn peak(samples: &[f32]) -> f32 {
        samples.iter().fold(0.0, |m, s| m.max(s.abs()))
    }

    fn feed_in_chunks(chain: &mut Chain, input: &[f32], chunk_frames: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for c in input.chunks(chunk_frames * 2) {
            chain.process(c, &mut out);
        }
        chain.finish(&mut out);
        out
    }

    #[test]
    fn resampling_keeps_the_pitch_and_the_level() {
        for (from, to) in [(44_100, 48_000), (48_000, 44_100), (22_050, 48_000)] {
            let input = sine(from, 1000.0, 1.0);
            let mut chain = Chain::new(from, to, 1.0);
            let out = feed_in_chunks(&mut chain, &input, 1024);
            let frames = out.len() / 2;
            assert!((frames as i64 - to as i64).abs() <= 4, "{from}->{to}: {frames} frames");
            let f = frequency(&out, to);
            assert!((f - 1000.0).abs() < 5.0, "{from}->{to}: {f} Hz");
            let p = peak(&out[out.len() / 4..out.len() * 3 / 4]);
            assert!((p - 0.5).abs() < 0.02, "{from}->{to}: peak {p}");
        }
    }

    #[test]
    fn resampling_removes_what_the_lower_rate_cannot_hold() {
        let input = sine(48_000, 20_000.0, 0.5);
        let mut chain = Chain::new(48_000, 22_050, 1.0);
        let out = feed_in_chunks(&mut chain, &input, 1000);
        let mid = &out[out.len() / 4..out.len() * 3 / 4];
        assert!(peak(mid) < 0.02, "alias left at {}", peak(mid));
    }

    #[test]
    fn matching_rates_and_tempo_one_pass_the_samples_through() {
        let input = sine(44_100, 440.0, 0.2);
        let mut chain = Chain::new(44_100, 44_100, 1.0);
        assert_eq!(feed_in_chunks(&mut chain, &input, 700), input);
    }

    #[test]
    fn the_stretch_changes_the_length_and_keeps_the_pitch() {
        for tempo in [0.5, 0.75, 1.25, 1.5, 2.0] {
            let input = sine(48_000, 440.0, 2.0);
            let mut chain = Chain::new(48_000, 48_000, tempo);
            let out = feed_in_chunks(&mut chain, &input, 1024);
            let frames = out.len() / 2;
            let want = (96_000.0 / tempo) as i64;
            assert!((frames as i64 - want).abs() <= 2, "tempo {tempo}: {frames} frames, wanted {want}");
            let f = frequency(&out, 48_000);
            assert!((f - 440.0).abs() < 8.0, "tempo {tempo}: {f} Hz");
            let p = peak(&out[out.len() / 4..out.len() * 3 / 4]);
            assert!(p > 0.45 && p < 0.56, "tempo {tempo}: peak {p}");
        }
    }

    #[test]
    fn the_stretch_gives_the_same_samples_whatever_the_chunk_size() {
        let input = sine(44_100, 330.0, 1.0);
        let run = |chunk| {
            let mut chain = Chain::new(44_100, 48_000, 1.5);
            feed_in_chunks(&mut chain, &input, chunk)
        };
        let (a, b) = (run(1024), run(333));
        assert!((a.len() as i64 - b.len() as i64).abs() <= 4, "{} vs {}", a.len(), b.len());
        let worst = a.iter().zip(&b).fold(0f32, |m, (x, y)| m.max((x - y).abs()));
        assert!(worst < 1e-3, "chunking changed the output by {worst}");
    }

    #[test]
    fn the_stretch_joins_without_clicks() {
        let input = sine(48_000, 220.0, 2.0);
        let mut chain = Chain::new(48_000, 48_000, 1.3);
        let out = feed_in_chunks(&mut chain, &input, 1024);
        let left: Vec<f32> = out.chunks_exact(2).map(|c| c[0]).collect();
        let step = left[2_000..left.len() - 2_000].windows(2).fold(0f32, |m, w| m.max((w[1] - w[0]).abs()));
        // A 220 Hz sine at 0.5 moves at most 0.5 * 2 * pi * 220 / 48000 = 0.0144 per sample.
        assert!(step < 0.03, "largest jump between samples is {step}");
    }

    #[test]
    fn a_short_input_still_produces_its_share() {
        let input = sine(48_000, 440.0, 0.05);
        let mut chain = Chain::new(48_000, 48_000, 2.0);
        let out = feed_in_chunks(&mut chain, &input, 256);
        assert!((out.len() as i64 / 2 - 1200).abs() <= 2, "{}", out.len() / 2);
        let mut empty = Chain::new(48_000, 48_000, 1.5);
        assert!(feed_in_chunks(&mut empty, &[], 256).is_empty());
    }
}
