//! Where LizMeter keeps the user's data, and moving it: a port of `electron/main/data-location.ts`.
//!
//! The pointer to a custom folder cannot live in the database (it is the thing being moved), so it
//! sits in `data-location.json` inside the per-user default folder, which never moves. Electron's
//! `app.getPath("userData")` becomes the explicit `default_data_dir` the caller passes in, so tests
//! and the soak mode can point at a temporary folder and never touch `%APPDATA%/lizmeter`.

use crate::error::Result;
use crate::util::js_trim;
use lizmeter_core::{DataLocationInfo, DataLocationMoveErrorCode};
use std::ffi::OsString;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

/// Basename of the SQLite file inside the data directory.
pub const DB_FILE_NAME: &str = "lizmeter.db";
/// Subdirectory holding content-addressed attachment blobs.
pub const ATTACHMENTS_DIR_NAME: &str = "attachments";

const POINTER_FILE_NAME: &str = "data-location.json";
const ADOPTED_MARKER_FILE_NAME: &str = "sync-adopted.json";
const PRIVATE_DB_MARKER_FILE_NAME: &str = "sync-private-db.json";

/// The files a move carries over. Avatars, provider tokens, the yt-dlp binary and the music cache
/// stay behind on purpose: avatar paths are stored as absolute paths and would break, tokens are
/// machine-bound secrets, and the rest is regenerable.
const MOVED_FILES: [&str; 3] = [DB_FILE_NAME, "lizmeter.db-wal", "lizmeter.db-shm"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MoveDataResult {
    Ok { data_dir: PathBuf },
    Err { code: DataLocationMoveErrorCode, message: String },
}

impl MoveDataResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, MoveDataResult::Ok { .. })
    }
    pub fn code(&self) -> Option<DataLocationMoveErrorCode> {
        match self {
            MoveDataResult::Err { code, .. } => Some(*code),
            MoveDataResult::Ok { .. } => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct MoveOptions {
    pub use_existing: bool,
    /// `None` means the default (`true`).
    pub copy_db: Option<bool>,
    /// `None` means the default (`true`).
    pub copy_attachments: Option<bool>,
}

/// `path.resolve` for one path: absolute, with `.` and `..` folded lexically.
pub fn resolve_path(p: impl AsRef<Path>) -> PathBuf {
    let abs = std::path::absolute(p.as_ref()).unwrap_or_else(|_| p.as_ref().to_path_buf());
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn fold(p: &Path) -> OsString {
    // Windows paths compare case-insensitively.
    p.as_os_str().to_string_lossy().to_lowercase().into()
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    fold(&resolve_path(a)) == fold(&resolve_path(b))
}

/// True when `child` is `parent` or sits underneath it. Case-insensitive on Windows.
fn is_inside(child: &Path, parent: &Path) -> bool {
    let c = PathBuf::from(fold(&resolve_path(child)));
    let p = PathBuf::from(fold(&resolve_path(parent)));
    c.starts_with(p)
}

/// Proves the process can actually write into `dir`, which a permissions check cannot on Windows.
fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".lizmeter-write-probe-{}", std::process::id()));
    if fs::write(&probe, "").is_err() {
        return false;
    }
    let _ = fs::remove_file(&probe);
    true
}

/// Timestamped backup of a SQLite database plus its `-wal`/`-shm` siblings, when present. The
/// siblings must travel together or a WAL-mode backup is inconsistent. `Move` renames the original
/// away; `Copy` leaves it in place. Returns `None` for `:memory:` or a path that does not exist.
pub fn backup_db_with_siblings(db_path: &Path, tag: &str, mode: BackupMode) -> Result<Option<PathBuf>> {
    if db_path.as_os_str() == ":memory:" || !db_path.exists() {
        return Ok(None);
    }
    let stamp = crate::util::now_iso().replace([':', '.'], "-");
    let backup = PathBuf::from(format!("{}.pre-{tag}-{stamp}.bak", db_path.display()));
    let transfer = |from: &Path, to: &Path| -> std::io::Result<()> {
        match mode {
            BackupMode::Copy => fs::copy(from, to).map(|_| ()),
            BackupMode::Move => fs::rename(from, to),
        }
    };
    transfer(db_path, &backup)?;
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db_path.display()));
        if side.exists() {
            transfer(&side, &PathBuf::from(format!("{}{suffix}", backup.display())))?;
        }
    }
    Ok(Some(backup))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupMode {
    Copy,
    Move,
}

fn copy_db_into(source: &Path, target: &Path) -> Result<()> {
    for name in MOVED_FILES {
        let from = source.join(name);
        if from.exists() {
            fs::copy(&from, target.join(name))?;
        }
    }
    Ok(())
}

/// Merges `source/attachments` into `target/attachments` without overwriting: blobs are named by
/// their own sha256, so a file already present is byte-identical and the copy stays cheap on retry.
fn copy_attachments_into(source: &Path, target: &Path) -> Result<()> {
    let from = source.join(ATTACHMENTS_DIR_NAME);
    if !from.exists() {
        return Ok(());
    }
    copy_dir_no_overwrite(&from, &target.join(ATTACHMENTS_DIR_NAME))
}

fn copy_dir_no_overwrite(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_no_overwrite(&entry.path(), &dest)?;
        } else if !dest.exists() {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

/// Resolves and moves the data folder for one device.
pub struct DataLocation {
    default_data_dir: PathBuf,
    /// Resolved once per process: a successful move relaunches the app rather than repointing a
    /// live connection, so only `clear_custom_data_dir` (startup recovery) resets it.
    cached: Mutex<Option<PathBuf>>,
}

impl DataLocation {
    pub fn new(default_data_dir: impl Into<PathBuf>) -> Self {
        DataLocation { default_data_dir: default_data_dir.into(), cached: Mutex::new(None) }
    }

    /// `%APPDATA%\lizmeter` (Electron's `userData`), overridable with `LIZMETER_USER_DATA`.
    pub fn default_user_data_dir() -> PathBuf {
        if let Some(dir) = std::env::var_os("LIZMETER_USER_DATA") {
            return PathBuf::from(dir);
        }
        let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        base.join("lizmeter")
    }

    /// Per-user folder where the data lives unless the user moved it.
    pub fn default_data_dir(&self) -> &Path {
        &self.default_data_dir
    }

    fn pointer_file(&self) -> PathBuf {
        self.default_data_dir.join(POINTER_FILE_NAME)
    }

    /// The custom folder recorded on disk, or `None` when the user never moved the data. A corrupt
    /// pointer is treated as absent: falling back keeps the app startable.
    fn read_pointer(&self) -> Option<PathBuf> {
        let raw = fs::read_to_string(self.pointer_file()).ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
        let dir = parsed.get("dataDir")?.as_str()?;
        if js_trim(dir).is_empty() {
            return None;
        }
        Some(resolve_path(dir))
    }

    fn write_pointer(&self, dir: Option<&Path>) -> Result<()> {
        fs::create_dir_all(&self.default_data_dir)?;
        let file = self.pointer_file();
        match dir {
            None => {
                let _ = fs::remove_file(file);
            }
            Some(d) => {
                let body = serde_json::to_string_pretty(&serde_json::json!({ "dataDir": d.to_string_lossy() }))?;
                fs::write(file, format!("{body}\n"))?;
            }
        }
        Ok(())
    }

    /// Where the database and attachments live. Never throws, and never silently falls back when
    /// the pointer names a missing folder: returning the default would open an empty database and
    /// read as total data loss.
    pub fn get_data_dir(&self) -> PathBuf {
        let mut cached = self.cached.lock().unwrap_or_else(|e| e.into_inner());
        if cached.is_none() {
            *cached = Some(self.read_pointer().unwrap_or_else(|| self.default_data_dir.clone()));
        }
        cached.clone().unwrap_or_else(|| self.default_data_dir.clone())
    }

    /// Drops the cached resolution.
    pub fn invalidate_data_dir_cache(&self) {
        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn get_data_dir_status(&self) -> DataLocationInfo {
        let data_dir = self.get_data_dir();
        DataLocationInfo {
            data_dir: data_dir.to_string_lossy().into_owned(),
            default_data_dir: self.default_data_dir.to_string_lossy().into_owned(),
            is_custom: !same_path(&data_dir, &self.default_data_dir),
            available: data_dir.exists(),
        }
    }

    /// Records `dir` as the custom data folder without copying anything. The soak setup uses it to
    /// point a copied profile at its own test sync folder.
    pub fn set_custom_data_dir(&self, dir: &Path) -> Result<()> {
        self.write_pointer(Some(&resolve_path(dir)))?;
        self.invalidate_data_dir_cache();
        Ok(())
    }

    /// Forgets the custom folder and goes back to the default. Leaves every file where it is.
    pub fn clear_custom_data_dir(&self) -> Result<()> {
        self.write_pointer(None)?;
        self.invalidate_data_dir_cache();
        Ok(())
    }

    // --- Multi-writer sync: where this device's own lizmeter.db lives ---
    // No live database may sit inside the shared, cloud-synced folder. Once sync is enabled by any
    // path the database lives in the private per-user folder; before that nothing here is consulted.

    fn adopted_marker(&self) -> PathBuf {
        self.default_data_dir.join(ADOPTED_MARKER_FILE_NAME)
    }

    fn private_db_marker(&self) -> PathBuf {
        self.default_data_dir.join(PRIVATE_DB_MARKER_FILE_NAME)
    }

    /// True once this device has adopted another machine's shared sync history.
    pub fn is_adopted_device(&self) -> bool {
        self.adopted_marker().exists()
    }

    /// Marks this device as an adopter (implies [`mark_private_db`](Self::mark_private_db)). Must be
    /// called before the first `Database::open` of the process that completes an adoption.
    pub fn mark_device_as_adopted(&self) -> Result<()> {
        fs::create_dir_all(&self.default_data_dir)?;
        let body = serde_json::to_string_pretty(&serde_json::json!({ "adoptedAt": crate::util::now_iso() }))?;
        fs::write(self.adopted_marker(), format!("{body}\n"))?;
        self.mark_private_db()
    }

    /// True once this device's live database lives privately rather than in the data folder.
    pub fn has_private_db(&self) -> bool {
        self.is_adopted_device() || self.private_db_marker().exists()
    }

    /// Marks the database as private without claiming this device adopted anything.
    pub fn mark_private_db(&self) -> Result<()> {
        if self.private_db_marker().exists() {
            return Ok(());
        }
        fs::create_dir_all(&self.default_data_dir)?;
        let body = serde_json::to_string_pretty(&serde_json::json!({ "privateSince": crate::util::now_iso() }))?;
        fs::write(self.private_db_marker(), format!("{body}\n"))?;
        Ok(())
    }

    /// Renames any database already at this device's private location out of the way before it is
    /// adopted into, so the adoption cannot wipe the device's own history. Returns the backup path.
    pub fn backup_existing_private_db_before_adopt(&self) -> Result<Option<PathBuf>> {
        backup_db_with_siblings(&self.default_data_dir.join(DB_FILE_NAME), "adopt", BackupMode::Move)
    }

    /// Where `lizmeter.db` itself lives: the data folder until sync is enabled, then the private folder.
    pub fn get_db_dir(&self) -> PathBuf {
        if self.has_private_db() {
            self.default_data_dir.clone()
        } else {
            self.get_data_dir()
        }
    }

    pub fn get_db_path(&self) -> PathBuf {
        self.get_db_dir().join(DB_FILE_NAME)
    }

    /// Copies this device's database (+ `-wal`/`-shm`) from `source_dir` into the private folder,
    /// leaving the original in place. No-op when the source already is the private folder.
    pub fn relocate_db_to_private_storage(&self, source_dir: &Path) -> Result<()> {
        if same_path(source_dir, &self.default_data_dir) {
            return Ok(());
        }
        copy_db_into(&resolve_path(source_dir), &resolve_path(&self.default_data_dir))
    }

    /// Points LizMeter at `target_dir`, copying the database and attachments there first. The
    /// caller must checkpoint and close the database first and relaunch afterwards.
    pub fn move_data_to(&self, target_dir: &Path, options: MoveOptions) -> MoveDataResult {
        let copy_db = options.copy_db.unwrap_or(true);
        let copy_attachments = options.copy_attachments.unwrap_or(true);
        let source = resolve_path(self.get_data_dir());
        let target = resolve_path(target_dir);
        let err = |code, message: String| MoveDataResult::Err { code, message };

        if same_path(&source, &target) {
            return err(DataLocationMoveErrorCode::SameDir, "That is already the current data folder.".into());
        }
        // Copying a folder into itself would recurse; the other direction just leaves the old copy
        // sitting inside the new folder where the user can see it.
        if is_inside(&target, &source) {
            return err(DataLocationMoveErrorCode::Nested, "Pick a folder outside the current data folder.".into());
        }
        if let Err(e) = fs::create_dir_all(&target) {
            return err(DataLocationMoveErrorCode::NotWritable, format!("Could not create that folder: {e}"));
        }
        if !is_writable(&target) {
            return err(DataLocationMoveErrorCode::NotWritable, "That folder is not writable.".into());
        }

        // The refusal only applies when this call might place a db file in `target`.
        let target_has_data = copy_db && target.join(DB_FILE_NAME).exists();
        if target_has_data && !options.use_existing {
            return err(
                DataLocationMoveErrorCode::TargetHasData,
                "That folder already holds a LizMeter database.".into(),
            );
        }

        let copied: Result<()> = (|| {
            if copy_db && !target_has_data {
                copy_db_into(&self.get_db_dir(), &target)?;
            }
            if copy_attachments {
                copy_attachments_into(&source, &target)?;
            }
            Ok(())
        })();
        if let Err(e) = copied {
            return err(DataLocationMoveErrorCode::CopyFailed, format!("Could not copy the data: {e}"));
        }

        // The pointer is written last: a crash mid-copy leaves the app pointed at the intact original.
        let pointer = if same_path(&target, &self.default_data_dir) { None } else { Some(target.as_path()) };
        if let Err(e) = self.write_pointer(pointer) {
            return err(
                DataLocationMoveErrorCode::CopyFailed,
                format!("Copied the data but could not record the new location: {e}"),
            );
        }

        *self.cached.lock().unwrap_or_else(|e| e.into_inner()) = Some(target.clone());
        MoveDataResult::Ok { data_dir: target }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Env {
        _root: TempDir,
        root: PathBuf,
        user_data: PathBuf,
        loc: DataLocation,
    }

    fn env() -> Env {
        let tmp = tempfile::Builder::new().prefix("lizmeter-data-loc-").tempdir().unwrap();
        let root = resolve_path(tmp.path());
        let user_data = root.join("userData");
        fs::create_dir_all(&user_data).unwrap();
        let loc = DataLocation::new(&user_data);
        Env { _root: tmp, root, user_data, loc }
    }

    fn seed(dir: &Path, db: &str) {
        fs::create_dir_all(dir.join(ATTACHMENTS_DIR_NAME)).unwrap();
        fs::write(dir.join(DB_FILE_NAME), db).unwrap();
        fs::write(dir.join(ATTACHMENTS_DIR_NAME).join("abc123.png"), "blob-bytes").unwrap();
    }

    fn read(p: &Path) -> String {
        fs::read_to_string(p).unwrap()
    }

    #[test]
    fn uses_default_folder_when_never_moved() {
        let e = env();
        assert_eq!(e.loc.get_data_dir(), e.user_data);
        let s = e.loc.get_data_dir_status();
        assert_eq!(s.data_dir, e.user_data.to_string_lossy());
        assert!(!s.is_custom);
        assert!(s.available);
    }

    #[test]
    fn uses_folder_named_by_pointer() {
        let e = env();
        let custom = e.root.join("custom");
        fs::create_dir(&custom).unwrap();
        fs::write(e.user_data.join(POINTER_FILE_NAME), serde_json::json!({ "dataDir": custom }).to_string()).unwrap();
        let s = e.loc.get_data_dir_status();
        assert_eq!(PathBuf::from(&s.data_dir), custom);
        assert!(s.is_custom);
        assert!(s.available);
    }

    #[test]
    fn unreadable_or_blank_pointer_falls_back() {
        let e = env();
        fs::write(e.user_data.join(POINTER_FILE_NAME), "{ not json").unwrap();
        assert_eq!(e.loc.get_data_dir(), e.user_data);
        e.loc.invalidate_data_dir_cache();
        fs::write(e.user_data.join(POINTER_FILE_NAME), r#"{"dataDir":"   "}"#).unwrap();
        assert_eq!(e.loc.get_data_dir(), e.user_data);
    }

    #[test]
    fn missing_custom_folder_stays_visible() {
        let e = env();
        let gone = e.root.join("unplugged-drive");
        fs::write(e.user_data.join(POINTER_FILE_NAME), serde_json::json!({ "dataDir": gone }).to_string()).unwrap();
        let s = e.loc.get_data_dir_status();
        assert_eq!(PathBuf::from(&s.data_dir), gone);
        assert!(s.is_custom);
        assert!(!s.available);
    }

    #[test]
    fn move_copies_db_and_attachments_then_records_folder() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        let target = e.root.join("elsewhere");
        assert_eq!(e.loc.move_data_to(&target, MoveOptions::default()), MoveDataResult::Ok { data_dir: target.clone() });
        assert_eq!(read(&target.join(DB_FILE_NAME)), "db-bytes");
        assert_eq!(read(&target.join(ATTACHMENTS_DIR_NAME).join("abc123.png")), "blob-bytes");
        let pointer: serde_json::Value = serde_json::from_str(&read(&e.user_data.join(POINTER_FILE_NAME))).unwrap();
        assert_eq!(pointer, serde_json::json!({ "dataDir": target }));
        assert_eq!(e.loc.get_data_dir(), target);
        // The original stays in place.
        assert!(e.user_data.join(DB_FILE_NAME).exists());
    }

    #[test]
    fn move_carries_wal_sidecars_and_creates_nested_target() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        fs::write(e.user_data.join("lizmeter.db-wal"), "wal-bytes").unwrap();
        let target = e.root.join("new").join("nested").join("folder");
        assert!(e.loc.move_data_to(&target, MoveOptions::default()).is_ok());
        assert_eq!(read(&target.join("lizmeter.db-wal")), "wal-bytes");
        assert!(target.join(DB_FILE_NAME).exists());
    }

    #[test]
    fn move_refuses_same_nested_and_occupied_targets() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        assert_eq!(e.loc.move_data_to(&e.user_data, MoveOptions::default()).code(), Some(DataLocationMoveErrorCode::SameDir));
        assert_eq!(
            e.loc.move_data_to(&e.user_data.join("inner"), MoveOptions::default()).code(),
            Some(DataLocationMoveErrorCode::Nested)
        );
        let occupied = e.root.join("occupied");
        seed(&occupied, "other-db-bytes");
        assert_eq!(
            e.loc.move_data_to(&occupied, MoveOptions::default()).code(),
            Some(DataLocationMoveErrorCode::TargetHasData)
        );
        // The refusal must not have touched either side.
        assert_eq!(read(&occupied.join(DB_FILE_NAME)), "other-db-bytes");
        assert!(!e.user_data.join(POINTER_FILE_NAME).exists());
        assert_eq!(e.loc.get_data_dir(), e.user_data);
    }

    #[test]
    fn use_existing_adopts_without_copying_over() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        let occupied = e.root.join("occupied");
        seed(&occupied, "other-db-bytes");
        let r = e.loc.move_data_to(&occupied, MoveOptions { use_existing: true, ..Default::default() });
        assert_eq!(r, MoveDataResult::Ok { data_dir: occupied.clone() });
        assert_eq!(read(&occupied.join(DB_FILE_NAME)), "other-db-bytes");
        assert_eq!(e.loc.get_data_dir(), occupied);
    }

    #[test]
    fn moving_back_to_default_removes_pointer() {
        let e = env();
        let custom = e.root.join("custom");
        seed(&custom, "db-bytes");
        fs::write(e.user_data.join(POINTER_FILE_NAME), serde_json::json!({ "dataDir": custom }).to_string()).unwrap();
        let r = e.loc.move_data_to(&e.user_data, MoveOptions::default());
        assert_eq!(r, MoveDataResult::Ok { data_dir: e.user_data.clone() });
        assert!(!e.user_data.join(POINTER_FILE_NAME).exists());
        assert!(!e.loc.get_data_dir_status().is_custom);
    }

    #[test]
    fn attachments_merge_without_overwriting() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        let target = e.root.join("elsewhere");
        fs::create_dir_all(target.join(ATTACHMENTS_DIR_NAME)).unwrap();
        fs::write(target.join(ATTACHMENTS_DIR_NAME).join("abc123.png"), "already-there").unwrap();
        fs::write(target.join(ATTACHMENTS_DIR_NAME).join("def456.png"), "target-only").unwrap();
        assert!(e.loc.move_data_to(&target, MoveOptions::default()).is_ok());
        assert_eq!(read(&target.join(ATTACHMENTS_DIR_NAME).join("abc123.png")), "already-there");
        assert_eq!(read(&target.join(ATTACHMENTS_DIR_NAME).join("def456.png")), "target-only");
    }

    #[test]
    fn clear_custom_goes_back_without_deleting() {
        let e = env();
        let custom = e.root.join("custom");
        seed(&custom, "db-bytes");
        fs::write(e.user_data.join(POINTER_FILE_NAME), serde_json::json!({ "dataDir": custom }).to_string()).unwrap();
        assert_eq!(e.loc.get_data_dir(), custom);
        e.loc.clear_custom_data_dir().unwrap();
        assert_eq!(e.loc.get_data_dir(), e.user_data);
        assert!(!e.user_data.join(POINTER_FILE_NAME).exists());
        assert!(custom.join(DB_FILE_NAME).exists());
    }

    #[test]
    fn private_db_markers_switch_db_dir() {
        let e = env();
        assert!(!e.loc.has_private_db());
        assert_eq!(e.loc.get_db_dir(), e.loc.get_data_dir());
        e.loc.mark_private_db().unwrap();
        assert!(e.loc.has_private_db());
        assert!(!e.loc.is_adopted_device());
        assert_eq!(e.loc.get_db_dir(), e.user_data);
    }

    #[test]
    fn adopted_implies_private_db() {
        let e = env();
        e.loc.mark_device_as_adopted().unwrap();
        assert!(e.loc.has_private_db());
        assert!(e.loc.is_adopted_device());
        assert_eq!(e.loc.get_db_dir(), e.user_data);
    }

    #[test]
    fn backup_before_adopt_renames_db_and_siblings() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        fs::write(e.user_data.join("lizmeter.db-wal"), "wal-bytes").unwrap();
        let backup = e.loc.backup_existing_private_db_before_adopt().unwrap().unwrap();
        assert!(backup.to_string_lossy().contains(".pre-adopt-"));
        assert!(backup.to_string_lossy().ends_with(".bak"));
        assert!(!e.user_data.join(DB_FILE_NAME).exists());
        assert_eq!(read(&backup), "db-bytes");
        assert_eq!(read(&PathBuf::from(format!("{}-wal", backup.display()))), "wal-bytes");
    }

    #[test]
    fn backup_returns_none_when_nothing_to_back_up() {
        let e = env();
        assert_eq!(e.loc.backup_existing_private_db_before_adopt().unwrap(), None);
    }

    #[test]
    fn relocate_copies_db_and_siblings_into_private_storage() {
        let e = env();
        let source = e.root.join("old-custom-folder");
        seed(&source, "db-bytes");
        fs::write(source.join("lizmeter.db-wal"), "wal-bytes").unwrap();
        e.loc.relocate_db_to_private_storage(&source).unwrap();
        assert_eq!(read(&e.user_data.join(DB_FILE_NAME)), "db-bytes");
        assert_eq!(read(&e.user_data.join("lizmeter.db-wal")), "wal-bytes");
        assert!(source.join(DB_FILE_NAME).exists());
    }

    #[test]
    fn relocate_is_noop_for_private_source() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        e.loc.relocate_db_to_private_storage(&e.user_data).unwrap();
        assert_eq!(read(&e.user_data.join(DB_FILE_NAME)), "db-bytes");
    }

    #[test]
    fn copy_db_false_skips_database_but_keeps_attachments() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        let target = e.root.join("shared-target");
        let r = e.loc.move_data_to(&target, MoveOptions { copy_db: Some(false), ..Default::default() });
        assert!(r.is_ok());
        assert!(!target.join(DB_FILE_NAME).exists());
        assert!(target.join(ATTACHMENTS_DIR_NAME).join("abc123.png").exists());
    }

    #[test]
    fn copy_db_false_bypasses_target_has_data_check() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        let target = e.root.join("shared-target");
        fs::create_dir_all(&target).unwrap();
        assert!(e.loc.move_data_to(&target, MoveOptions { copy_db: Some(false), ..Default::default() }).is_ok());
    }

    #[test]
    fn copy_attachments_false_skips_attachments_too() {
        let e = env();
        seed(&e.user_data, "db-bytes");
        let target = e.root.join("shared-target");
        fs::create_dir_all(&target).unwrap();
        let r = e.loc.move_data_to(
            &target,
            MoveOptions { copy_db: Some(false), copy_attachments: Some(false), ..Default::default() },
        );
        assert!(r.is_ok());
        assert!(!target.join(DB_FILE_NAME).exists());
        assert!(!target.join(ATTACHMENTS_DIR_NAME).exists());
    }

    #[test]
    fn db_copy_sources_from_db_dir_not_data_dir() {
        let e = env();
        e.loc.mark_private_db().unwrap();
        seed(&e.user_data, "db-bytes");
        let target = e.root.join("elsewhere");
        assert!(e.loc.move_data_to(&target, MoveOptions::default()).is_ok());
        assert_eq!(read(&target.join(DB_FILE_NAME)), "db-bytes");
    }
}
