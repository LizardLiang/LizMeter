//! Widget avatar storage: the copy, the stored path, the removal and the widget height switch.

mod common;

use lizmeter_services::avatars::AvatarSlot;

#[test]
fn an_avatar_is_copied_stored_and_removed() {
    let rig = common::rig();
    let svc = &rig.svc;
    assert!(!svc.has_any_avatar());
    assert_eq!(svc.avatar_files().idle, None);

    let src = rig.root.join("pixel.png");
    std::fs::write(&src, b"png bytes").unwrap();
    let dest = svc.set_avatar(AvatarSlot::Thinking, &src).unwrap();

    assert_eq!(dest, rig.user_data.join("avatars").join("avatar-thinking.png"));
    assert_eq!(std::fs::read(&dest).unwrap(), b"png bytes");
    assert!(svc.has_any_avatar());
    let files = svc.avatar_files();
    assert_eq!(files.thinking.as_deref(), Some(dest.to_string_lossy().as_ref()));
    assert_eq!(files.idle, None);
    assert_eq!(files.tool_use, None);

    svc.remove_avatar(AvatarSlot::Thinking).unwrap();
    assert!(!dest.exists());
    assert!(!svc.has_any_avatar());
}

#[test]
fn a_missing_file_is_not_reported_but_its_path_still_counts_for_the_height() {
    let rig = common::rig();
    let svc = &rig.svc;
    svc.set_setting_value(AvatarSlot::Idle.key(), Some("C:/gone/avatar-idle.gif")).unwrap();
    assert_eq!(svc.avatar_files().idle, None);
    assert!(svc.has_any_avatar(), "Electron sizes the widget from the stored path alone");
}
