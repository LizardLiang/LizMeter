//! LizMeter native visual spike: Rust + gpui (DirectX 11) with a patched backdrop-blur renderer.

mod app;
mod cards;
mod claude_flow;
mod claude_ui;
mod chrome;

mod gallery;
mod modal;
mod controls;
mod engine;
mod flow;
mod fmt;
mod locale;
mod pages;
mod rich_view;
mod select;
mod tag_picker;
mod timer;
pub use lizmeter_ui::{css, ui};
mod widget;

use app::{Page, Root};
use gpui::*;
use lizmeter_ui::md_editor::MdVariant;
use lizmeter_services::Services;
use std::{path::PathBuf, sync::Arc, time::Duration};
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
        "pause", "stop", "caret", "spark", "chevron-down", "chevron-right", "chevron-left", "file"
    );

    pub struct Assets;
    impl AssetSource for Assets {
        fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
            Ok(ICONS.iter().find(|(p, _)| *p == path).map(|(_, b)| Cow::Borrowed(*b)).or_else(|| crate::pages::todos_icons::load(path)))
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
    md: Option<PathBuf>,
    size: (f32, f32),
    steps: Vec<Step>,
    data_dir: Option<PathBuf>,
    edit_time: bool,
    /// Capture hooks run once after the window opens: `bounce`, `claude-link`, `claude-open`.
    ops: Vec<String>,
}

fn parse_args() -> Args {
    let mut a = Args { screenshot: None, page: "timer".into(), hover_nav: None, running: false, composite: None, focus: false, html: None, md: None, size: (1200.0, 800.0), steps: Vec::new(), data_dir: None, edit_time: false, ops: Vec::new() };
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
            "--scroll" => {
                if let Some(px) = it.next().and_then(|v| v.parse::<u32>().ok()) {
                    ui::CAPTURE_SCROLL.store(px, std::sync::atomic::Ordering::Relaxed);
                }
            }
            "--edit-time" => a.edit_time = true,
            "--do" => a.ops.extend(it.next().map(|v| v.split(',').map(str::to_string).collect::<Vec<_>>()).unwrap_or_default()),
            "--data-dir" => a.data_dir = it.next().map(PathBuf::from),
            "--html" => a.html = it.next(),
            "--md" => a.md = it.next().map(PathBuf::from),
            "--size" => {
                if let Some((w, h)) = it.next().as_deref().and_then(|v| v.split_once('x')) {
                    if let (Ok(w), Ok(h)) = (w.parse(), h.parse()) {
                        a.size = (w, h);
                    }
                }
            }
            "--caret" => a.steps.extend(it.next().and_then(|v| v.parse().ok()).map(Step::Caret)),
            "--select" => {
                let v = it.next().unwrap_or_default();
                if let Some((s, e)) = v.split_once("..") {
                    if let (Ok(s), Ok(e)) = (s.parse(), e.parse()) {
                        a.steps.push(Step::Select(s, e));
                    }
                }
            }
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
    let services = if args.page == "widget" { None } else { Some(open_services(args.data_dir.take())) };
    if shot {
        ui::FREEZE.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    let mut args_steps = std::mem::take(&mut args.steps);
    let mut args_html = args.html.take();
    let args_focus = args.focus;
    let for_shutdown = services.clone();
    let services_bg = services.clone();
    Application::new().with_assets(embedded::Assets).run(move |cx: &mut App| {
        cx.text_system()
            .add_fonts(vec![std::borrow::Cow::Borrowed(include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf") as &[u8])])
            .expect("font");
        lizmeter_ui::text_input::bind_keys(cx);
        lizmeter_ui::rich_input::bind_keys(cx);
        lizmeter_ui::md_editor::bind_keys(cx);
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
            let page_name = args.page.clone();
            let args_md = args.md.clone();
            let (page, pomodoro, modal) = match args.page.as_str() {
                "gallery" => (Page::Gallery, true, false),
                "textsample" => (Page::TextSample, true, false),
                "emojisample" => (Page::EmojiSample, true, false),
                name if name.starts_with("anim:") => {
                    let i = gallery::ANIM_NAMES.iter().position(|n| *n == &name[5..]).expect("unknown animation");
                    (Page::Anim(i), true, false)
                }
                "notes" => (Page::Notes(MdVariant::Framed), true, false),
                "notes-bare" => (Page::Notes(MdVariant::Bare), true, false),
                "notes-modal" => (Page::Notes(MdVariant::Framed), true, false),
                "modal" => (Page::Timer, false, true),
                "stopwatch" => (Page::Timer, false, false),
                "history" => (Page::History, true, false),
                "tags" => (Page::Tags, true, false),
                "settings" => (Page::Settings, true, false),
                "claude" => (Page::Claude, true, false),
                "todos" => (Page::Todos, true, false),
                "issues" => (Page::Issues, true, false),
                name if name.starts_with("activity") => (Page::Activity, true, false),
                name if name.starts_with("stats") => (Page::Stats, true, false),
                _ => (Page::Timer, true, false),
            };
            let bounds = Bounds::centered(None, size(px(args.size.0), px(args.size.1)), cx);
            let hover = args.hover_nav;
            let running = args.running;
            let edit_time = args.edit_time;
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
                            let svc = services.clone().expect("services are open for every window page");
                            let mut r = Root::new(svc, page, pomodoro, hover, window, cx);
                            if let Some(path) = &args_md {
                                let text = std::fs::read_to_string(path).expect("read --md file");
                                let base = path.parent().map(|p| p.to_path_buf());
                                r.notes_image_base = base.clone();
                                r.notes.update(cx, |n, cx| {
                                    n.set_text(&text, cx);
                                    n.set_selection(0, 0, cx);
                                    if let Some(b) = base {
                                        n.set_image_base(b);
                                    }
                                });
                            }
                            if let Some(spec) = page_name.strip_prefix("stats") {
                                r.stats.update(cx, |s, _| s.preset(spec.trim_start_matches(':')));
                            }
                            if let Some(spec) = page_name.strip_prefix("activity") {
                                r.activity.update(cx, |a, _| a.preset(spec.trim_start_matches(':')));
                                r.show_activity(cx);
                            }
                            if page_name == "notes-modal" {
                                r.open_notes_modal(window, cx);
                            }
                            if running || modal {
                                r.set_title_html(!pomodoro, "<p>Review native spike</p>", cx);
                            }
                            if running {
                                r.start(cx);
                            }
                            if edit_time {
                                r.start_time_edit(window, cx);
                            }
                            if modal {
                                r.open_prompt(app::PromptPurpose::StopwatchStart, window, cx);
                            }
                            r
                        })
                    },
                )
                .unwrap();
            w.into()
        };
        if let Some(svc) = &services_bg {
            if let Err(e) = svc.start_background() {
                eprintln!("[sync] could not start: {e}");
            }
        }
        cx.activate(!shot);
        if !args.ops.is_empty() {
            let ops = args.ops.clone();
            cx.spawn(async move |cx| {
                cx.background_executor().timer(Duration::from_millis(600)).await;
                if let Some(ent) = handle.downcast::<Root>().and_then(|r| r.entity(cx).ok()) {
                    for op in &ops {
                        let _ = handle.update(cx, |_, window, cx| {
                            ent.update(cx, |r, cx| r.capture_op(op, window, cx));
                        });
                        cx.background_executor().timer(Duration::from_millis(250)).await;
                    }
                }
            })
            .detach();
        }
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
                                    let sw = !ent.read(cx).pomodoro;
                                    ent.update(cx, |r, cx| r.set_title_html(sw, h, cx));
                                }
                                let notes_page = matches!(ent.read(cx).page, Page::Notes(_));
                                let f = if notes_page {
                                    ent.read(cx).focused_notes().read(cx).focus_handle().clone()
                                } else {
                                    ent.read(cx).focused_rich().read(cx).focus_handle().clone()
                                };
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
    if let Some(svc) = for_shutdown {
        svc.shutdown();
    }
}

/// Opens the database behind the single-writer guard. A refusal is shown to the user and ends the process.
fn open_services(data_dir: Option<PathBuf>) -> Arc<Services> {
    use lizmeter_db::data_location::DataLocation;
    use lizmeter_services::claude_tracker::default_projects_root;
    use lizmeter_services::os::WindowsHost;
    let dir = data_dir.unwrap_or_else(DataLocation::default_user_data_dir);
    let _ = std::fs::create_dir_all(&dir);
    match Services::open_guarded(DataLocation::new(dir), Arc::new(WindowsHost::default()), default_projects_root()) {
        Ok((svc, _report)) => svc,
        Err(e) => {
            show_fatal(&e.to_string());
            std::process::exit(1);
        }
    }
}

#[cfg(target_os = "windows")]
fn show_fatal(message: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (text, title) = (wide(message), wide("LizMeter"));
    unsafe {
        MessageBoxW(None, PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(target_os = "windows"))]
fn show_fatal(message: &str) {
    eprintln!("{message}");
}

/// Scripted input for captures and tests (`--type`, `--keys`, `--ime`, `--expand`), applied in order
/// through the same entry points the platform uses (keystroke dispatch, platform input handler).
enum Step {
    Type(String),
    Keys(String),
    Ime(String),
    Expand,
    Dump,
    /// Put the notes caret at the start of this 1-based line.
    Caret(usize),
    Select(usize, usize),
}

fn run_steps(root: &Entity<Root>, steps: &[Step], window: &mut Window, cx: &mut App) {
    use gpui::EntityInputHandler;
    for s in steps {
        if matches!(root.read(cx).page, Page::Notes(_)) {
            let notes = root.read(cx).focused_notes().clone();
            match s {
                Step::Type(text) => {
                    for ch in text.chars() {
                        notes.update(cx, |r, cx| r.replace_text_in_range(None, &ch.to_string(), window, cx));
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
                    notes.update(cx, |r, cx| r.replace_and_mark_text_in_range(None, pre, Some(n..n), window, cx));
                    let b = notes.update(cx, |r, cx| {
                        let range = r.marked_text_range(window, cx).unwrap_or(0..0);
                        r.bounds_for_range(range.start..range.start, Bounds::default(), window, cx)
                    });
                    eprintln!("ime composition caret bounds (relative to the editor): {b:?}");
                }
                Step::Expand => root.update(cx, |r, cx| r.open_notes_modal(window, cx)),
                Step::Dump => eprintln!("text: {:?}", notes.read(cx).text()),
                Step::Caret(line) => notes.update(cx, |n, cx| {
                    let text = n.text();
                    let off = text.split('\n').take(line.saturating_sub(1)).map(|l| l.len() + 1).sum::<usize>().min(text.len());
                    n.set_selection(off, off, cx);
                }),
                Step::Select(a, b) => notes.update(cx, |n, cx| n.set_selection(*a, *b, cx)),
            }
            continue;
        }
        let target = root.read(cx).focused_rich().clone();
        match s {
            Step::Caret(_) | Step::Select(..) => {}
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
