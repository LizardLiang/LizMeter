//! The `app-media://` URL seam: file-name to extension, kind, and URL building.
//! Pure string work, no filesystem access (the request-resolving half arrives with the service layer).

use lizmeter_core::{TodoAttachmentKind, ATTACHMENT_IMAGE_EXTENSIONS};

pub const ATTACHMENT_SCHEME_NAME: &str = "app-media";
pub const ATTACHMENT_SCHEME: &str = "app-media:";
pub const ATTACHMENT_HOST: &str = "attachments";
pub const ATTACHMENT_FALLBACK_EXT: &str = "bin";

/// Node's `path.extname` on a win32 path: the suffix from the last dot of the basename, with a
/// leading-dot file (`.bashrc`) and `..` having none. Includes the dot; `"a."` yields `"."`.
fn extname(file_name: &str) -> &str {
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    if base == ".." {
        return "";
    }
    match base.rfind('.') {
        None | Some(0) => "",
        Some(i) => &base[i..],
    }
}

/// Normalises the extension of a user-supplied file name into the suffix used on disk. Falls back
/// to `bin` for anything the basename allowlist would refuse.
pub fn ext_from_file_name(file_name: &str) -> String {
    let raw = extname(file_name).trim_start_matches('.').to_lowercase();
    let ok = !raw.is_empty() && raw.len() <= 8 && raw.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
    if ok {
        raw
    } else {
        ATTACHMENT_FALLBACK_EXT.to_string()
    }
}

pub fn attachment_kind_for_ext(ext: &str) -> TodoAttachmentKind {
    if ATTACHMENT_IMAGE_EXTENSIONS.contains(&ext) {
        TodoAttachmentKind::Image
    } else {
        TodoAttachmentKind::File
    }
}

/// `app-media://attachments/<sha256>.<ext>`.
pub fn attachment_url(sha256: &str, ext: &str) -> String {
    let ext = ext.trim_start_matches('.').to_lowercase();
    format!("{ATTACHMENT_SCHEME}//{ATTACHMENT_HOST}/{sha256}.{ext}")
}

/// The on-disk basename for a stored blob.
pub fn attachment_file_name(sha256: &str, ext: &str) -> String {
    format!("{sha256}.{}", ext.trim_start_matches('.').to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions() {
        assert_eq!(ext_from_file_name("Shot.PNG"), "png");
        assert_eq!(ext_from_file_name("notes"), "bin");
        assert_eq!(ext_from_file_name(".bashrc"), "bin");
        assert_eq!(ext_from_file_name("a."), "bin");
        assert_eq!(ext_from_file_name("a.b.tar"), "tar");
        assert_eq!(ext_from_file_name("a.verylongext"), "bin");
        assert_eq!(ext_from_file_name("C:\\x.y\\file"), "bin");
        assert_eq!(ext_from_file_name("é.pdf"), "pdf");
        assert_eq!(ext_from_file_name("a.é"), "bin");
    }

    #[test]
    fn kinds_and_urls() {
        assert_eq!(attachment_kind_for_ext("webp"), TodoAttachmentKind::Image);
        assert_eq!(attachment_kind_for_ext("pdf"), TodoAttachmentKind::File);
        assert_eq!(attachment_url("ab", ".PNG"), "app-media://attachments/ab.png");
        assert_eq!(attachment_file_name("ab", "PNG"), "ab.png");
    }
}
