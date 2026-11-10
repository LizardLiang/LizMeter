//! The migration against a profile real Electron wrote. The key in `Local State` is sealed for the
//! Windows user that ran Electron, so the profile cannot be committed: build one with a throwaway
//! Electron script (fake tokens, scratch `userData`) and point `LIZMETER_TEST_ELECTRON_PROFILE` at it.
//!
//!   cargo test -p lizmeter-services --test electron_migration -- --ignored

use lizmeter_services::tokens::{migrate, MigrationState, Provider, TokenStore};
use std::path::Path;

fn copy_profile(from: &Path, to: &Path) {
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let name = entry.file_name();
        let n = name.to_string_lossy();
        if n == "Local State" || n.ends_with("-token") {
            std::fs::copy(entry.path(), to.join(&name)).unwrap();
        }
    }
}

fn profile() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("LIZMETER_TEST_ELECTRON_PROFILE").expect("set LIZMETER_TEST_ELECTRON_PROFILE to a synthetic Electron profile"))
}

#[test]
#[ignore = "needs a profile written by real Electron (see the module docs)"]
fn tokens_electron_safe_storage_wrote_open_natively() {
    let copy = tempfile::tempdir().unwrap();
    copy_profile(&profile(), copy.path());
    let store = TokenStore::new(copy.path());
    assert!(migrate::migrate(&store).is_empty());
    assert_eq!(store.load(Provider::Github).unwrap().expose(), "ghp_FAKE_PHASE8_0001");
    assert_eq!(store.load(Provider::Linear).unwrap().expose(), "lin_api_FAKE_PHASE8_0002");
    assert_eq!(store.load(Provider::Jira).unwrap().expose(), "jira_FAKE_PHASE8_0003");
    assert!(copy.path().join(".github-token").exists(), "the Electron files are left alone");
}

#[test]
#[ignore = "needs a profile written by real Electron (see the module docs)"]
fn a_corrupt_local_state_flags_the_providers_for_re_entry() {
    let copy = tempfile::tempdir().unwrap();
    copy_profile(&profile(), copy.path());
    std::fs::write(copy.path().join("Local State"), b"{\"os_crypt\":{\"encrypted_key\":\"AAAA\"}}").unwrap();
    let store = TokenStore::new(copy.path());
    assert_eq!(migrate::migrate(&store), vec![Provider::Github, Provider::Linear, Provider::Jira]);
    assert_eq!(store.needs_reentry(), vec![Provider::Github, Provider::Linear, Provider::Jira]);
    assert!(matches!(store.states()[&Provider::Github], MigrationState::Failed { .. }));
}

#[test]
#[ignore = "needs a profile written by real Electron (see the module docs)"]
fn a_token_file_that_was_cut_short_flags_only_that_provider() {
    let copy = tempfile::tempdir().unwrap();
    copy_profile(&profile(), copy.path());
    let cut = std::fs::read(copy.path().join(".linear-token")).unwrap();
    std::fs::write(copy.path().join(".linear-token"), &cut[..cut.len() - 4]).unwrap();
    let store = TokenStore::new(copy.path());
    assert_eq!(migrate::migrate(&store), vec![Provider::Linear]);
    assert_eq!(store.load(Provider::Github).unwrap().expose(), "ghp_FAKE_PHASE8_0001");
    assert_eq!(store.needs_reentry(), vec![Provider::Linear]);
}
