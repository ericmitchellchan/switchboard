//! SWIT-113 — IS THIS THREAD'S PAGE-TOOLS SERVER STILL THERE?
//!
//! The MCP server writes `threads/<id>/mcp.json` (`{version, pid, startedAt,
//! endedAt?}`) when it starts and stamps `endedAt` when its input closes
//! (switchboard-mcp.cjs, `startMcpRecord` / `endMcpRecord`). This command
//! reads that record and checks the pid against the process's OWN creation
//! time, so a recycled pid never reads as the server. Read-only: a file read
//! and one process handle opened for its times.

use serde::Serialize;

/// How far the server's own clock (`Date.now()` at boot) may sit after the
/// process's creation time and still name that process: node's start-up is
/// well under a second, a cold antivirus scan a few. Two minutes is generous
/// and still far tighter than pid reuse.
pub const START_SLACK_MS: u64 = 120_000;
/// Clock skew allowed the other way (creation reported after `startedAt`).
pub const START_SKEW_MS: u64 = 2_000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHealth {
    /// `none` (no record — an older server, or not started yet) · `alive` ·
    /// `ended` (it stamped its own end) · `gone` (its process is not there).
    pub state: &'static str,
    /// The record's start time, so the app can tell this launch's server
    /// from the previous one. 0 with `none`.
    pub started_at: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct McpRecord {
    pub pid: u32,
    pub started_at: u64,
    pub ended: bool,
}

/// Tolerant parse: anything malformed is no record (no claim).
pub fn parse_mcp_record(content: &str) -> Option<McpRecord> {
    let v: serde_json::Value = serde_json::from_str(content).ok()?;
    let pid = v.get("pid")?.as_u64()?;
    let started_at = v.get("startedAt")?.as_u64()?;
    if pid == 0 || pid > u32::MAX as u64 {
        return None;
    }
    Some(McpRecord {
        pid: pid as u32,
        started_at,
        ended: v.get("endedAt").map(|e| !e.is_null()).unwrap_or(false),
    })
}

/// THE judgement (pure): `facts` = the pid's (creation ms, running), None when
/// it could not be opened.
pub fn judge(record: Option<&McpRecord>, facts: Option<(u64, bool)>) -> McpHealth {
    let Some(r) = record else {
        return McpHealth { state: "none", started_at: 0 };
    };
    let state = if r.ended {
        "ended"
    } else {
        match facts {
            Some((created, true))
                if created <= r.started_at + START_SKEW_MS
                    && r.started_at.saturating_sub(created) <= START_SLACK_MS =>
            {
                "alive"
            }
            _ => "gone",
        }
    };
    McpHealth { state, started_at: r.started_at }
}

#[tauri::command]
pub async fn thread_mcp_health(thread_id: String) -> Result<McpHealth, String> {
    if !crate::valid_thread_id(&thread_id) {
        return Err("invalid thread id".into());
    }
    let path = crate::threads_data_dir()?.join(&thread_id).join("mcp.json");
    let record = match std::fs::read_to_string(&path) {
        Ok(c) => parse_mcp_record(&c),
        Err(_) => None,
    };
    let facts = record.as_ref().and_then(|r| crate::jobs::process_facts(r.pid));
    Ok(judge(record.as_ref(), facts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(ended: bool) -> McpRecord {
        McpRecord { pid: 4242, started_at: 1_000_000, ended }
    }

    #[test]
    fn no_record_is_no_claim() {
        assert_eq!(judge(None, None).state, "none");
        assert_eq!(parse_mcp_record("").is_none(), true);
        assert_eq!(parse_mcp_record("{\"pid\":0,\"startedAt\":5}").is_none(), true);
        assert_eq!(parse_mcp_record("{\"pid\":7}").is_none(), true);
    }

    #[test]
    fn parses_the_servers_record() {
        let r = parse_mcp_record("{\"version\":1,\"pid\":4242,\"startedAt\":1000000}").unwrap();
        assert_eq!(r, rec(false));
        let e = parse_mcp_record("{\"version\":1,\"pid\":4242,\"startedAt\":1000000,\"endedAt\":1000500}").unwrap();
        assert!(e.ended);
    }

    #[test]
    fn alive_only_when_the_pid_is_the_same_running_process() {
        // created 300 ms before node's own clock read: the server.
        assert_eq!(judge(Some(&rec(false)), Some((999_700, true))).state, "alive");
        // still open but exited.
        assert_eq!(judge(Some(&rec(false)), Some((999_700, false))).state, "gone");
        // a recycled pid: a process created long after (or long before) the server started.
        assert_eq!(judge(Some(&rec(false)), Some((1_500_000, true))).state, "gone");
        assert_eq!(judge(Some(&rec(false)), Some((1_000_000 - START_SLACK_MS - 1, true))).state, "gone");
        // nothing there at all.
        assert_eq!(judge(Some(&rec(false)), None).state, "gone");
    }

    #[test]
    fn an_end_the_server_stamped_wins() {
        let h = judge(Some(&rec(true)), Some((999_700, true)));
        assert_eq!(h.state, "ended");
        assert_eq!(h.started_at, 1_000_000);
    }
}
