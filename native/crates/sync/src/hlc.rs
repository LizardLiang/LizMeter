//! Hybrid Logical Clock (`hlc.ts`). Compares as `(physical_ms, counter, device_number)`.

use crate::{js_parse_int, read_setting, write_setting, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hlc {
    pub physical_ms: i64,
    pub counter: i64,
    pub device_number: i64,
}

const PHYSICAL_MS_KEY: &str = "sync.hlcPhysicalMs";
const COUNTER_KEY: &str = "sync.hlcCounter";

/// A remote clock more than this far ahead of ours is clamped rather than trusted (FR-033).
pub const MAX_CLOCK_DRIFT_MS: i64 = 5 * 60 * 1000;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn read_state(conn: &Connection) -> Result<(i64, i64)> {
    let physical = read_setting(conn, PHYSICAL_MS_KEY)?.and_then(|v| js_parse_int(&v)).unwrap_or(0);
    let counter = read_setting(conn, COUNTER_KEY)?.and_then(|v| js_parse_int(&v)).unwrap_or(0);
    Ok((physical, counter))
}

fn write_state(conn: &Connection, physical_ms: i64, counter: i64) -> Result<()> {
    write_setting(conn, PHYSICAL_MS_KEY, &physical_ms.to_string())?;
    write_setting(conn, COUNTER_KEY, &counter.to_string())
}

/// Ticks the clock for a local write. Persisted after every tick, so a restart never regresses time.
pub fn tick(conn: &Connection, device_number: i64) -> Result<Hlc> {
    tick_at(conn, device_number, now_ms())
}

pub fn tick_at(conn: &Connection, device_number: i64, now: i64) -> Result<Hlc> {
    let (last_physical, last_counter) = read_state(conn)?;
    let physical_ms = now.max(last_physical);
    let counter = if physical_ms == last_physical { last_counter + 1 } else { 0 };
    write_state(conn, physical_ms, counter)?;
    Ok(Hlc { physical_ms, counter, device_number })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReceiveResult {
    pub hlc: Hlc,
    /// True when the remote clock was implausibly far ahead and got clamped (FR-033).
    pub clamped: bool,
}

/// The standard HLC merge rule, applied whenever this device applies a peer's oplog entry.
pub fn receive(conn: &Connection, device_number: i64, remote: Hlc) -> Result<ReceiveResult> {
    receive_at(conn, device_number, remote, now_ms())
}

pub fn receive_at(conn: &Connection, device_number: i64, remote: Hlc, now: i64) -> Result<ReceiveResult> {
    let clamped = remote.physical_ms - now > MAX_CLOCK_DRIFT_MS;
    let effective_remote_ms = if clamped { now + MAX_CLOCK_DRIFT_MS } else { remote.physical_ms };

    let (last_physical, last_counter) = read_state(conn)?;
    let physical_ms = last_physical.max(effective_remote_ms).max(now);

    let counter = if physical_ms == last_physical && physical_ms == effective_remote_ms {
        last_counter.max(remote.counter) + 1
    } else if physical_ms == last_physical {
        last_counter + 1
    } else if physical_ms == effective_remote_ms {
        remote.counter + 1
    } else {
        0
    };

    write_state(conn, physical_ms, counter)?;
    Ok(ReceiveResult { hlc: Hlc { physical_ms, counter, device_number }, clamped })
}

pub fn compare_hlc(a: &Hlc, b: &Hlc) -> Ordering {
    a.physical_ms
        .cmp(&b.physical_ms)
        .then(a.counter.cmp(&b.counter))
        .then(a.device_number.cmp(&b.device_number))
}

/// True when `a` is strictly later than `b`.
pub fn hlc_after(a: &Hlc, b: &Hlc) -> bool {
    compare_hlc(a, b) == Ordering::Greater
}
