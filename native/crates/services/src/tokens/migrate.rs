//! One-time carry-over of the Electron build's tokens.
//!
//! Electron `safeStorage` on Windows writes `<userData>/.<provider>-token` as
//! `"v10" + 12-byte nonce + ciphertext + 16-byte GCM tag`, encrypted with a 32-byte key that sits
//! in `<userData>/Local State` at `os_crypt.encrypted_key`: base64 of `"DPAPI"` + a DPAPI blob.
//! Opening it is `DPAPI -> key -> AES-256-GCM`; the token is then sealed again with
//! [`super::dpapi`]. The Electron files stay where they are.

use super::{dpapi, MigrationState, Provider, TokenStore};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use std::path::Path;

const KEY_PREFIX: &[u8] = b"DPAPI";
const TOKEN_PREFIX: &[u8] = b"v10";
const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;

/// The profile's Chromium `os_crypt` key.
pub fn read_os_crypt_key(user_data: &Path) -> Result<Vec<u8>, String> {
    let raw = std::fs::read(user_data.join("Local State")).map_err(|_| "the Electron profile has no Local State file".to_string())?;
    let json: serde_json::Value = serde_json::from_slice(&raw).map_err(|_| "Local State is not valid JSON".to_string())?;
    let b64 = json
        .pointer("/os_crypt/encrypted_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Local State has no os_crypt.encrypted_key".to_string())?;
    let sealed = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "the os_crypt key is not valid base64".to_string())?;
    let blob = sealed.strip_prefix(KEY_PREFIX).ok_or_else(|| "the os_crypt key is not a DPAPI key".to_string())?;
    let key = dpapi::unprotect_plain(blob).map_err(|_| "Windows could not unseal the os_crypt key (another user or machine?)".to_string())?;
    if key.len() != 32 {
        return Err("the os_crypt key has the wrong length".into());
    }
    Ok(key)
}

/// Opens one `safeStorage` value with the profile key.
pub fn decrypt_token(key: &[u8], file: &[u8]) -> Result<String, String> {
    let body = file.strip_prefix(TOKEN_PREFIX).ok_or_else(|| "the token file is not a v10 value".to_string())?;
    if body.len() < NONCE_LEN + TAG_LEN {
        return Err("the token file is too short".into());
    }
    let (nonce, sealed) = body.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "the os_crypt key has the wrong length".to_string())?;
    let plain = cipher.decrypt(Nonce::from_slice(nonce), sealed).map_err(|_| "the token did not decrypt with the profile key".to_string())?;
    String::from_utf8(plain).map_err(|_| "the decrypted token is not text".to_string())
}

fn electron_file(user_data: &Path, p: Provider) -> std::path::PathBuf {
    user_data.join(format!(".{}-token", p.as_str()))
}

/// Migrates every provider that has an Electron token, no native token and no earlier outcome.
/// Returns the providers whose token could not be carried over.
pub fn migrate(store: &TokenStore) -> Vec<Provider> {
    let user_data = store.user_data();
    let states = store.states();
    let mut key: Option<Result<Vec<u8>, String>> = None;
    let mut failed = vec![];
    for p in Provider::ALL {
        if store.has(p) || states.contains_key(&p) {
            continue;
        }
        let Ok(file) = std::fs::read(electron_file(user_data, p)) else { continue };
        let key = key.get_or_insert_with(|| read_os_crypt_key(user_data));
        let outcome = key.clone().and_then(|k| decrypt_token(&k, &file)).and_then(|token| {
            if token.trim().is_empty() {
                return Err("the token is empty".to_string());
            }
            store.save(p, &token)
        });
        match outcome {
            Ok(()) => {
                let _ = store.set_state(p, MigrationState::Migrated);
            }
            Err(reason) => {
                let _ = store.set_state(p, MigrationState::Failed { reason });
                failed.push(p);
            }
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::generic_array::GenericArray;

    /// A profile the way Electron writes it, built with a throwaway key and fake tokens.
    fn fake_profile(dir: &Path, key: &[u8; 32], tokens: &[(Provider, &str)]) {
        let mut sealed = KEY_PREFIX.to_vec();
        sealed.extend(dpapi::protect_plain(key).unwrap());
        let b64 = base64::engine::general_purpose::STANDARD.encode(sealed);
        std::fs::write(dir.join("Local State"), format!(r#"{{"os_crypt":{{"encrypted_key":"{b64}"}}}}"#)).unwrap();
        let cipher = Aes256Gcm::new(GenericArray::from_slice(key));
        for (n, (p, token)) in tokens.iter().enumerate() {
            let nonce = [n as u8 + 1; NONCE_LEN];
            let mut file = TOKEN_PREFIX.to_vec();
            file.extend(nonce);
            file.extend(cipher.encrypt(Nonce::from_slice(&nonce), token.as_bytes()).unwrap());
            std::fs::write(electron_file(dir, *p), file).unwrap();
        }
    }

    #[test]
    fn electron_tokens_are_carried_over_and_the_electron_files_stay() {
        let dir = tempfile::tempdir().unwrap();
        fake_profile(dir.path(), &[7; 32], &[(Provider::Github, "ghp_FAKE_mig_0001"), (Provider::Linear, "lin_api_FAKE_mig_0002")]);
        let store = TokenStore::new(dir.path());
        assert!(migrate(&store).is_empty());
        assert_eq!(store.load(Provider::Github).unwrap().expose(), "ghp_FAKE_mig_0001");
        assert_eq!(store.load(Provider::Linear).unwrap().expose(), "lin_api_FAKE_mig_0002");
        assert!(!store.has(Provider::Jira));
        assert!(electron_file(dir.path(), Provider::Github).exists());
        assert_eq!(store.states()[&Provider::Github], MigrationState::Migrated);
    }

    #[test]
    fn a_wrong_key_flags_the_provider_for_re_entry_and_is_not_retried() {
        let dir = tempfile::tempdir().unwrap();
        fake_profile(dir.path(), &[7; 32], &[(Provider::Jira, "jira_FAKE_mig_0003")]);
        // The Local State now holds a different key than the one that sealed the token.
        let other = tempfile::tempdir().unwrap();
        fake_profile(other.path(), &[9; 32], &[]);
        std::fs::copy(other.path().join("Local State"), dir.path().join("Local State")).unwrap();
        let store = TokenStore::new(dir.path());
        assert_eq!(migrate(&store), vec![Provider::Jira]);
        assert_eq!(store.needs_reentry(), vec![Provider::Jira]);
        assert!(!store.has(Provider::Jira));
        assert!(migrate(&store).is_empty(), "a failed provider is not retried on every launch");
    }

    #[test]
    fn a_corrupt_local_state_flags_every_provider_that_has_a_file() {
        let dir = tempfile::tempdir().unwrap();
        fake_profile(dir.path(), &[7; 32], &[(Provider::Github, "ghp_FAKE_mig_0004"), (Provider::Linear, "lin_api_FAKE_mig_0005")]);
        std::fs::write(dir.path().join("Local State"), b"{ not json").unwrap();
        let store = TokenStore::new(dir.path());
        assert_eq!(migrate(&store), vec![Provider::Github, Provider::Linear]);
        assert_eq!(store.needs_reentry(), vec![Provider::Github, Provider::Linear]);
    }

    #[test]
    fn a_native_token_or_an_earlier_user_action_blocks_migration() {
        let dir = tempfile::tempdir().unwrap();
        fake_profile(dir.path(), &[7; 32], &[(Provider::Github, "ghp_FAKE_old"), (Provider::Linear, "lin_api_FAKE_old")]);
        let store = TokenStore::new(dir.path());
        store.save(Provider::Github, "ghp_FAKE_native").unwrap();
        store.set_state(Provider::Linear, MigrationState::Done).unwrap();
        assert!(migrate(&store).is_empty());
        assert_eq!(store.load(Provider::Github).unwrap().expose(), "ghp_FAKE_native");
        assert!(!store.has(Provider::Linear), "a token the user removed does not come back");
    }

    #[test]
    fn a_profile_without_tokens_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::new(dir.path());
        assert!(migrate(&store).is_empty());
        assert!(store.states().is_empty());
    }
}
