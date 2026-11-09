//! LizMeter native visual spike: Rust + gpui (DirectX 11) with a patched backdrop-blur renderer.

mod app;
mod chrome;
mod css;
mod gallery;
mod modal;
mod timer;
mod ui;
mod widget;

use app::{Page, Root};
use gpui::*;
use std::{path::PathBuf, time::Duration};
use timer::Status;

mod embedded {
    use gpui::{AssetSource, Result, SharedString};
    use std::borrow::Cow;

    macro_rules! icons {
        ($($name:literal),* $(,)?) => {
            const ICONS: &[(&str, &[u8])] = &[$((concat!("icons/", $name, ".svg"), include_bytes!(concat!("../assets/icons/", $name, ".svg")) as &[u8])),*];
        };
    }
    icons!(
        "clock", "list", "check-square", "issues", "zap", "activity", "music", "chart", "tag", "gear", "link", "spinner",
        "win-min", "win-max", "win-close", "bold", "italic", "strike", "bullets", "numbered", "code", "expand", "play",
        "pause", "stop", "caret", "spark"
    );

    /// U+1F345 as Chromium draws it from the system Segoe UI Emoji (COLRv1 paint tree), baked at 4x.
    const TOMATO: &[u8] = include_bytes!("../assets/icons/tomato.png");

    pub struct Assets;
    impl AssetSource for Assets {
        fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
            if path == "icons/tomato.png" {
                return Ok(Some(Cow::Borrowed(TOMATO)));
            }
            Ok(ICONS.iter().find(|(p, _)| *p == path).map(|(_, b)| Cow::Borrowed(*b)))
        }
        fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
            Ok(ICONS.iter().map(|(p, _)| SharedString::from(*p)).collect())
        }
    }
}

struct Args {
    screenshot: Option<PathBuf>,
    page: String,
    hover_nav: Option<usize>,
    running: bool,
    composite: Option<u32>,
}

fn parse_args() -> Args {
    let mut a = Args { screenshot: None, page: "timer".into(), hover_nav: None, running: false, composite: None };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--screenshot" => a.screenshot = it.next().map(PathBuf::from),
            "--page" => a.page = it.next().unwrap_or_default(),
            "--hover-nav" => a.hover_nav = it.next().and_then(|v| v.parse().ok()),
            "--running" => a.running = true,
            "--anim-time" => {
                if let Some(ms) = it.next().and_then(|v| v.parse::<u32>().ok()) {
                    ui::ANIM_TIME.store(ms, std::sync::atomic::Ordering::Relaxed);
                }
            }
            "--composite" => a.composite = it.next().and_then(|v| u32::from_str_radix(v.trim_start_matches('#'), 16).ok()),
            _ => {}
        }
    }
    a
}

fn save_png(path: &PathBuf, mut f: gpui::capture::CapturedFrame, composite: Option<u32>) {
    if let Some(bg) = composite {
        let (br, bgc, bb) = (((bg >> 16) & 255) as f32, ((bg >> 8) & 255) as f32, (bg & 255) as f32);
        for px in f.rgba.chunks_exact_mut(4) {
            let a = px[3] as f32 / 255.0;
            px[0] = (px[0] as f32 * a + br * (1.0 - a)).round() as u8;
            px[1] = (px[1] as f32 * a + bgc * (1.0 - a)).round() as u8;
            px[2] = (px[2] as f32 * a + bb * (1.0 - a)).round() as u8;
            px[3] = 255;
        }
    }
    let file = std::fs::File::create(path).expect("create png");
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), f.width, f.height);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().unwrap().write_image_data(&f.rgba).unwrap();
}

#[cfg(target_os = "windows")]
fn make_topmost(window: &Window) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SetWindowPos};
    if let Ok(handle) = HasWindowHandle::window_handle(window) {
        if let RawWindowHandle::Win32(h) = handle.as_raw() {
            let hwnd = HWND(h.hwnd.get() as *mut _);
            unsafe {
                let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
            }
        }
    }
}

fn main() {
    let args = parse_args();
    let shot = args.screenshot.is_some();
    if shot {
        ui::FREEZE.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Application::new().with_assets(embedded::Assets).run(move |cx: &mut App| {
        cx.text_system()
            .add_fonts(vec![std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf") as &[u8])])
            .expect("font");
        let is_widget = args.page == "widget";
        let handle: AnyWindowHandle = if is_widget {
            let display = cx.primary_display().map(|d| d.bounds()).unwrap_or(Bounds::new(point(px(0.0), px(0.0)), size(px(1920.0), px(1080.0))));
            let bounds = Bounds::new(point(display.right() - px(280.0), display.top() + px(20.0)), size(px(260.0), px(80.0)));
            let w = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: None,
                        kind: WindowKind::PopUp,
                        focus: false,
                        is_resizable: false,
                        window_background: WindowBackgroundAppearance::Transparent,
                        ..Default::default()
                    },
                    |window, cx| {
                        #[cfg(target_os = "windows")]
                        make_topmost(window);
                        let _ = window;
                        cx.new(|cx| widget::Widget::new(cx, Status::Running))
                    },
                )
                .unwrap();
            w.into()
        } else {
            let (page, pomodoro, modal) = match args.page.as_str() {
                "gallery" => (Page::Gallery, true, false),
                name if name.starts_with("anim:") => {
                    let i = gallery::ANIM_NAMES.iter().position(|n| *n == &name[5..]).expect("unknown animation");
                    (Page::Anim(i), true, false)
                }
                "modal" => (Page::Timer, false, true),
                "stopwatch" => (Page::Timer, false, false),
                _ => (Page::Timer, true, false),
            };
            let bounds = Bounds::centered(None, size(px(1200.0), px(800.0)), cx);
            let hover = args.hover_nav;
            let running = args.running;
            let w = cx
                .open_window(
                    WindowOptions {
                        window_bounds: Some(WindowBounds::Windowed(bounds)),
                        titlebar: Some(TitlebarOptions { title: Some("LizMeter".into()), appears_transparent: true, traffic_light_position: None }),
                        focus: !shot,
                        window_min_size: Some(size(px(600.0), px(400.0))),
                        ..Default::default()
                    },
                    |_, cx| {
                        cx.new(|cx| {
                            let mut r = Root::new(page, pomodoro, modal, hover);
                            if running || modal {
                                r.description = Some("Review native spike");
                            }
                            if running {
                                r.start(cx);
                            }
                            r
                        })
                    },
                )
                .unwrap();
            w.into()
        };
        cx.activate(!shot);

        if let Some(path) = args.screenshot.clone() {
            let composite = args.composite;
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_millis(1500)).await;
                gpui::capture::request();
                let _ = handle.update(cx, |_, window, _| window.refresh());
                cx.background_executor().timer(Duration::from_millis(600)).await;
                match gpui::capture::take() {
                    Some(frame) => save_png(&path, frame, composite),
                    None => eprintln!("no frame captured"),
                }
                cx.update(|cx| cx.quit()).ok();
            })
            .detach();
        }
    });
}
