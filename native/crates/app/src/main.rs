//! LizMeter native visual spike: Rust + gpui (DirectX 11) with a patched backdrop-blur renderer.

mod app;
mod chrome;

mod gallery;
mod modal;
mod timer;
pub use lizmeter_ui::{css, ui};
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

    pub struct Assets;
    impl AssetSource for Assets {
        fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
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
    focus: bool,
    html: Option<String>,
    steps: Vec<Step>,
}

fn parse_args() -> Args {
    let mut a = Args { screenshot: None, page: "timer".into(), hover_nav: None, running: false, composite: None, focus: false, html: None, steps: Vec::new() };
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
            "--focus" => a.focus = true,
            "--html" => a.html = it.next(),
            "--type" => a.steps.extend(it.next().map(Step::Type)),
            "--keys" => a.steps.extend(it.next().map(Step::Keys)),
            "--ime" => a.steps.extend(it.next().map(Step::Ime)),
            "--expand" => a.steps.push(Step::Expand),
            "--dump" => a.steps.push(Step::Dump),
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
    let mut args = parse_args();
    let shot = args.screenshot.is_some();
    if shot {
        ui::FREEZE.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let mut args_steps = std::mem::take(&mut args.steps);
    let mut args_html = args.html.take();
    let args_focus = args.focus;
    Application::new().with_assets(embedded::Assets).run(move |cx: &mut App| {
        cx.text_system()
            .add_fonts(vec![std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf") as &[u8])])
            .expect("font");
        lizmeter_ui::text_input::bind_keys(cx);
        lizmeter_ui::rich_input::bind_keys(cx);
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
                "textsample" => (Page::TextSample, true, false),
                "emojisample" => (Page::EmojiSample, true, false),
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
                    |window, cx| {
                        cx.new(|cx| {
                            let mut r = Root::new(page, pomodoro, modal, hover, window, cx);
                            if running || modal {
                                r.rich.update(cx, |ri, cx| ri.set_html("<p>Review native spike</p>", cx));
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
        {
            let steps = std::mem::take(&mut args_steps);
            let html = args_html.take();
            let focus = args_focus;
            if focus || html.is_some() || !steps.is_empty() {
                cx.spawn(async move |cx| {
                    cx.background_executor().timer(Duration::from_millis(700)).await;
                    if let Some(root) = handle.downcast::<Root>() {
                        let ent = root.entity(cx).ok();
                        if let Some(ent) = ent {
                            let _ = handle.update(cx, |_, window, cx| {
                                if let Some(h) = &html {
                                    ent.read(cx).rich.clone().update(cx, |r, cx| r.set_html(h, cx));
                                }
                                let f = ent.read(cx).focused_rich().read(cx).focus_handle().clone();
                                window.focus(&f);
                                run_steps(&ent, &steps, window, cx);
                            });
                        }
                    }
                })
                .detach();
            }
        }

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

/// Scripted input for captures and tests (`--type`, `--keys`, `--ime`, `--expand`), applied in order
/// through the same entry points the platform uses (keystroke dispatch, platform input handler).
enum Step {
    Type(String),
    Keys(String),
    Ime(String),
    Expand,
    Dump,
}

fn run_steps(root: &Entity<Root>, steps: &[Step], window: &mut Window, cx: &mut App) {
    use gpui::EntityInputHandler;
    for s in steps {
        let target = root.read(cx).focused_rich().clone();
        match s {
            Step::Type(text) => {
                for ch in text.chars() {
                    target.update(cx, |r, cx| r.replace_text_in_range(None, &ch.to_string(), window, cx));
                }
            }
            Step::Keys(list) => {
                for k in list.split_whitespace() {
                    if let Ok(ks) = Keystroke::parse(k) {
                        window.dispatch_keystroke(ks, cx);
                    }
                }
            }
            Step::Ime(pre) => {
                let n = pre.encode_utf16().count();
                target.update(cx, |r, cx| r.replace_and_mark_text_in_range(None, pre, Some(n..n), window, cx));
                let b = target.update(cx, |r, cx| {
                    let range = r.marked_text_range(window, cx).unwrap_or(0..0);
                    r.bounds_for_range(range.start..range.start, Bounds::default(), window, cx)
                });
                eprintln!("ime composition caret bounds (relative to the surface): {b:?}");
            }
            Step::Expand => root.update(cx, |r, cx| r.open_rich_modal(window, cx)),
            Step::Dump => eprintln!("html: {}", target.read(cx).html()),
        }
    }
}
