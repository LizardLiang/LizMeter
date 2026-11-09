//! OS integration checks that need no desktop interaction: accelerator parsing, the toast
//! payload, the chime, link filtering and global-shortcut registration on a combination no other
//! app uses. Registration is released before each test ends.

use lizmeter_services::os::hotkeys::{
    parse_accelerator, Binding, HotkeyManager, MEDIA_KEY_BINDINGS,
};
use lizmeter_services::os::shell::is_openable_external_url;
use lizmeter_services::os::sound::{render_chime, wav_bytes, SAMPLE_RATE};
use lizmeter_services::os::toast::toast_xml;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

#[test]
fn media_keys_and_modifier_combinations_parse() {
    for (accel, _) in MEDIA_KEY_BINDINGS {
        assert!(parse_accelerator(accel).is_some(), "{accel}");
    }
    let a = parse_accelerator("MediaPlayPause").unwrap();
    assert_eq!((a.modifiers, a.vk), (0, 0xB3));
    assert_eq!(parse_accelerator("MediaNextTrack").unwrap().vk, 0xB0);
    assert_eq!(parse_accelerator("MediaPreviousTrack").unwrap().vk, 0xB1);
    let combo = parse_accelerator("Ctrl+Alt+Shift+F23").unwrap();
    assert_eq!(combo.modifiers, 0x0002 | 0x0001 | 0x0004);
    assert_eq!(combo.vk, 0x86);
    assert_eq!(parse_accelerator("CommandOrControl+K").unwrap().vk, b'K' as u32);
    assert!(parse_accelerator("").is_none());
    assert!(parse_accelerator("Ctrl+").is_none());
    assert!(parse_accelerator("Ctrl+Shift").is_none(), "modifiers alone are not a shortcut");
    assert!(parse_accelerator("A+B").is_none(), "two keys are not a shortcut");
    assert!(parse_accelerator("Hyper+A").is_none());
}

#[test]
fn a_shortcut_registers_fires_its_action_and_is_released_on_stop() {
    let (tx, rx) = mpsc::channel::<String>();
    let on_key = Arc::new(move |action: &str| {
        let _ = tx.send(action.to_string());
    });
    let probe = || vec![Binding { accelerator: "Ctrl+Alt+Shift+F23".into(), action: "probe".into() }];

    let (mut first, results) = HotkeyManager::start(probe(), on_key.clone()).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].result, Ok(()), "{:?}", results[0]);

    first.simulate_press_for_testing(0);
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "probe");

    // A shortcut that is already taken is reported, not fatal: what happens when another app owns a media key.
    let (mut second, taken) = HotkeyManager::start(probe(), on_key.clone()).unwrap();
    assert!(taken[0].result.is_err(), "the same combination cannot be registered twice");
    second.stop();

    first.stop();
    let (mut third, again) = HotkeyManager::start(probe(), on_key).unwrap();
    assert_eq!(again[0].result, Ok(()), "stop unregistered the shortcut");
    third.stop();
}

#[test]
fn an_unparsable_binding_is_reported_and_the_rest_still_register() {
    let on_key = Arc::new(|_: &str| {});
    let (mut m, results) = HotkeyManager::start(
        vec![
            Binding { accelerator: "Nonsense+".into(), action: "x".into() },
            Binding { accelerator: "Ctrl+Alt+Shift+F22".into(), action: "y".into() },
        ],
        on_key,
    )
    .unwrap();
    assert!(results[0].result.as_ref().unwrap_err().contains("Unrecognised"));
    assert_eq!(results[1].result, Ok(()));
    m.stop();
}

#[test]
fn toast_xml_escapes_user_text() {
    let xml = toast_xml("Focus <done> & \"ready\"", "It's 25:00");
    assert_eq!(
        xml,
        "<toast><visual><binding template=\"ToastGeneric\"><text>Focus &lt;done&gt; &amp; &quot;ready&quot;</text><text>It&apos;s 25:00</text></binding></visual></toast>"
    );
}

#[test]
fn the_chime_is_three_decaying_notes_of_about_1_84_seconds() {
    let samples = render_chime();
    let seconds = samples.len() as f64 / SAMPLE_RATE as f64;
    assert!((seconds - 1.84).abs() < 0.01, "{seconds}");
    let peak = |from: f64, to: f64| {
        samples[(from * SAMPLE_RATE as f64) as usize..(to * SAMPLE_RATE as f64) as usize]
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap() as f64
            / i16::MAX as f64
    };
    let first = peak(0.0, 0.05);
    assert!(first > 0.15 && first < 0.25, "the first note peaks near 0.22 (got {first})");
    assert!(peak(1.5, 1.8) < first, "the tail has decayed");
    assert!(peak(1.8, 1.84) < 0.05);
    let wav = wav_bytes(&samples);
    assert_eq!(&wav[0..4], b"RIFF");
    assert_eq!(&wav[8..16], b"WAVEfmt ");
    assert_eq!(wav.len(), 44 + samples.len() * 2);
    assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
}

#[test]
fn only_web_links_are_opened() {
    assert!(is_openable_external_url("https://example.com"));
    assert!(is_openable_external_url("http://example.com/a?b=c"));
    for bad in ["file:///C:/x.exe", "javascript:alert(1)", "ms-settings:", r"C:\Windows\notepad.exe", "HTTPS://EXAMPLE.COM", " https://x", ""] {
        assert!(!is_openable_external_url(bad), "{bad}");
    }
}

/// Shows a real toast. Run by hand: `cargo test -p lizmeter-services --test os -- --ignored toast`.
#[test]
#[ignore = "shows a desktop toast"]
fn toast_shows_on_this_desktop() {
    lizmeter_services::os::toast::show_toast("LizMeter native", "Phase 5 notification check").unwrap();
}
