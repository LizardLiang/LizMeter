//! Soak mode: run the native app on a copy of the real profile, against a test sync folder.
//!
//! `setup` copies `%APPDATA%\lizmeter` to `%APPDATA%\lizmeter-soak` and points the copy's sync at a
//! new test folder. `check_soak_data_dir` refuses the real OneDrive sync folder in soak mode, so a
//! soak run can never write into the folder the user's real machines share. Every function takes
//! its folders as arguments: tests and the app pass the folders, nothing here reads `%APPDATA%`.

use lizmeter_db::data_location::{same_path, DataLocation, ATTACHMENTS_DIR_NAME, DB_FILE_NAME};
use lizmeter_sync::oplog::{get_sync_devices_dir, OPLOG_SUFFIX};
use sha2::{Digest, Sha256};
use crate::os::guard::{find_electron_process, ElectronMatcher, SingleWriterGuard};
use std::fs;
use std::path::{Path, PathBuf};

/// Folder name of the soak profile, beside the real `lizmeter` folder.
pub const SOAK_DIR_NAME: &str = "lizmeter-soak";
/// Folder name of the default test sync folder, beside the soak profile.
pub const SOAK_SYNC_DIR_NAME: &str = "lizmeter-soak-sync";
/// Pipe the soak app serves, so a running Electron or native app keeps the default pipe.
pub const SOAK_PIPE_PATH: &str = "\\\\.\\pipe\\lizmeter-soak";

/// Files of the per-user folder a soak copy keeps besides the database. Tokens, the lock files, the
/// music cache and avatars stay behind: the soak profile carries its own. The database itself is
/// copied with `VACUUM INTO`, never file by file.
const COPIED_FILES: [&str; 2] = ["device-identity.json", "sync-adopted.json"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SoakPaths {
    pub source: PathBuf,
    pub soak: PathBuf,
    pub sync: PathBuf,
}

/// The three folders under one `%APPDATA%`.
pub fn paths_under(appdata: &Path) -> SoakPaths {
    SoakPaths {
        source: appdata.join("lizmeter"),
        soak: appdata.join(SOAK_DIR_NAME),
        sync: appdata.join(SOAK_SYNC_DIR_NAME),
    }
}

#[derive(Debug)]
pub enum SoakError {
    /// The folder is, or sits inside, a OneDrive folder.
    RealSyncPath(PathBuf),
    /// The test sync folder is the folder the source profile syncs through.
    SameAsSourceSync(PathBuf),
    /// The soak profile folder already holds files, and setup never overwrites.
    SoakNotEmpty(PathBuf),
    /// The source profile has no database to copy.
    NoSourceDb(PathBuf),
    /// A soak folder equals the source profile.
    SoakIsSource(PathBuf),
    Io(std::io::Error),
    Other(String),
}

impl std::fmt::Display for SoakError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SoakError::RealSyncPath(p) => write!(
                f,
                "Soak mode refuses {}: it is inside a OneDrive folder. Use a local test folder, for example with --soak-sync C:\\soak-sync.",
                p.display()
            ),
            SoakError::SameAsSourceSync(p) => {
                write!(f, "Soak mode refuses {}: the real profile syncs through that folder.", p.display())
            }
            SoakError::SoakNotEmpty(p) => write!(
                f,
                "{} already holds files. Setup never overwrites a soak profile. Delete the folder first to start again.",
                p.display()
            ),
            SoakError::NoSourceDb(p) => write!(f, "No lizmeter.db found for the profile {}.", p.display()),
            SoakError::SoakIsSource(p) => write!(f, "The soak folder {} is the real profile folder.", p.display()),
            SoakError::Io(e) => write!(f, "{e}"),
            SoakError::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for SoakError {}

impl From<std::io::Error> for SoakError {
    fn from(e: std::io::Error) -> Self {
        SoakError::Io(e)
    }
}

impl From<lizmeter_db::DbError> for SoakError {
    fn from(e: lizmeter_db::DbError) -> Self {
        SoakError::Other(e.to_string())
    }
}

/// The OneDrive folders this machine names in its environment.
pub fn onedrive_roots_from_env() -> Vec<PathBuf> {
    ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .iter()
        .filter_map(|k| std::env::var_os(k))
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .collect()
}

fn lowered(p: &Path) -> String {
    lizmeter_db::data_location::resolve_path(p).to_string_lossy().to_lowercase().replace('/', "\\")
}

/// True when `path` is, or sits inside, a OneDrive folder: under a root the environment names, or
/// under any folder whose name starts with `OneDrive` (the shape `C:\Users\<name>\OneDrive\...`
/// and `...\OneDrive - <company>\...`). The check reads strings only and never opens the path.
pub fn is_onedrive_path(path: &Path, roots: &[PathBuf]) -> bool {
    let p = lowered(path);
    if roots.iter().any(|r| {
        let r = lowered(r);
        p == r || p.starts_with(&format!("{}\\", r.trim_end_matches('\\')))
    }) {
        return true;
    }
    p.split('\\').any(|part| part.starts_with("onedrive"))
}

/// Soak mode's guard on the folder the soak profile syncs through.
pub fn check_soak_data_dir(data_dir: &Path, roots: &[PathBuf]) -> Result<(), SoakError> {
    if is_onedrive_path(data_dir, roots) {
        return Err(SoakError::RealSyncPath(data_dir.to_path_buf()));
    }
    Ok(())
}

/// What `setup` did, for the caller to print.
#[derive(Debug)]
pub struct SetupReport {
    pub soak: PathBuf,
    pub sync: PathBuf,
    pub copied: Vec<String>,
    pub attachments_copied: usize,
    pub device_identity_kept: bool,
    /// Todo count and ids digest of the copied database: the day-0 baseline of the clean-run check.
    pub baseline: Option<(i64, String)>,
}

fn dir_has_entries(p: &Path) -> bool {
    fs::read_dir(p).map(|mut d| d.next().is_some()).unwrap_or(false)
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<usize> {
    fs::create_dir_all(to)?;
    let mut n = 0;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            n += copy_tree(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
            n += 1;
        }
    }
    Ok(n)
}

/// Copies the source profile into `soak` and points the copy at `sync`.
///
/// Reads the source (never writes it), writes only under `soak` and `sync`. The copy keeps the
/// database, the device identity and the adoption marker, so it behaves as the same device, and
/// always keeps its database privately in the soak folder (the layout of a synced device). Refuses
/// a OneDrive test folder, the source's own sync folder, and a soak folder that already has files.
pub fn setup(source: &Path, soak: &Path, sync: &Path, roots: &[PathBuf]) -> Result<SetupReport, SoakError> {
    if same_path(source, soak) || same_path(source, sync) {
        return Err(SoakError::SoakIsSource(source.to_path_buf()));
    }
    check_soak_data_dir(sync, roots)?;
    check_soak_data_dir(soak, roots)?;
    let source_loc = DataLocation::new(source);
    let source_sync = source_loc.get_data_dir();
    if same_path(&source_sync, sync) || same_path(&source_sync, soak) {
        return Err(SoakError::SameAsSourceSync(sync.to_path_buf()));
    }
    let source_db = source_loc.get_db_path();
    if !source_db.exists() {
        return Err(SoakError::NoSourceDb(source.to_path_buf()));
    }
    if dir_has_entries(soak) {
        return Err(SoakError::SoakNotEmpty(soak.to_path_buf()));
    }
    let _held = hold_source(source, &source_sync)?;
    fs::create_dir_all(soak)?;
    fs::create_dir_all(sync)?;

    let mut copied = Vec::new();
    vacuum_into(&source_db, &soak.join(DB_FILE_NAME))?;
    copied.push(DB_FILE_NAME.to_string());
    for name in COPIED_FILES {
        let from = source.join(name);
        if from.is_file() {
            fs::copy(&from, soak.join(name))?;
            copied.push(name.to_string());
        }
    }
    verify_copy(&soak.join(DB_FILE_NAME))?;
    let soak_loc = DataLocation::new(soak);
    soak_loc.mark_private_db()?;
    soak_loc.set_custom_data_dir(sync)?;

    let attachments = source_sync.join(ATTACHMENTS_DIR_NAME);
    let attachments_copied = if attachments.is_dir() { copy_tree(&attachments, &sync.join(ATTACHMENTS_DIR_NAME))? } else { 0 };
    let device_identity_kept = soak.join("device-identity.json").is_file();
    let baseline = check(soak).ok().map(|r| (r.todo_count, r.ids_digest));
    Ok(SetupReport { soak: soak.to_path_buf(), sync: sync.to_path_buf(), copied, attachments_copied, device_identity_kept, baseline })
}

/// Refuses while a LizMeter writes the source: the native single-writer mutex on the per-user folder
/// and on the data folder, and a running Electron LizMeter when the source is `%APPDATA%\lizmeter`.
/// The returned guards keep a native app from starting while the copy runs. No file is written
/// into the source.
fn hold_source(source: &Path, data_dir: &Path) -> Result<Vec<SingleWriterGuard>, SoakError> {
    let busy = |what: String| {
        SoakError::Other(format!("{what} Close every LizMeter, then run setup again. The soak copy was not made."))
    };
    let mut held = Vec::new();
    let mut dirs = vec![source];
    if !same_path(data_dir, source) {
        dirs.push(data_dir);
    }
    for dir in dirs {
        held.push(SingleWriterGuard::acquire_mutex_only(dir).map_err(|e| busy(e.to_string()))?);
    }
    let electron_dir = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("lizmeter"));
    if electron_dir.is_some_and(|d| same_path(&d, source)) {
        if let Some((pid, exe)) = find_electron_process(&ElectronMatcher::default()) {
            return Err(busy(format!("The Electron LizMeter is running (process {pid}, {}).", exe.display())));
        }
    }
    Ok(held)
}

/// Writes a consistent copy of the database at `to` from a read-only connection: the pages and the
/// WAL are read together by SQLite, so the copy never pairs a database file with a WAL of another moment.
fn vacuum_into(from: &Path, to: &Path) -> Result<(), SoakError> {
    let fail = |e: String| SoakError::Other(format!("Could not copy the database ({e}). Close every LizMeter and run setup again."));
    let conn = rusqlite::Connection::open_with_flags(from, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| fail(e.to_string()))?;
    conn.execute("VACUUM INTO ?1", [to.to_string_lossy().as_ref()]).map_err(|e| fail(e.to_string()))?;
    Ok(())
}

/// Opens the copied database read-only and runs SQLite's quick check. A copy taken while an app
/// wrote the source can pair a `.db` with a `-wal` from another moment, and the check fails then.
fn verify_copy(db: &Path) -> Result<(), SoakError> {
    let fail = |e: String| SoakError::Other(format!("The copied database failed its check ({e}). Close every LizMeter and run setup again."));
    let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| fail(e.to_string()))?;
    let verdict: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| fail(e.to_string()))?;
    if verdict == "ok" { Ok(()) } else { Err(fail(verdict)) }
}

/// A one-screen summary of a soak profile, to compare against a clean-run checklist.
#[derive(Debug, PartialEq, Eq)]
pub struct CheckReport {
    pub data_dir: PathBuf,
    pub merge_failed: i64,
    pub oplog_entry_skipped: i64,
    pub other_notices: Vec<(String, i64)>,
    pub todo_count: i64,
    pub max_todo_id: i64,
    /// First 16 hex digits of the SHA-256 over the sorted `id|title` lines. Equal on two profiles
    /// when their todo ids converged.
    pub ids_digest: String,
    pub oplog_files: Vec<String>,
}

impl CheckReport {
    pub fn is_clean(&self) -> bool {
        self.merge_failed == 0 && self.oplog_entry_skipped == 0
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!("data folder: {}\n", self.data_dir.display()));
        out.push_str(&format!("merge-failed notices (not dismissed): {}\n", self.merge_failed));
        out.push_str(&format!("oplog-entry-skipped notices (not dismissed): {}\n", self.oplog_entry_skipped));
        for (kind, n) in &self.other_notices {
            out.push_str(&format!("other notice {kind}: {n}\n"));
        }
        out.push_str(&format!("todos: {} (highest id {})\n", self.todo_count, self.max_todo_id));
        out.push_str(&format!("todo ids digest: {}\n", self.ids_digest));
        out.push_str(&format!("oplog files: {}\n", if self.oplog_files.is_empty() { "none".into() } else { self.oplog_files.join(", ") }));
        out.push_str(if self.is_clean() { "result: CLEAN\n" } else { "result: NOT CLEAN\n" });
        out
    }
}

/// Reads a soak profile without writing to it: the notices, the todo ids and the oplog files.
pub fn check(soak: &Path) -> Result<CheckReport, SoakError> {
    let loc = DataLocation::new(soak);
    let db_path = loc.get_db_path();
    if !db_path.exists() {
        return Err(SoakError::NoSourceDb(soak.to_path_buf()));
    }
    let conn = rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| SoakError::Other(e.to_string()))?;
    let sql_err = |e: rusqlite::Error| SoakError::Other(e.to_string());
    let mut notices: Vec<(String, i64)> = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT kind, COUNT(*) FROM sync_notices WHERE dismissed = 0 GROUP BY kind ORDER BY kind")
            .map_err(sql_err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map_err(sql_err)?;
        for row in rows {
            notices.push(row.map_err(sql_err)?);
        }
    }
    let count_of = |kind: &str| notices.iter().find(|(k, _)| k == kind).map(|(_, n)| *n).unwrap_or(0);
    let (merge_failed, oplog_entry_skipped) = (count_of("merge-failed"), count_of("oplog-entry-skipped"));
    let other_notices = notices.into_iter().filter(|(k, _)| k != "merge-failed" && k != "oplog-entry-skipped").collect();

    let mut hasher = Sha256::new();
    let (mut todo_count, mut max_todo_id) = (0i64, 0i64);
    {
        let mut stmt = conn.prepare("SELECT id, title FROM todos ORDER BY id").map_err(sql_err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(sql_err)?;
        for row in rows {
            let (id, title) = row.map_err(sql_err)?;
            todo_count += 1;
            max_todo_id = max_todo_id.max(id);
            hasher.update(format!("{id}|{title}\n").as_bytes());
        }
    }
    let digest = hasher.finalize();
    let ids_digest: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();

    let data_dir = loc.get_data_dir();
    let mut oplog_files: Vec<String> = fs::read_dir(get_sync_devices_dir(&data_dir))
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(OPLOG_SUFFIX))
                .collect()
        })
        .unwrap_or_default();
    oplog_files.sort();
    Ok(CheckReport { data_dir, merge_failed, oplog_entry_skipped, other_notices, todo_count, max_todo_id, ids_digest, oplog_files })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_onedrive_shapes_are_refused_without_opening_them() {
        let roots = [PathBuf::from("C:\\Users\\someone\\OneDrive")];
        // The real sync path of this machine, as a string only: it is never opened.
        let real = Path::new("C:/Users/lizard_liang/OneDrive/Apps/sync");
        assert!(is_onedrive_path(real, &[]));
        assert!(is_onedrive_path(Path::new("C:\\Users\\someone\\OneDrive\\Apps\\sync"), &roots));
        assert!(is_onedrive_path(Path::new("c:\\users\\someone\\onedrive\\x"), &roots));
        assert!(is_onedrive_path(Path::new("D:\\Work\\OneDrive - Contoso\\sync"), &[]));
        assert!(is_onedrive_path(Path::new("E:\\cloud\\x"), &[PathBuf::from("E:\\cloud")]));
        assert!(!is_onedrive_path(Path::new("C:\\Users\\someone\\AppData\\Roaming\\lizmeter-soak-sync"), &roots));
        assert!(!is_onedrive_path(Path::new("E:\\cloud-other\\x"), &[PathBuf::from("E:\\cloud")]));
        assert!(matches!(check_soak_data_dir(real, &[]), Err(SoakError::RealSyncPath(_))));
    }

    fn fake_profile(dir: &Path, sync_dir: Option<&Path>) {
        fs::create_dir_all(dir).unwrap();
        let loc = DataLocation::new(dir);
        let db = lizmeter_db::Database::open(dir.join(DB_FILE_NAME)).unwrap();
        db.conn().execute("INSERT INTO todos (title, created_at) VALUES ('one', 't'), ('two', 't')", []).unwrap();
        db.conn()
            .execute(
                "INSERT INTO sync_notices (kind, message, created_at) VALUES ('stray-file', 'x', '2026-01-01')",
                [],
            )
            .unwrap();
        drop(db);
        fs::write(dir.join("device-identity.json"), "{\"deviceId\":\"abc\"}").unwrap();
        fs::write(dir.join("lizmeter.lock"), "").unwrap();
        fs::create_dir_all(dir.join("native-tokens")).unwrap();
        fs::write(dir.join("native-tokens").join("github.dpapi"), "secret").unwrap();
        if let Some(s) = sync_dir {
            loc.mark_private_db().unwrap();
            loc.set_custom_data_dir(s).unwrap();
        }
    }

    #[test]
    fn setup_copies_profile_and_points_sync_at_the_test_folder() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        let real_sync = t.path().join("shared");
        fs::create_dir_all(real_sync.join("attachments")).unwrap();
        fs::write(real_sync.join("attachments").join("blob"), "b").unwrap();
        fake_profile(&p.source, Some(&real_sync));
        let before = fs::read(p.source.join("data-location.json")).unwrap();

        let report = setup(&p.source, &p.soak, &p.sync, &[]).unwrap();
        assert!(report.copied.contains(&"lizmeter.db".to_string()));
        assert!(report.device_identity_kept);
        assert_eq!(report.attachments_copied, 1);
        assert_eq!(report.baseline.as_ref().map(|b| b.0), Some(2));
        assert!(p.sync.join("attachments").join("blob").is_file());
        assert!(!p.soak.join("lizmeter.lock").exists());
        assert!(!p.soak.join("native-tokens").exists());
        let loc = DataLocation::new(&p.soak);
        assert!(same_path(&loc.get_data_dir(), &p.sync));
        assert!(same_path(&loc.get_db_dir(), &p.soak));
        // The source is untouched.
        assert_eq!(fs::read(p.source.join("data-location.json")).unwrap(), before);
        assert!(!real_sync.join("sync").exists());

        let rep = check(&p.soak).unwrap();
        assert_eq!(rep.todo_count, 2);
        assert!(rep.is_clean());
        assert_eq!(rep.other_notices, vec![("stray-file".to_string(), 1)]);
        assert_eq!(rep.ids_digest.len(), 16);
    }

    #[test]
    fn setup_copies_the_database_through_sqlite_not_file_by_file() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        fake_profile(&p.source, None);
        // A connection that stays open keeps un-checkpointed commits in the source's -wal.
        let open = lizmeter_db::Database::open(p.source.join(DB_FILE_NAME)).unwrap();
        open.conn().execute("INSERT INTO todos (title, created_at) VALUES ('three', 't')", []).unwrap();
        let before = fs::read(p.source.join(DB_FILE_NAME)).unwrap();

        // The open connection is not a LizMeter guard holder, so setup proceeds.
        let report = setup(&p.source, &p.soak, &p.sync, &[]).unwrap();
        assert_eq!(report.baseline.as_ref().map(|b| b.0), Some(3), "the WAL commit is in the copy");
        assert!(!p.soak.join("lizmeter.db-wal").exists() && !p.soak.join("lizmeter.db-shm").exists());
        assert!(!report.copied.iter().any(|f| f.ends_with("-wal") || f.ends_with("-shm")));
        assert_eq!(fs::read(p.source.join(DB_FILE_NAME)).unwrap(), before, "the source database file is untouched");
    }

    #[test]
    fn setup_refuses_while_a_native_app_holds_the_source() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        fake_profile(&p.source, None);
        let guard = SingleWriterGuard::acquire_mutex_only(&p.source).unwrap();
        let e = setup(&p.source, &p.soak, &p.sync, &[]).unwrap_err();
        assert!(e.to_string().contains("already running"), "{e}");
        assert!(!p.soak.exists(), "nothing was written");
        drop(guard);
        setup(&p.source, &p.soak, &p.sync, &[]).unwrap();
    }

    #[test]
    fn setup_refuses_a_onedrive_shaped_test_folder_and_the_source_sync_folder() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        let fake_real = t.path().join("OneDrive").join("Apps").join("sync");
        fake_profile(&p.source, Some(&fake_real));
        let e = setup(&p.source, &p.soak, &fake_real, &[]).unwrap_err();
        assert!(matches!(e, SoakError::RealSyncPath(_)), "{e}");
        let plain = t.path().join("plain");
        fake_profile(&t.path().join("src2"), Some(&plain));
        let e = setup(&t.path().join("src2"), &t.path().join("soak2"), &plain, &[]).unwrap_err();
        assert!(matches!(e, SoakError::SameAsSourceSync(_)), "{e}");
        assert!(!p.soak.exists() && !t.path().join("soak2").exists());
    }

    #[test]
    fn setup_never_overwrites_a_soak_profile() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        fake_profile(&p.source, None);
        setup(&p.source, &p.soak, &p.sync, &[]).unwrap();
        let e = setup(&p.source, &p.soak, &p.sync, &[]).unwrap_err();
        assert!(matches!(e, SoakError::SoakNotEmpty(_)), "{e}");
    }

    #[test]
    fn setup_needs_a_source_database() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        fs::create_dir_all(&p.source).unwrap();
        assert!(matches!(setup(&p.source, &p.soak, &p.sync, &[]), Err(SoakError::NoSourceDb(_))));
    }

    #[test]
    fn check_flags_merge_and_skip_notices() {
        let t = tempfile::tempdir().unwrap();
        let p = paths_under(t.path());
        fake_profile(&p.source, None);
        setup(&p.source, &p.soak, &p.sync, &[]).unwrap();
        let db = lizmeter_db::Database::open(p.soak.join(DB_FILE_NAME)).unwrap();
        for kind in ["merge-failed", "oplog-entry-skipped"] {
            db.conn()
                .execute("INSERT INTO sync_notices (kind, message, created_at) VALUES (?, 'x', '2026-01-01')", [kind])
                .unwrap();
        }
        drop(db);
        let rep = check(&p.soak).unwrap();
        assert_eq!((rep.merge_failed, rep.oplog_entry_skipped), (1, 1));
        assert!(!rep.is_clean());
        assert!(rep.render().contains("NOT CLEAN"));
    }
}
