//! Windows DPAPI (`CryptProtectData` / `CryptUnprotectData`): bytes only the same Windows user can
//! read back. Native token files use it with an app-specific entropy; the Chromium key in
//! `Local State` uses it with none.

use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};
use windows::core::w;

/// Entropy mixed into every native token blob, so a blob is not decryptable by code that only
/// calls `CryptUnprotectData` with no entropy.
const ENTROPY: &[u8] = b"LizMeter native token v1";

fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
}

fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    // SAFETY: DPAPI allocated `pbData` with `cbData` bytes; it is copied, then released.
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
    }
    bytes
}

fn protect_with(plain: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let input = blob(plain);
    let ent = entropy.map(blob);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input`, `ent` and `out` outlive the call.
    unsafe {
        CryptProtectData(&input, w!("LizMeter"), ent.as_ref().map(|e| e as *const _), None, None, 0, &mut out)
            .map_err(|e| format!("CryptProtectData failed: {e}"))?;
    }
    Ok(take(out))
}

fn unprotect_with(sealed: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let input = blob(sealed);
    let ent = entropy.map(blob);
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input`, `ent` and `out` outlive the call.
    unsafe {
        CryptUnprotectData(&input, None, ent.as_ref().map(|e| e as *const _), None, None, 0, &mut out)
            .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
    }
    Ok(take(out))
}

/// Seals `plain` for the current Windows user.
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    protect_with(plain, Some(ENTROPY))
}

/// Opens a blob [`protect`] made.
pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    unprotect_with(sealed, Some(ENTROPY))
}

/// Opens a blob sealed with no entropy (the Chromium `os_crypt` key).
pub fn unprotect_plain(sealed: &[u8]) -> Result<Vec<u8>, String> {
    unprotect_with(sealed, None)
}

/// Seals with no entropy. Tests use it to build a Chromium-shaped `Local State`.
pub fn protect_plain(plain: &[u8]) -> Result<Vec<u8>, String> {
    protect_with(plain, None)
}
