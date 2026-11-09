//! Base-36 fractional ordering keys (`lexorank.ts`), used as `sync_order`.

use crate::{Result, SyncError};

const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const BASE: i64 = 36;

fn digit_value(c: u8) -> Result<i64> {
    ALPHABET
        .iter()
        .position(|a| *a == c)
        .map(|p| p as i64)
        .ok_or_else(|| SyncError::Message(format!("lexorank: invalid character \"{}\"", c as char)))
}

/// A key that sorts strictly between `lower` and `upper`; `None` means unbounded on that side.
pub fn key_between(lower: Option<&str>, upper: Option<&str>) -> Result<String> {
    if let (Some(l), Some(u)) = (lower, upper) {
        if l >= u {
            return Err(SyncError::Message(format!(
                "lexorank.keyBetween: lower ({l}) must sort strictly before upper ({u})"
            )));
        }
    }
    let lo: Vec<i64> = lower.unwrap_or("").bytes().map(digit_value).collect::<Result<_>>()?;
    let hi: Option<Vec<i64>> = match upper {
        Some(u) => Some(u.bytes().map(digit_value).collect::<Result<_>>()?),
        None => None,
    };

    let mut result: Vec<i64> = Vec::new();
    let mut bounded_above = hi.is_some();
    let mut i = 0usize;
    loop {
        let lo_d = lo.get(i).copied().unwrap_or(0);
        let hi_d = match (&hi, bounded_above) {
            (Some(h), true) => h.get(i).copied().unwrap_or(BASE),
            _ => BASE,
        };
        if hi_d - lo_d >= 2 {
            result.push(lo_d + (hi_d - lo_d) / 2);
            break;
        }
        result.push(lo_d);
        if hi_d - lo_d == 1 {
            bounded_above = false;
        }
        i += 1;
    }
    Ok(result.into_iter().map(|d| ALPHABET[d as usize] as char).collect())
}

pub fn initial_key() -> Result<String> {
    key_between(None, None)
}

/// `count` strictly increasing keys.
pub fn generate_ordered_keys(count: usize) -> Result<Vec<String>> {
    let mut keys: Vec<String> = Vec::with_capacity(count);
    for _ in 0..count {
        let key = key_between(keys.last().map(String::as_str), None)?;
        keys.push(key);
    }
    Ok(keys)
}
