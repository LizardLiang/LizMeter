//! Port of `attachment-url.test.ts` (request resolution) plus the blob store rules.

use lizmeter_db::attachment_url::attachment_url;
use lizmeter_services::attachments::{resolve_attachment_path, store_buffer};
use std::path::{Path, PathBuf};

const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn base() -> PathBuf {
    std::env::temp_dir().join("lizmeter-attachments-base")
}

fn resolve(url: &str) -> Option<PathBuf> {
    resolve_attachment_path(url, &base())
}

#[test]
fn rejects_a_wrong_host_and_attachments_as_a_path_segment() {
    assert_eq!(resolve(&format!("app-media://evil/{SHA}.png")), None);
    assert_eq!(resolve(&format!("app-media:///attachments/{SHA}.png")), None);
}

#[test]
fn rejects_every_traversal_spelling() {
    assert_eq!(resolve("app-media://attachments/../../secret.png"), None);
    assert_eq!(resolve("app-media://attachments/%2e%2e%2f%2e%2e%2fsecret.png"), None);
    assert_eq!(resolve(&format!("app-media://attachments/sub%2f{SHA}.png")), None);
    assert_eq!(resolve(&format!("app-media://attachments/..%5C..%5C{SHA}.png")), None);
    assert_eq!(resolve("app-media://attachments/C:/Windows/win.ini"), None);
    assert_eq!(resolve("app-media://attachments/C%3A%5CWindows%5Cwin.ini"), None);
}

#[test]
fn rejects_names_outside_the_sha_and_extension_allowlist() {
    assert_eq!(resolve(&format!("app-media://attachments/{}.png", "z".repeat(64))), None);
    assert_eq!(resolve(&format!("app-media://attachments/{}.png", "A".repeat(64))), None);
    assert_eq!(resolve(&format!("app-media://attachments/{}.png", "a".repeat(63))), None);
    assert_eq!(resolve(&format!("app-media://attachments/{SHA}")), None);
    assert_eq!(resolve(&format!("app-media://attachments/{SHA}.")), None);
    assert_eq!(resolve(&format!("app-media://attachments/{SHA}.toolongext")), None);
}

#[test]
fn rejects_foreign_schemes_and_garbage() {
    assert_eq!(resolve(&format!("file://attachments/{SHA}.png")), None);
    assert_eq!(resolve(&format!("https://attachments/{SHA}.png")), None);
    assert_eq!(resolve("not a url at all"), None);
    assert_eq!(resolve(""), None);
    assert_eq!(resolve(&format!("app-media://attachments/%E0%A4%A{SHA}.png")), None);
}

#[test]
fn accepts_a_valid_url_and_ignores_query_and_fragment() {
    let resolved = resolve(&attachment_url(SHA, "png")).unwrap();
    assert!(resolved.starts_with(base()));
    assert_eq!(resolved.file_name().unwrap().to_string_lossy(), format!("{SHA}.png"));
    let with_query = resolve(&format!("app-media://attachments/{SHA}.webp?v=2#top")).unwrap();
    assert_eq!(with_query.file_name().unwrap().to_string_lossy(), format!("{SHA}.webp"));
    let upper_scheme = resolve(&format!("APP-MEDIA://Attachments/{SHA}.png"));
    assert!(upper_scheme.is_some(), "scheme and host compare without regard to case, as URL parsing lowercases them");
}

#[test]
fn store_buffer_names_the_file_by_its_hash_and_stores_identical_bytes_once() {
    let dir = tempfile::tempdir().unwrap();
    let a = store_buffer(dir.path(), b"abc", "Photo.PNG").unwrap();
    assert_eq!(a.sha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    assert_eq!((a.ext.as_str(), a.size_bytes), ("png", 3));
    let b = store_buffer(dir.path(), b"abc", "other.png").unwrap();
    assert_eq!(a, b);
    let files: Vec<_> = std::fs::read_dir(dir.path().join("attachments")).unwrap().collect();
    assert_eq!(files.len(), 1);
    assert!(Path::new(&dir.path().join("attachments").join(format!("{}.png", a.sha256))).exists());
}

#[test]
fn store_buffer_refuses_empty_oversized_and_svg() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(store_buffer(dir.path(), b"", "a.png").unwrap_err().to_string(), "Attachment is empty");
    let big = vec![0u8; 25 * 1024 * 1024 + 1];
    assert_eq!(
        store_buffer(dir.path(), &big, "a.bin").unwrap_err().to_string(),
        "Attachment is larger than the 25 MB limit"
    );
    assert_eq!(store_buffer(dir.path(), b"<svg/>", "a.SVG").unwrap_err().to_string(), "SVG attachments are not supported");
    assert_eq!(store_buffer(dir.path(), b"x", "noext").unwrap().ext, "bin");
}
