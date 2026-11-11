//! Issue-tracker token storage. Each token is one DPAPI-sealed file under
//! `<userData>/native-tokens/`. The Electron build's `.github-token` files in `<userData>` are
//! never written or deleted here: the previous app keeps working beside this one, and a rollback
//! finds its tokens where it left them. [`migrate`] copies them over once.

pub mod dpapi;
pub mod migrate;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Github,
    Linear,
    Jira,
}

impl Provider {
    pub const ALL: [Provider; 3] = [Provider::Github, Provider::Linear, Provider::Jira];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Github => "github",
            Provider::Linear => "linear",
            Provider::Jira => "jira",
        }
    }

    pub fn display(self) -> &'static str {
        match self {
            Provider::Github => "GitHub",
            Provider::Linear => "Linear",
            Provider::Jira => "Jira",
        }
    }
}

/// A token or password. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

/// How a provider's token came to be where it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum MigrationState {
    /// Copied from the Electron profile.
    Migrated,
    /// The Electron token could not be carried over. `reason` holds no token text.
    Failed { reason: String },
    /// The user saved or removed the token in this app; the Electron file is not consulted again.
    Done,
}

pub struct TokenStore {
    dir: PathBuf,
    user_data: PathBuf,
    write_lock: std::sync::Mutex<()>,
}

impl fmt::Debug for TokenStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenStore").field("dir", &self.dir).finish()
    }
}

impl TokenStore {
    pub fn new(user_data: &Path) -> Self {
        TokenStore { dir: user_data.join("native-tokens"), user_data: user_data.to_path_buf(), write_lock: std::sync::Mutex::new(()) }
    }

    pub fn user_data(&self) -> &Path {
        &self.user_data
    }

    fn path(&self, p: Provider) -> PathBuf {
        self.dir.join(format!("{}.dpapi", p.as_str()))
    }

    fn status_path(&self) -> PathBuf {
        self.dir.join("migration.json")
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("Could not create the token folder: {e}"))?;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = path.with_extension(format!("tmp-{}-{unique}", std::process::id()));
        std::fs::write(&tmp, bytes).map_err(|e| format!("Could not write the token file: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("Could not write the token file: {e}")
        })
    }

    pub fn save(&self, p: Provider, token: &str) -> Result<(), String> {
        let sealed = dpapi::protect(token.as_bytes())?;
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.write_atomic(&self.path(p), &sealed)
    }

    /// The stored token, or `None` when none is stored or it cannot be opened.
    pub fn load(&self, p: Provider) -> Option<Secret> {
        let sealed = std::fs::read(self.path(p)).ok()?;
        let plain = dpapi::unprotect(&sealed).ok()?;
        String::from_utf8(plain).ok().map(Secret::new)
    }

    /// Whether a token is stored and opens for this Windows user.
    pub fn has(&self, p: Provider) -> bool {
        self.load(p).is_some()
    }

    pub fn delete(&self, p: Provider) {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = std::fs::remove_file(self.path(p));
    }

    pub fn states(&self) -> BTreeMap<Provider, MigrationState> {
        match std::fs::read(self.status_path()) {
            Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|_| Provider::ALL.into_iter().map(|p| (p, MigrationState::Done)).collect()),
            Err(_) => BTreeMap::new(),
        }
    }

    pub fn set_state(&self, p: Provider, state: MigrationState) -> Result<(), String> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.states();
        all.insert(p, state);
        let json = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
        self.write_atomic(&self.status_path(), &json)
    }

    /// The providers whose Electron token could not be carried over and that have no token now.
    pub fn needs_reentry(&self) -> Vec<Provider> {
        self.states().into_iter().filter(|(p, s)| matches!(s, MigrationState::Failed { .. }) && !self.has(*p)).map(|(p, _)| p).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_token_reads_back_and_the_file_holds_no_plain_text() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::new(dir.path());
        assert!(!store.has(Provider::Github));
        store.save(Provider::Github, "ghp_FAKE_unit_0001").unwrap();
        assert!(store.has(Provider::Github));
        assert_eq!(store.load(Provider::Github).unwrap().expose(), "ghp_FAKE_unit_0001");
        let raw = std::fs::read(dir.path().join("native-tokens").join("github.dpapi")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("ghp_FAKE"));
        store.delete(Provider::Github);
        assert!(store.load(Provider::Github).is_none());
    }

    #[test]
    fn a_blob_from_another_entropy_does_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = TokenStore::new(dir.path());
        std::fs::create_dir_all(dir.path().join("native-tokens")).unwrap();
        std::fs::write(dir.path().join("native-tokens").join("jira.dpapi"), dpapi::protect_plain(b"x").unwrap()).unwrap();
        assert!(!store.has(Provider::Jira), "a blob that does not open is not a configured token");
        assert!(store.load(Provider::Jira).is_none());
    }

    #[test]
    fn concurrent_saves_for_one_provider_never_leave_a_broken_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(TokenStore::new(dir.path()));
        let workers: Vec<_> = (0..8)
            .map(|n| {
                let store = store.clone();
                std::thread::spawn(move || {
                    for i in 0..10 {
                        store.save(Provider::Github, &format!("ghp_FAKE_{n}_{i}")).expect("save");
                        if i % 5 == 4 {
                            store.delete(Provider::Github);
                        }
                    }
                })
            })
            .collect();
        for w in workers {
            w.join().unwrap();
        }
        store.save(Provider::Github, "ghp_FAKE_last").unwrap();
        assert_eq!(store.load(Provider::Github).unwrap().expose(), "ghp_FAKE_last");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("native-tokens"))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn secrets_are_redacted_in_debug_output() {
        assert_eq!(format!("{:?}", Secret::new("lin_api_FAKE")), "Secret(<redacted>)");
    }
}
