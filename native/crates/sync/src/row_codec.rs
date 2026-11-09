//! Converts between a database row's raw columns and the oplog's field representation (`row-codec.ts`).
//!
//! A foreign key column only means something on the machine that assigned it, so every foreign key
//! travels in the oplog as the referenced row's permanent uuid and is resolved back to a local id
//! (through the alias table) only when a merge applies it.

use crate::{Result, SyncError};
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Number, Value};

/// One row as column name to JSON scalar, in column order.
pub type RowMap = Map<String, Value>;

/// Columns that exist locally but never leave this device: dense positions, and the id itself.
fn local_only_columns(table: &str) -> &'static [&'static str] {
    match table {
        "todo_states" | "todo_projects" => &["position"],
        _ => &[],
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ForeignKeySpec {
    /// The table the referenced id belongs to.
    pub ref_table: &'static str,
    /// The name this reference is carried under in the oplog, e.g. `state_id` becomes `state_uuid`.
    pub field_name: &'static str,
    pub column: &'static str,
}

/// Foreign key columns and which table their uuid resolves against. Only `todos` has any.
pub fn foreign_keys_for(table: &str) -> &'static [ForeignKeySpec] {
    const TODOS: [ForeignKeySpec; 3] = [
        ForeignKeySpec { column: "state_id", ref_table: "todo_states", field_name: "state_uuid" },
        ForeignKeySpec { column: "project_id", ref_table: "todo_projects", field_name: "project_uuid" },
        ForeignKeySpec { column: "parent_id", ref_table: "todos", field_name: "parent_uuid" },
    ];
    if table == "todos" {
        &TODOS
    } else {
        &[]
    }
}

/// Reverse lookup: oplog field name to the foreign key it carries.
pub fn foreign_key_by_field_name(table: &str, field_name: &str) -> Option<ForeignKeySpec> {
    foreign_keys_for(table).iter().find(|fk| fk.field_name == field_name).copied()
}

fn value_from_ref(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        // `scalarValue` maps anything that is not string/number/boolean/null (a Buffer) to null.
        ValueRef::Blob(_) => Value::Null,
    }
}

/// Runs a query and returns every row as a [`RowMap`].
pub fn query_rows(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Result<Vec<RowMap>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().into_iter().map(|s| s.to_string()).collect();
    let rows = stmt
        .query_map(params, |r| {
            let mut map = RowMap::new();
            for (i, name) in names.iter().enumerate() {
                map.insert(name.clone(), value_from_ref(r.get_ref(i)?));
            }
            Ok(map)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Resolves a local numeric id to its permanent uuid. `None` in, `None` out.
pub fn uuid_for_local_id(conn: &Connection, table: &str, id: Option<i64>) -> Result<Option<String>> {
    let Some(id) = id else {
        return Ok(None);
    };
    let uuid: Option<Option<String>> =
        conn.query_row(&format!("SELECT uuid FROM {table} WHERE id = ?"), [id], |r| r.get(0)).optional()?;
    Ok(uuid.flatten())
}

/// Builds the oplog `fields` map for a row. Only `changed_columns` are included; callers pass every
/// persisted column on a first publish, or just the columns a specific update touched.
pub fn encode_row_fields(
    conn: &Connection,
    table: &str,
    row: &RowMap,
    changed_columns: &[String],
) -> Result<Vec<(String, Value)>> {
    let local_only = local_only_columns(table);
    let fks = foreign_keys_for(table);
    let mut fields: Vec<(String, Value)> = Vec::new();

    for column in changed_columns {
        if column == "id" || column == "uuid" || local_only.contains(&column.as_str()) {
            continue;
        }
        let value = row.get(column).cloned().unwrap_or(Value::Null);
        if let Some(fk) = fks.iter().find(|fk| fk.column == column) {
            let uuid = uuid_for_local_id(conn, fk.ref_table, value.as_i64())?;
            fields.push((fk.field_name.to_string(), uuid.map(Value::String).unwrap_or(Value::Null)));
            continue;
        }
        fields.push((column.clone(), value));
    }
    Ok(fields)
}

/// Every persisted column for a table, for a first full publish.
pub fn all_columns_for(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(names)
}

/// Coerces an oplog field value into something SQLite binds, the way better-sqlite3 does.
///
/// A peer still on an older build, or an oplog already in the shared folder from before the
/// boolean producer fix, carries raw `true`/`false`. They bind as 1/0. Numbers bind as an integer
/// when they fit an int32 and as a double otherwise, which is how better-sqlite3 binds a JS number;
/// column affinity then decides the stored type, so rows come out identical to the TS engine's.
pub fn to_bind_value(value: &Value) -> Result<SqlValue> {
    Ok(match value {
        Value::Null => SqlValue::Null,
        Value::Bool(true) => SqlValue::Integer(1),
        Value::Bool(false) => SqlValue::Integer(0),
        Value::String(s) => SqlValue::Text(s.clone()),
        Value::Number(n) => match n.as_i64() {
            Some(i) if i >= i32::MIN as i64 && i <= i32::MAX as i64 => SqlValue::Integer(i),
            _ => SqlValue::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::Array(_) | Value::Object(_) => {
            return Err(SyncError::Message(
                "SQLite3 can only bind numbers, strings, bigints, buffers, and null".to_string(),
            ))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn booleans_bind_as_integers() {
        assert_eq!(to_bind_value(&json!(true)).unwrap(), SqlValue::Integer(1));
        assert_eq!(to_bind_value(&json!(false)).unwrap(), SqlValue::Integer(0));
        assert_eq!(to_bind_value(&json!(5)).unwrap(), SqlValue::Integer(5));
        assert_eq!(to_bind_value(&json!(3_000_000_000i64)).unwrap(), SqlValue::Real(3_000_000_000.0));
        assert!(to_bind_value(&json!({"a": 1})).is_err());
    }
}
