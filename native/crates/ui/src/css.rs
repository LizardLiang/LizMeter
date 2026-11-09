//! A small CSS-compatible 2D rasterizer for element backgrounds.
//!
//! gpui paints quads with at most two-stop linear gradients and has no radial gradients,
//! inset box-shadows, `clip-path` or `mask-composite`. The app's CSS leans on all of them, so
//! each decorated surface is rasterized here (premultiplied sRGB compositing, like a browser)
//! and uploaded as one image sprite. Results are cached per (spec, size, scale).

use gpui::RenderImage;
use image::{Frame, RgbaImage};
use std::{
    cell::RefCell,
    collections::HashMap,
    hash::{Hash, Hasher},
    sync::Arc,
};

/// Straight (non-premultiplied) sRGB color, components 0..=1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct C(pub f32, pub f32, pub f32, pub f32);

pub const TRANSPARENT: C = C(0.0, 0.0, 0.0, 0.0);

/// `rgba(r, g, b, a)` with 0..=255 channels like CSS.
pub const fn rgba(r: u8, g: u8, b: u8, a: f32) -> C {
    C(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, a)
}

pub const fn hex(v: u32) -> C {
    C(
        ((v >> 16) & 0xff) as f32 / 255.0,
        ((v >> 8) & 0xff) as f32 / 255.0,
        (v & 0xff) as f32 / 255.0,
        1.0,
    )
}

impl C {
    pub fn to_gpui(self) -> gpui::Rgba {
        gpui::Rgba { r: self.0, g: self.1, b: self.2, a: self.3 }
    }
    fn premul(self) -> [f32; 4] {
        [self.0 * self.3, self.1 * self.3, self.2 * self.3, self.3]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Fill {
    Solid(C),
    /// `linear-gradient(<deg>deg, stops...)`; stop positions are 0..=1 along the gradient line.
    Linear { deg: f32, stops: Vec<(f32, C)> },
    /// `radial-gradient(ellipse at cx cy, stops...)` with the default `farthest-corner` size.
    Radial { cx: f32, cy: f32, stops: Vec<(f32, C)> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// Rounded rect, radii as top-left, top-right, bottom-right, bottom-left (CSS px).
    RRect([f32; 4]),
    /// Convex polygon in CSS px, relative to the box origin (`clip-path: polygon()`).
    Polygon(Vec<(f32, f32)>),
}

/// `inset <dx> <dy> 0 0 <color>` (no blur, no spread).
#[derive(Clone, Debug, PartialEq)]
pub struct Inset {
    pub dx: f32,
    pub dy: f32,
    pub color: C,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Spec {
    pub shape: Shape,
    /// Background layers, topmost first (CSS order).
    pub fills: Vec<Fill>,
    pub insets: Vec<Inset>,
    /// Border widths (top, right, bottom, left) and color.
    pub border: Option<([f32; 4], C)>,
    /// `mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude`
    /// with `padding: <width>`: a gradient visible only in the padding ring.
    pub ring: Option<(f32, Fill)>,
}

impl Spec {
    pub fn rrect(radius: f32) -> Self {
        Self { shape: Shape::RRect([radius; 4]), fills: vec![], insets: vec![], border: None, ring: None }
    }
    pub fn rrect4(r: [f32; 4]) -> Self {
        Self { shape: Shape::RRect(r), fills: vec![], insets: vec![], border: None, ring: None }
    }
    pub fn polygon(points: Vec<(f32, f32)>) -> Self {
        Self { shape: Shape::Polygon(points), fills: vec![], insets: vec![], border: None, ring: None }
    }
    pub fn fill(mut self, f: Fill) -> Self {
        self.fills.push(f);
        self
    }
    pub fn solid(self, c: C) -> Self {
        self.fill(Fill::Solid(c))
    }
    pub fn inset(mut self, dx: f32, dy: f32, color: C) -> Self {
        self.insets.push(Inset { dx, dy, color });
        self
    }
    pub fn border(mut self, w: f32, c: C) -> Self {
        self.border = Some(([w; 4], c));
        self
    }
    pub fn border_sides(mut self, top: f32, right: f32, bottom: f32, left: f32, c: C) -> Self {
        self.border = Some(([top, right, bottom, left], c));
        self
    }
    pub fn ring(mut self, w: f32, f: Fill) -> Self {
        self.ring = Some((w, f));
        self
    }
}

pub fn linear(deg: f32, stops: &[(f32, C)]) -> Fill {
    Fill::Linear { deg, stops: stops.to_vec() }
}

pub fn radial(cx: f32, cy: f32, stops: &[(f32, C)]) -> Fill {
    Fill::Radial { cx, cy, stops: stops.to_vec() }
}

fn lerp4(a: [f32; 4], b: [f32; 4], t: f32) -> [f32; 4] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
        a[3] + (b[3] - a[3]) * t,
    ]
}

/// Sample a color-stop list at `t` (premultiplied interpolation, as in CSS).
fn sample_stops(stops: &[(f32, C)], t: f32) -> [f32; 4] {
    let first = stops.first().unwrap();
    if t <= first.0 {
        return first.1.premul();
    }
    for w in stops.windows(2) {
        let (p0, c0) = w[0];
        let (p1, c1) = w[1];
        if t <= p1 {
            let span = (p1 - p0).max(1e-6);
            return lerp4(c0.premul(), c1.premul(), ((t - p0) / span).clamp(0.0, 1.0));
        }
    }
    stops.last().unwrap().1.premul()
}

fn over(top: [f32; 4], bottom: [f32; 4]) -> [f32; 4] {
    let k = 1.0 - top[3];
    [
        top[0] + bottom[0] * k,
        top[1] + bottom[1] * k,
        top[2] + bottom[2] * k,
        top[3] + bottom[3] * k,
    ]
}

fn scale4(c: [f32; 4], k: f32) -> [f32; 4] {
    [c[0] * k, c[1] * k, c[2] * k, c[3] * k]
}

fn rrect_sdf(px: f32, py: f32, w: f32, h: f32, r: [f32; 4]) -> f32 {
    let (hx, hy) = (w * 0.5, h * 0.5);
    let (cx, cy) = (px - hx, py - hy);
    let radius = if cx < 0.0 {
        if cy < 0.0 { r[0] } else { r[3] }
    } else if cy < 0.0 {
        r[1]
    } else {
        r[2]
    };
    let qx = cx.abs() - hx + radius;
    let qy = cy.abs() - hy + radius;
    let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
    outside + qx.max(qy).min(0.0) - radius
}

fn polygon_sdf(px: f32, py: f32, pts: &[(f32, f32)]) -> f32 {
    // Convex polygon: max of signed distances to the edge lines (outward normals).
    let n = pts.len();
    let (mut mx, mut my) = (0.0, 0.0);
    for p in pts {
        mx += p.0;
        my += p.1;
    }
    mx /= n as f32;
    my /= n as f32;
    let mut d = f32::MIN;
    for i in 0..n {
        let a = pts[i];
        let b = pts[(i + 1) % n];
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let len = (ex * ex + ey * ey).sqrt().max(1e-6);
        let mut nx = ey / len;
        let mut ny = -ex / len;
        if (mx - a.0) * nx + (my - a.1) * ny > 0.0 {
            nx = -nx;
            ny = -ny;
        }
        d = d.max((px - a.0) * nx + (py - a.1) * ny);
    }
    d
}

fn shape_sdf(shape: &Shape, x: f32, y: f32, w: f32, h: f32) -> f32 {
    match shape {
        Shape::RRect(r) => rrect_sdf(x, y, w, h, *r),
        Shape::Polygon(p) => polygon_sdf(x, y, p),
    }
}

/// Signed distance to the padding box (the border box shrunk by the border widths).
fn pad_sdf(spec: &Spec, x: f32, y: f32, w: f32, h: f32) -> f32 {
    let Some((b, _)) = spec.border else {
        return shape_sdf(&spec.shape, x, y, w, h);
    };
    match &spec.shape {
        Shape::RRect(r) => {
            let (t, rt, bt, l) = (b[0], b[1], b[2], b[3]);
            let ri = [
                (r[0] - t.max(l)).max(0.0),
                (r[1] - t.max(rt)).max(0.0),
                (r[2] - bt.max(rt)).max(0.0),
                (r[3] - bt.max(l)).max(0.0),
            ];
            rrect_sdf(x - l, y - t, w - l - rt, h - t - bt, ri)
        }
        Shape::Polygon(p) => polygon_sdf(x, y, p) + b.iter().cloned().fold(0.0, f32::max),
    }
}

fn fill_at(fill: &Fill, x: f32, y: f32, w: f32, h: f32) -> [f32; 4] {
    match fill {
        Fill::Solid(c) => c.premul(),
        Fill::Linear { deg, stops } => {
            let a = deg.to_radians();
            let (dx, dy) = (a.sin(), -a.cos());
            let len = (w * a.sin()).abs() + (h * a.cos()).abs();
            let t = ((x - w * 0.5) * dx + (y - h * 0.5) * dy) / len.max(1e-6) + 0.5;
            sample_stops(stops, t)
        }
        Fill::Radial { cx, cy, stops } => {
            let (ox, oy) = (cx * w, cy * h);
            let fx = ox.max(w - ox);
            let fy = oy.max(h - oy);
            let (rx, ry) = (fx * std::f32::consts::SQRT_2, fy * std::f32::consts::SQRT_2);
            let t = (((x - ox) / rx).powi(2) + ((y - oy) / ry).powi(2)).sqrt();
            sample_stops(stops, t)
        }
    }
}

#[inline]
fn coverage(d: f32, scale: f32) -> f32 {
    (0.5 - d * scale).clamp(0.0, 1.0)
}

/// Interleaved gradient noise in -0.5..0.5 (cheap, blue-ish dither).
#[inline]
fn noise(x: u32, y: u32) -> f32 {
    let v = 52.982_918 * ((0.067_110_56 * x as f32 + 0.005_837_15 * y as f32).fract());
    v.fract() - 0.5
}

/// Rasterize `spec` for a box of `w` x `h` CSS px at `scale`. Returns BGRA bytes, straight alpha.
pub fn rasterize(spec: &Spec, w: f32, h: f32, scale: f32) -> (u32, u32, Vec<u8>) {
    let pw = (w * scale).ceil() as u32;
    let ph = (h * scale).ceil() as u32;
    let mut out = vec![0u8; (pw * ph * 4) as usize];
    let inv = 1.0 / scale;
    for j in 0..ph {
        for i in 0..pw {
            let x = (i as f32 + 0.5) * inv;
            let y = (j as f32 + 0.5) * inv;
            let d = shape_sdf(&spec.shape, x, y, w, h);
            let cov = coverage(d, scale);
            if cov <= 0.0 {
                continue;
            }
            let dp = pad_sdf(spec, x, y, w, h);
            let mut px = [0.0f32; 4];
            for fill in spec.fills.iter().rev() {
                px = over(fill_at(fill, x, y, w, h), px);
            }
            for inset in &spec.insets {
                let in_pad = coverage(dp, scale);
                let hole = coverage(pad_sdf(spec, x - inset.dx, y - inset.dy, w, h), scale);
                let a = in_pad * (1.0 - hole);
                if a > 0.0 {
                    px = over(scale4(inset.color.premul(), a), px);
                }
            }
            if let Some((_, color)) = spec.border {
                let a = 1.0 - coverage(dp, scale);
                if a > 0.0 {
                    px = over(scale4(color.premul(), a), px);
                }
            }
            if let Some((rw, fill)) = &spec.ring {
                let content = coverage(rrect_sdf(x - rw, y - rw, w - 2.0 * rw, h - 2.0 * rw, [0.0; 4]), scale);
                let a = 1.0 - content;
                if a > 0.0 {
                    px = over(scale4(fill_at(fill, x, y, w, h), a), px);
                }
            }
            px = scale4(px, cov);
            let n = noise(i, j) / 255.0;
            let a = (px[3] + n).clamp(0.0, 1.0);
            let r = (px[0] + n).clamp(0.0, a);
            let g = (px[1] + n).clamp(0.0, a);
            let b = (px[2] + n).clamp(0.0, a);
            let (sr, sg, sb) = if a > 1e-6 { (r / a, g / a, b / a) } else { (0.0, 0.0, 0.0) };
            let o = ((j * pw + i) * 4) as usize;
            out[o] = (sb * 255.0 + 0.5) as u8;
            out[o + 1] = (sg * 255.0 + 0.5) as u8;
            out[o + 2] = (sr * 255.0 + 0.5) as u8;
            out[o + 3] = (a * 255.0 + 0.5) as u8;
        }
    }
    (pw, ph, out)
}

/// Rasters kept before the cache starts over; one window holds a few dozen distinct sprites.
const CACHE_LIMIT: usize = 400;

thread_local! {
    static CACHE: RefCell<HashMap<u64, Arc<RenderImage>>> = RefCell::new(HashMap::new());
}

/// Cached rasterization to a gpui image (bytes are BGRA, as gpui's atlas expects).
pub fn image_for(spec: &Spec, w: f32, h: f32, scale: f32) -> Arc<RenderImage> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    format!("{spec:?}").hash(&mut hasher);
    w.to_bits().hash(&mut hasher);
    h.to_bits().hash(&mut hasher);
    scale.to_bits().hash(&mut hasher);
    let key = hasher.finish();
    if let Some(hit) = CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return hit;
    }
    let (pw, ph, bytes) = rasterize(spec, w, h, scale);
    let img = RgbaImage::from_raw(pw, ph, bytes).expect("raster size");
    let image = Arc::new(RenderImage::new(vec![Frame::new(img)]));
    CACHE.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() >= CACHE_LIMIT {
            c.clear();
        }
        c.insert(key, image.clone());
    });
    image
}
