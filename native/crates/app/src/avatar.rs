//! Widget avatars: an image file turned into the 72 px hexagonal frame of `Widget.module.scss`.
//!
//! `.avatarFrame` is 72x72 with a hexagon `clip-path` and a 6 % blue fill; `.avatar` is the image at
//! 64x64, `object-fit: contain`, and `image-rendering: pixelated` when the image is at most 128 px.
//! gpui has no clip path and samples with one bilinear filter, so each frame is composed here: the
//! picture is scaled (nearest for pixel art), laid over the fill, and the hexagon becomes the alpha.

use gpui::RenderImage;
use image::{imageops, AnimationDecoder, Delay, Frame, ImageFormat, RgbaImage};
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// The frame's size in CSS px.
pub const FRAME: f32 = 72.0;
/// The picture's box inside the frame.
const PICTURE: f32 = 64.0;
/// The Settings slot's content box: 64 px minus its 1 px border.
pub const PREVIEW: f32 = 62.0;
/// Images up to this size (longest side) are pixel art.
const PIXEL_ART_MAX: u32 = 128;
/// The hexagon of `.avatarFrame`, as fractions of the frame.
const HEX: [(f32, f32); 6] = [(0.5, 0.0), (0.93, 0.25), (0.93, 0.75), (0.5, 1.0), (0.07, 0.75), (0.07, 0.25)];

#[derive(Clone)]
pub struct Avatar {
    /// The composed frames, BGRA, already clipped to the hexagon.
    pub image: Arc<RenderImage>,
    pub pixel_art: bool,
}

/// Decodes `path` (gif, apng, webp, png) into composed frames for a display scale factor.
pub fn load(path: &Path, scale: f32) -> Option<Avatar> {
    load_with(path, scale, compose)
}

/// Like [`load`], for the Settings slot preview.
pub fn load_preview(path: &Path, scale: f32) -> Option<Avatar> {
    load_with(path, scale, preview)
}

fn load_with(path: &Path, scale: f32, lay_out: fn(&RgbaImage, bool, f32) -> Vec<u8>) -> Option<Avatar> {
    let bytes = std::fs::read(path).ok()?;
    let frames = decode(&bytes)?;
    let (w, h) = frames.first()?.0.dimensions();
    let pixel_art = w.max(h) <= PIXEL_ART_MAX;
    let out: Vec<Frame> = frames
        .into_iter()
        .map(|(rgba, delay)| {
            let mut composed = lay_out(&rgba, pixel_art, scale);
            for p in composed.chunks_exact_mut(4) {
                p.swap(0, 2);
            }
            let side = ((composed.len() / 4) as f64).sqrt().round() as u32;
            Frame::from_parts(RgbaImage::from_raw(side, side, composed).expect("square frame"), 0, 0, delay)
        })
        .collect();
    Some(Avatar { image: Arc::new(RenderImage::new(out)), pixel_art })
}

fn decode(bytes: &[u8]) -> Option<Vec<(RgbaImage, Delay)>> {
    let still = Delay::from_saturating_duration(Duration::from_millis(100));
    let collect = |frames: image::Frames<'_>| -> Option<Vec<(RgbaImage, Delay)>> {
        let list: Vec<_> = frames.filter_map(|f| f.ok()).map(|f| (f.delay(), f.into_buffer())).map(|(d, b)| (b, d)).collect();
        (!list.is_empty()).then_some(list)
    };
    match image::guess_format(bytes).ok()? {
        ImageFormat::Gif => collect(image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).ok()?.into_frames()),
        ImageFormat::WebP => {
            let decoder = image::codecs::webp::WebPDecoder::new(Cursor::new(bytes)).ok()?;
            if decoder.has_animation() {
                collect(decoder.into_frames())
            } else {
                Some(vec![(image::DynamicImage::from_decoder(decoder).ok()?.into_rgba8(), still)])
            }
        }
        ImageFormat::Png => {
            let decoder = image::codecs::png::PngDecoder::new(Cursor::new(bytes)).ok()?;
            if decoder.is_apng().ok()? {
                collect(decoder.apng().ok()?.into_frames())
            } else {
                Some(vec![(image::DynamicImage::from_decoder(decoder).ok()?.into_rgba8(), still)])
            }
        }
        format => Some(vec![(image::load_from_memory_with_format(bytes, format).ok()?.into_rgba8(), still)]),
    }
}

/// One frame of the avatar, RGBA with straight alpha, `FRAME * scale` pixels square.
pub fn compose(src: &RgbaImage, pixel_art: bool, scale: f32) -> Vec<u8> {
    place(src, pixel_art, scale, FRAME, PICTURE, true)
}

/// One frame of a Settings slot preview: the picture contained in the 62 px box inside the dashed
/// border, no hexagon and no fill.
pub fn preview(src: &RgbaImage, pixel_art: bool, scale: f32) -> Vec<u8> {
    place(src, pixel_art, scale, PREVIEW, PREVIEW, false)
}

/// Lays `src` out `object-fit: contain` in a `picture` px box centred on a `canvas` px square.
/// `framed` adds the hexagon clip and the 6 % blue fill of `.avatarFrame`.
fn place(src: &RgbaImage, pixel_art: bool, scale: f32, canvas: f32, picture: f32, framed: bool) -> Vec<u8> {
    let side = (canvas * scale).round().max(1.0) as u32;
    let (sw, sh) = src.dimensions();
    let fit = (picture / sw as f32).min(picture / sh as f32);
    let dw = ((sw as f32 * fit * scale).round() as u32).clamp(1, side);
    let dh = ((sh as f32 * fit * scale).round() as u32).clamp(1, side);
    let filter = if pixel_art { imageops::FilterType::Nearest } else { imageops::FilterType::Triangle };
    let scaled = imageops::resize(src, dw, dh, filter);
    let (ox, oy) = (((side - dw) / 2) as i64, ((side - dh) / 2) as i64);

    // rgba(122, 162, 247, 0.06) under the picture.
    let fill = if framed { [122.0f32, 162.0, 247.0, 0.06] } else { [0.0; 4] };
    let mut out = vec![0u8; (side * side * 4) as usize];
    for y in 0..side {
        for x in 0..side {
            let cover = if framed { hex_coverage(x, y, side) } else { 1.0 };
            if cover <= 0.0 {
                continue;
            }
            let (mut r, mut g, mut b, mut a) = (fill[0], fill[1], fill[2], fill[3]);
            let (px, py) = (x as i64 - ox, y as i64 - oy);
            if px >= 0 && py >= 0 && (px as u32) < dw && (py as u32) < dh {
                let s = scaled.get_pixel(px as u32, py as u32).0;
                let sa = s[3] as f32 / 255.0;
                let oa = sa + a * (1.0 - sa);
                if oa > 0.0 {
                    r = (s[0] as f32 * sa + r * a * (1.0 - sa)) / oa;
                    g = (s[1] as f32 * sa + g * a * (1.0 - sa)) / oa;
                    b = (s[2] as f32 * sa + b * a * (1.0 - sa)) / oa;
                }
                a = oa;
            }
            let i = ((y * side + x) * 4) as usize;
            out[i] = r.round().clamp(0.0, 255.0) as u8;
            out[i + 1] = g.round().clamp(0.0, 255.0) as u8;
            out[i + 2] = b.round().clamp(0.0, 255.0) as u8;
            out[i + 3] = (a * cover * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// Share of the pixel `(x, y)` inside the hexagon, from a 4x4 sample grid.
fn hex_coverage(x: u32, y: u32, side: u32) -> f32 {
    let mut inside = 0;
    for sy in 0..4 {
        for sx in 0..4 {
            let fx = (x as f32 + (sx as f32 + 0.5) / 4.0) / side as f32;
            let fy = (y as f32 + (sy as f32 + 0.5) / 4.0) / side as f32;
            if in_hex(fx, fy) {
                inside += 1;
            }
        }
    }
    inside as f32 / 16.0
}

fn in_hex(x: f32, y: f32) -> bool {
    let mut inside = false;
    let mut j = HEX.len() - 1;
    for i in 0..HEX.len() {
        let (xi, yi) = HEX[i];
        let (xj, yj) = HEX[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn px(buf: &[u8], side: u32, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * side + x) * 4) as usize;
        [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]
    }

    #[test]
    fn the_frame_is_clipped_to_the_hexagon() {
        let src = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 0, 255]));
        let out = compose(&src, true, 1.0);
        assert_eq!(out.len(), 72 * 72 * 4);
        assert_eq!(px(&out, 72, 0, 0)[3], 0, "the top-left corner lies outside the hexagon");
        assert_eq!(px(&out, 72, 71, 71)[3], 0);
        assert_eq!(px(&out, 72, 36, 36), [255, 0, 0, 255], "the centre shows the picture");
        assert_eq!(px(&out, 72, 36, 0)[3], 0, "the top vertex is a point, one pixel wide at most");
    }

    #[test]
    fn pixel_art_scales_without_blending() {
        let mut src = RgbaImage::from_pixel(2, 2, Rgba([0, 0, 0, 255]));
        src.put_pixel(1, 0, Rgba([255, 255, 255, 255]));
        src.put_pixel(0, 1, Rgba([255, 255, 255, 255]));
        let out = compose(&src, true, 1.0);
        // 2x2 contained in 64 px: every pixel is one of the two source colours.
        let mut seen = std::collections::HashSet::new();
        for y in 20..52 {
            for x in 20..52 {
                let p = px(&out, 72, x, y);
                seen.insert(p[0]);
            }
        }
        assert_eq!(seen, [0u8, 255].into_iter().collect());
    }

    #[test]
    fn a_smooth_image_blends_at_its_edges() {
        let mut src = RgbaImage::from_pixel(200, 200, Rgba([0, 0, 0, 255]));
        for y in 0..200 {
            for x in 100..200 {
                src.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let out = compose(&src, false, 1.0);
        let mut mid = false;
        for x in 30..42 {
            let v = px(&out, 72, x, 36)[0];
            mid |= v > 20 && v < 235;
        }
        assert!(mid, "a bilinear edge has in-between greys");
    }

    #[test]
    fn a_wide_picture_is_contained_not_cropped() {
        let src = RgbaImage::from_pixel(32, 8, Rgba([0, 255, 0, 255]));
        let out = compose(&src, true, 1.0);
        // 64 x 16 in the middle of the frame: rows 28..44.
        assert_eq!(px(&out, 72, 36, 36), [0, 255, 0, 255]);
        let above = px(&out, 72, 36, 20);
        assert_eq!(above[1], 162, "above the picture only the 6 % blue fill shows");
        assert!(above[3] < 20);
    }

    #[test]
    fn the_scale_factor_sizes_the_frame() {
        let src = RgbaImage::from_pixel(4, 4, Rgba([9, 9, 9, 255]));
        assert_eq!(compose(&src, true, 1.5).len(), 108 * 108 * 4);
    }

    #[test]
    fn a_gif_keeps_every_frame_and_a_missing_file_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.gif");
        {
            let mut enc = image::codecs::gif::GifEncoder::new(std::fs::File::create(&path).unwrap());
            for shade in [10u8, 200] {
                let frame = Frame::from_parts(RgbaImage::from_pixel(8, 8, Rgba([shade, shade, shade, 255])), 0, 0, Delay::from_numer_denom_ms(80, 1));
                enc.encode_frame(frame).unwrap();
            }
        }
        let avatar = load(&path, 1.0).expect("gif loads");
        assert_eq!(avatar.image.frame_count(), 2);
        assert!(avatar.pixel_art);
        assert!(load(&dir.path().join("none.png"), 1.0).is_none());
    }
}
