//! Todo attachment blobs on disk and the `app-media://` scheme: a port of
//! `electron/main/attachment-store.ts` and the request half of `attachment-url.ts`.

use crate::error::{fail, Result};
use lizmeter_core::ATTACHMENT_MAX_BYTES;
use lizmeter_db::attachment_url::{attachment_file_name, ext_from_file_name, ATTACHMENT_HOST, ATTACHMENT_SCHEME};
use lizmeter_db::data_location::ATTACHMENTS_DIR_NAME;
use lizmeter_db::{is_sync_enabled, Database};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// Extensions refused outright. An SVG served from a privileged scheme is a needless surface.
const BLOCKED_EXTENSIONS: [&str; 2] = ["svg", "svgz"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredBlob {
    /// Lower-case hex sha256 of the bytes. Also the on-disk basename.
    pub sha256: String,
    pub ext: String,
    pub size_bytes: u64,
}

/// Display metadata only; nothing branches on it.
pub fn mime_type_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// The `attachments` folder under `data_dir`, created on first use.
pub fn attachments_dir(data_dir: &Path) -> Result<PathBuf> {
    let dir = data_dir.join(ATTACHMENTS_DIR_NAME);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Writes bytes to `<sha256>.<ext>` and returns their identity. Identical bytes cost one file.
pub fn store_buffer(data_dir: &Path, data: &[u8], original_name: &str) -> Result<StoredBlob> {
    if data.is_empty() {
        return fail("Attachment is empty");
    }
    if data.len() as u64 > ATTACHMENT_MAX_BYTES {
        let limit_mb = (ATTACHMENT_MAX_BYTES as f64 / (1024.0 * 1024.0)).round() as u64;
        return fail(format!("Attachment is larger than the {limit_mb} MB limit"));
    }
    let ext = ext_from_file_name(original_name);
    if BLOCKED_EXTENSIONS.contains(&ext.as_str()) {
        return fail(format!("{} attachments are not supported", ext.to_uppercase()));
    }
    let sha256: String = Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect();
    let target = attachments_dir(data_dir)?.join(attachment_file_name(&sha256, &ext));
    if !target.exists() {
        fs::write(&target, data)?;
    }
    Ok(StoredBlob { sha256, ext, size_bytes: data.len() as u64 })
}

/// Absolute path of a stored blob. Does not check that the file exists.
pub fn attachment_path_for(data_dir: &Path, sha256: &str, ext: &str) -> Result<PathBuf> {
    Ok(attachments_dir(data_dir)?.join(attachment_file_name(sha256, ext)))
}

fn safe_read_dir(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default()
}

/// Deletes the blob for `sha256` only when no attachment row references it. A no-op while sync is
/// on: the count covers this device's rows only, and a peer may hold a live reference to the same
/// content-addressed blob that has not merged yet.
pub fn delete_blob_if_unreferenced(db: &Database, data_dir: &Path, sha256: &str, ext: Option<&str>) -> Result<()> {
    if db.count_attachments_by_sha(sha256)? > 0 {
        return Ok(());
    }
    if is_sync_enabled(db.conn())? {
        return Ok(());
    }
    let dir = attachments_dir(data_dir)?;
    let names: Vec<String> = match ext {
        None => safe_read_dir(&dir).into_iter().filter(|n| n.starts_with(&format!("{sha256}."))).collect(),
        Some(ext) => vec![attachment_file_name(sha256, ext)],
    };
    for name in names {
        // A file held open can refuse deletion; the orphan sweep collects it on the next start.
        let _ = fs::remove_file(dir.join(name));
    }
    Ok(())
}

/// `delete_blob_if_unreferenced` over a de-duplicated batch.
pub fn collect_attachment_blobs(db: &Database, data_dir: &Path, shas: &[String]) -> Result<()> {
    let mut seen = std::collections::BTreeSet::new();
    for sha in shas {
        if seen.insert(sha.clone()) {
            delete_blob_if_unreferenced(db, data_dir, sha, None)?;
        }
    }
    Ok(())
}

/// Deletes any file in the attachments folder that no row references. The only cleanup after a
/// crash between the file write and the row insert. Never fails the caller.
pub fn sweep_orphan_blobs(db: &Database, data_dir: &Path) {
    let Ok(shas) = db.list_all_attachment_shas() else { return };
    let referenced: std::collections::BTreeSet<String> = shas.into_iter().collect();
    let Ok(dir) = attachments_dir(data_dir) else { return };
    for name in safe_read_dir(&dir) {
        let sha = name.split('.').next().unwrap_or(&name);
        if referenced.contains(sha) {
            continue;
        }
        let _ = fs::remove_file(dir.join(&name));
    }
}

fn is_blob_name(name: &str) -> bool {
    let Some((sha, ext)) = name.split_once('.') else { return false };
    let lower_hex = |s: &str| s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    sha.len() == 64
        && lower_hex(sha)
        && (1..=8).contains(&ext.len())
        && ext.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Resolves an `app-media://` request URL to a file inside `base_dir`, or `None`.
///
/// `None` unless: the scheme is `app-media:`, the host is exactly `attachments`, the decoded path
/// is one basename matching `<64 hex>.<ext>`, and the result still sits under `base_dir`. The
/// allowlist runs after decoding, so `%2e%2e%2f` and `%2f` cannot smuggle a separator in.
pub fn resolve_attachment_path(request_url: &str, base_dir: &Path) -> Option<PathBuf> {
    let scheme_len = ATTACHMENT_SCHEME.len();
    let head = request_url.get(..scheme_len)?;
    if !head.eq_ignore_ascii_case(ATTACHMENT_SCHEME) {
        return None;
    }
    let rest = request_url[scheme_len..].strip_prefix("//")?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest);
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if !host.eq_ignore_ascii_case(ATTACHMENT_HOST) {
        return None;
    }
    let decoded = percent_decode(path)?;
    let name = decoded.trim_start_matches('/');
    if !is_blob_name(name) {
        return None;
    }
    let resolved = base_dir.join(name);
    resolved.starts_with(base_dir).then_some(resolved)
}
