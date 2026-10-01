//! SWIT-114 — A REPORT BECOMES A FINDING IN ONE CLICK.
//!
//! page.json's findings are the AGENT's (the MCP server is that file's one
//! writer). A finding the USER files from a report — `→ finding` on a report
//! or view — goes into the thread's own `findings.json`, the APP's file, and
//! the page merges the two (pageStore.mergePage). Rust holds every guard and
//! mints the id: `user-<n>`, a prefix the MCP server refuses for the agent's
//! own ids, so the two ledgers never collide. Caps mirror the agent's
//! (FINDING_* in pageStore / the server).

use serde_json::{json, Value};

pub const USER_FINDING_CAP: usize = 60;
pub const CLAIM_CAP: usize = 240;
pub const N_CAP: usize = 40;
pub const REPORT_CAP: usize = 300;
pub const VERDICTS: [&str; 4] = ["lead", "open", "fact", "dead"];
pub const ID_PREFIX: &str = "user-";

fn chars(s: &str) -> usize {
    s.chars().count()
}

/// The rows already in the file — tolerant: a non-object or a row without a
/// `user-` id drops alone; an unreadable file is an empty list.
pub fn read_rows(content: &str) -> Vec<Value> {
    let v: Value = match serde_json::from_str(content) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.get("findings")
        .and_then(|f| f.as_array())
        .map(|rows| {
            rows.iter()
                .filter(|r| {
                    r.get("id")
                        .and_then(|i| i.as_str())
                        .map(|i| i.starts_with(ID_PREFIX))
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

/// Validate one new finding's fields; the error names what is wrong.
pub fn validate(claim: &str, verdict: &str, n: Option<&str>, report: Option<&str>) -> Result<(), String> {
    let claim = claim.trim();
    if claim.is_empty() {
        return Err("a finding needs a claim".into());
    }
    if chars(claim) > CLAIM_CAP {
        return Err(format!("the claim is over {CLAIM_CAP} characters"));
    }
    if !VERDICTS.contains(&verdict) {
        return Err("the verdict is one of lead, open, fact, dead".into());
    }
    if let Some(n) = n {
        if chars(n.trim()) > N_CAP {
            return Err(format!("n is over {N_CAP} characters"));
        }
    }
    if let Some(r) = report {
        if chars(r.trim()) > REPORT_CAP {
            return Err(format!("the report address is over {REPORT_CAP} characters"));
        }
    }
    for s in [Some(claim), n, report].into_iter().flatten() {
        if s.chars().any(|c| c.is_control()) {
            return Err("a finding's text holds no control characters".into());
        }
    }
    Ok(())
}

/// The next `user-<n>`: one past the highest present (an id is never reused
/// while a higher one stands).
pub fn next_id(rows: &[Value]) -> String {
    let max = rows
        .iter()
        .filter_map(|r| r.get("id")?.as_str()?.strip_prefix(ID_PREFIX)?.parse::<u64>().ok())
        .max()
        .unwrap_or(0);
    format!("{ID_PREFIX}{}", max + 1)
}

fn opt_text(s: Option<&str>) -> Value {
    match s.map(str::trim) {
        Some(t) if !t.is_empty() => Value::String(t.to_string()),
        _ => Value::Null,
    }
}

/// Add (newest first). Refused at the cap — a ledger that silently lost its
/// oldest claim would lie (the agent's rule, SWIT-106).
pub fn add_row(
    rows: &[Value],
    claim: &str,
    verdict: &str,
    n: Option<&str>,
    report: Option<&str>,
    now: &str,
) -> Result<(String, Vec<Value>), String> {
    validate(claim, verdict, n, report)?;
    if rows.len() >= USER_FINDING_CAP {
        return Err(format!(
            "this thread already holds {USER_FINDING_CAP} of your findings; take one off first"
        ));
    }
    let id = next_id(rows);
    let row = json!({
        "id": id,
        "claim": claim.trim(),
        "verdict": verdict,
        "n": opt_text(n),
        "report": opt_text(report),
        "updatedAt": now,
    });
    let mut out = Vec::with_capacity(rows.len() + 1);
    out.push(row);
    out.extend(rows.iter().cloned());
    Ok((id, out))
}

pub fn remove_row(rows: &[Value], id: &str) -> (bool, Vec<Value>) {
    let out: Vec<Value> = rows
        .iter()
        .filter(|r| r.get("id").and_then(|i| i.as_str()) != Some(id))
        .cloned()
        .collect();
    (out.len() != rows.len(), out)
}

fn write(thread_id: &str, rows: Vec<Value>) -> Result<(), String> {
    let dir = crate::threads_data_dir()?.join(thread_id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let payload =
        serde_json::to_string_pretty(&json!({ "version": 1, "findings": rows })).map_err(|e| e.to_string())?;
    let tmp = dir.join("findings.json.tmp");
    std::fs::write(&tmp, payload).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("findings.json")).map_err(|e| e.to_string())
}

fn read(thread_id: &str) -> Result<Vec<Value>, String> {
    let file = crate::threads_data_dir()?.join(thread_id).join("findings.json");
    Ok(std::fs::read_to_string(file).map(|c| read_rows(&c)).unwrap_or_default())
}

#[tauri::command]
pub async fn add_thread_finding(
    thread_id: String,
    claim: String,
    verdict: String,
    n: Option<String>,
    report: Option<String>,
) -> Result<String, String> {
    if !crate::valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    let rows = read(&thread_id)?;
    let (id, next) = add_row(
        &rows,
        &claim,
        &verdict,
        n.as_deref(),
        report.as_deref(),
        &crate::chrono_like_now_iso(),
    )?;
    write(&thread_id, next)?;
    Ok(id)
}

#[tauri::command]
pub async fn remove_thread_finding(thread_id: String, id: String) -> Result<bool, String> {
    if !crate::valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    if !id.starts_with(ID_PREFIX) {
        return Err("only a finding you filed can be taken off here".into());
    }
    let rows = read(&thread_id)?;
    let (removed, next) = remove_row(&rows, &id);
    if removed {
        write(&thread_id, next)?;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_newest_first_minting_user_ids() {
        let (id1, rows) =
            add_row(&[], "Resting entry beats next-bar", "lead", Some("264 nights"), Some("view:gamma/v3"), "t1")
                .unwrap();
        assert_eq!(id1, "user-1");
        let (id2, rows) = add_row(&rows, "  second  ", "fact", None, Some(""), "t2").unwrap();
        assert_eq!(id2, "user-2");
        assert_eq!(rows[0]["id"], "user-2");
        assert_eq!(rows[0]["claim"], "second");
        assert_eq!(rows[0]["report"], Value::Null);
        assert_eq!(rows[1]["n"], "264 nights");
        // a removed id is not reused while a higher one stands
        let (_, rows) = remove_row(&rows, "user-1");
        let (id3, _) = add_row(&rows, "third", "open", None, None, "t3").unwrap();
        assert_eq!(id3, "user-3");
    }

    #[test]
    fn refuses_bad_fields_by_name() {
        assert!(add_row(&[], " ", "lead", None, None, "t").unwrap_err().contains("claim"));
        assert!(add_row(&[], "x", "maybe", None, None, "t").unwrap_err().contains("verdict"));
        assert!(add_row(&[], &"x".repeat(CLAIM_CAP + 1), "lead", None, None, "t").is_err());
        assert!(add_row(&[], "x", "lead", Some(&"n".repeat(N_CAP + 1)), None, "t").is_err());
        assert!(add_row(&[], "x", "lead", None, Some(&"r".repeat(REPORT_CAP + 1)), "t").is_err());
        assert!(add_row(&[], "a\u{1b}[2J", "lead", None, None, "t").is_err());
    }

    #[test]
    fn refused_at_the_cap_never_evicted() {
        let mut rows = Vec::new();
        for i in 0..USER_FINDING_CAP {
            rows = add_row(&rows, &format!("c{i}"), "open", None, None, "t").unwrap().1;
        }
        assert!(add_row(&rows, "one more", "open", None, None, "t").is_err());
    }

    #[test]
    fn reads_only_user_rows_tolerantly() {
        assert!(read_rows("not json").is_empty());
        let rows = read_rows(
            r#"{"version":1,"findings":[{"id":"user-2","claim":"a"},{"id":"f1","claim":"agent's"},"junk"]}"#,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(next_id(&rows), "user-3");
    }
}
