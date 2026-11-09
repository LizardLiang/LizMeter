//! Timer settings, the generic key-value store, and Neovim activity.

use crate::error::{fail, Result};
use crate::util::{js_len, js_trim, matches_date_shape, now_iso};
use crate::{optional_row, Database};
use chrono::{Duration, Local, NaiveDate, NaiveTime, SecondsFormat, TimeZone, Utc};
use lizmeter_core::{NvimActivity, TimerSettings, DEFAULT_SETTINGS, MAX_DURATION, MIN_DURATION};
use rusqlite::params;

const MAX_NVIM_FIELD_LENGTH: usize = 1000;

const KEY_WORK: &str = "timer.work_duration";
const KEY_SHORT: &str = "timer.short_break_duration";
const KEY_LONG: &str = "timer.long_break_duration";

fn validate_duration(value: i64, field: &str) -> Result<()> {
    if value < MIN_DURATION || value > MAX_DURATION {
        return fail(format!("Invalid {field}: {value} is out of range [{MIN_DURATION}, {MAX_DURATION}]"));
    }
    Ok(())
}

/// `parseInt(value, 10)`: leading integer, `None` when there is none.
fn js_parse_int(s: &str) -> Option<i64> {
    let t = js_trim(s);
    let (sign, rest) = match t.strip_prefix('-') {
        Some(r) => (-1, r),
        None => (1, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<i64>().ok().map(|n| n * sign)
}

impl Database {
    pub fn get_settings(&self) -> Result<TimerSettings> {
        let read = |key: &str, default: i64| -> Result<i64> {
            Ok(self.get_setting_value(key)?.as_deref().and_then(js_parse_int).unwrap_or(default))
        };
        Ok(TimerSettings {
            work_duration: read(KEY_WORK, DEFAULT_SETTINGS.work_duration)?,
            short_break_duration: read(KEY_SHORT, DEFAULT_SETTINGS.short_break_duration)?,
            long_break_duration: read(KEY_LONG, DEFAULT_SETTINGS.long_break_duration)?,
        })
    }

    pub fn save_settings(&self, settings: &TimerSettings) -> Result<()> {
        validate_duration(settings.work_duration, "workDuration")?;
        validate_duration(settings.short_break_duration, "shortBreakDuration")?;
        validate_duration(settings.long_break_duration, "longBreakDuration")?;

        let tx = self.conn().unchecked_transaction()?;
        for (key, v) in
            [(KEY_WORK, settings.work_duration), (KEY_SHORT, settings.short_break_duration), (KEY_LONG, settings.long_break_duration)]
        {
            tx.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", params![key, v.to_string()])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_setting_value(&self, key: &str) -> Result<Option<String>> {
        optional_row(self.conn().query_row("SELECT value FROM settings WHERE key = ?", [key], |r| r.get(0)))
    }

    pub fn set_setting_value(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", params![key, value])?;
        Ok(())
    }

    pub fn delete_setting_value(&self, key: &str) -> Result<()> {
        self.conn().execute("DELETE FROM settings WHERE key = ?", [key])?;
        Ok(())
    }

    // --- Neovim activity ---

    pub fn is_duplicate_nvim_activity(&self, project: &str, file: &str) -> Result<bool> {
        let cutoff = (Utc::now() - Duration::milliseconds(60_000)).to_rfc3339_opts(SecondsFormat::Millis, true);
        let row = optional_row(self.conn().query_row(
            "SELECT id FROM nvim_activity WHERE project = ? AND file = ? AND recorded_at >= ? LIMIT 1",
            params![project, file, cutoff],
            |r| r.get::<_, i64>(0),
        ))?;
        Ok(row.is_some())
    }

    pub fn insert_nvim_activity(&self, project: &str, file: &str) -> Result<()> {
        let p = js_trim(project);
        let f = js_trim(file);
        if p.is_empty() || f.is_empty() || js_len(p) > MAX_NVIM_FIELD_LENGTH || js_len(f) > MAX_NVIM_FIELD_LENGTH {
            return fail("Invalid project or file value for nvim_activity insert");
        }
        self.conn().execute(
            "INSERT INTO nvim_activity (project, file, recorded_at) VALUES (?, ?, ?)",
            params![p, f, now_iso()],
        )?;
        Ok(())
    }

    /// Activity recorded during one local calendar day (`YYYY-MM-DD`), newest first.
    pub fn list_nvim_activity_by_date(&self, date: &str) -> Result<Vec<NvimActivity>> {
        if !matches_date_shape(date) {
            return fail(format!("Invalid date format: \"{date}\". Expected YYYY-MM-DD."));
        }
        let year: i32 = date[0..4].parse().unwrap_or(0);
        let month: u32 = date[5..7].parse().unwrap_or(0);
        let day: i64 = date[8..10].parse().unwrap_or(0);
        if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
            return fail("Invalid time value");
        }
        // Like V8, an overflowing day (Feb 31) rolls into the next month.
        let Some(first) = NaiveDate::from_ymd_opt(year, month, 1) else { return fail("Invalid time value") };
        let local_date = first + Duration::days(day - 1);
        let midnight = local_date.and_time(NaiveTime::MIN);
        let start = match Local.from_local_datetime(&midnight).earliest() {
            Some(t) => t,
            // Midnight does not exist on a DST-gap day: JS moves forward by the gap.
            None => match Local.from_local_datetime(&(midnight + Duration::hours(1))).earliest() {
                Some(t) => t,
                None => return fail("Invalid time value"),
            },
        };
        let start_iso = start.with_timezone(&Utc).to_rfc3339_opts(SecondsFormat::Millis, true);
        let next_iso =
            (start.with_timezone(&Utc) + Duration::milliseconds(86_400_000)).to_rfc3339_opts(SecondsFormat::Millis, true);

        let mut stmt = self.conn().prepare(
            "SELECT id, project, file, recorded_at FROM nvim_activity \
             WHERE recorded_at >= ? AND recorded_at < ? ORDER BY recorded_at DESC",
        )?;
        let records = stmt
            .query_map(params![start_iso, next_iso], |r| {
                Ok(NvimActivity { id: r.get(0)?, project: r.get(1)?, file: r.get(2)?, recorded_at: r.get(3)? })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }
}
