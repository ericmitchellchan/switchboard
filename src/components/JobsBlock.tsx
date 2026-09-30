// THE JOBS BLOCK (SWIT-109) — a thread's jobs on its ✦ page: name · last
// output line · state pill · age · stop. A row's name unfolds the log's tail
// (the last 40 lines, re-read when the last line moves). `stop` is the
// machine page's two-click arm (the first click arms it for 5 s and reads
// `confirm`, the second stops the job's whole tree through Rust). Pure
// presentation over lib/jobs.ts's store and rules; the data is App's 5s
// pass's snapshot — this component polls nothing on its own.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { jobPill, jobStateAt, publishJobs, parseJobsSnapshot, threadJobs, useJobs, JOB_LOG_LINES_DEFAULT } from "../lib/jobs";
import type { JobRow } from "../lib/jobs";
import { jobLogTail, jobStopId, jobsSnapshot } from "../lib/ipc";
import { Age, ColumnHeads, JOB_GRID, PageBlock, StatusPill } from "./kb/PageBlock";
import { MONO, TEXT_LINK } from "./kit";

const ARM_MS = 5_000;

/** The two-click stop. A failure is the button's title and one faint word. */
export function StopButton({ id, name }: { id: string; name: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  const click = async () => {
    if (busy) return;
    if (!armed) {
      setArmed(true);
      setError(null);
      timer.current = window.setTimeout(() => setArmed(false), ARM_MS);
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    try {
      await jobStopId(id);
      // Show the stop now rather than on the next 5s tick.
      publishJobs(parseJobsSnapshot(await jobsSnapshot()));
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void click()}
      disabled={busy}
      title={error ?? (armed ? `Click again to stop ${name} and everything it started` : `Stop ${name}`)}
      aria-label={armed ? `Confirm: stop ${name}` : `Stop ${name}`}
      style={{
        ...TEXT_LINK,
        marginTop: 0,
        justifySelf: "end",
        color: armed ? "var(--tone-rose)" : error ? "var(--tone-amber)" : "var(--text-faint)",
        cursor: busy ? "default" : "pointer",
      }}
    >
      {busy ? "stopping…" : armed ? "confirm" : error ? "failed" : "stop"}
    </button>
  );
}

const TAIL: CSSProperties = {
  margin: "2px 0 8px",
  maxHeight: 260,
  overflow: "auto",
  background: "var(--bg-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 8px",
  fontFamily: MONO,
  fontSize: 10.5,
  lineHeight: 1.45,
  color: "var(--text-secondary)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
};

/** The log's tail, read when the row opens and again whenever the job's
 *  last line moves (the snapshot is what notices output). */
function LogTail({ row }: { row: JobRow }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    jobLogTail(row.id, JOB_LOG_LINES_DEFAULT)
      .then((l) => {
        if (!cancelled) {
          setLines(l);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [row.id, row.lastLine, row.state]);
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--text-faint)", padding: "4px 0 2px", overflowWrap: "anywhere" }}>
        {row.command} · in {row.cwd}
      </div>
      <pre style={TAIL}>{error ?? (lines === null ? "…" : lines.length > 0 ? lines.join("\n") : "(no output yet)")}</pre>
    </div>
  );
}

function JobLine({ row }: { row: JobRow }) {
  const [open, setOpen] = useState(false);
  const pill = jobPill(row);
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="page-block-row" style={{ display: "grid", ...JOB_GRID, columnGap: 11, alignItems: "center", padding: "7px 0" }}>
        <button
          type="button"
          className="page-textlink"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Hide its output" : "Show the last lines of its output"}
          style={{
            minWidth: 0,
            textAlign: "left",
            background: "none",
            border: "none",
            padding: 0,
            fontFamily: MONO,
            fontSize: 11,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            cursor: "pointer",
          }}
        >
          {row.name}
        </button>
        <span
          title={row.lastLine || undefined}
          style={{ minWidth: 0, fontFamily: MONO, fontSize: 10.5, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {row.lastLine}
        </span>
        <span style={{ minWidth: 0 }}>
          <StatusPill word={pill.word} tone={pill.tone} />
        </span>
        <Age at={new Date(jobStateAt(row)).toISOString()} />
        {row.state === "running" ? <StopButton id={row.id} name={row.name} /> : <span />}
      </div>
      {open && <LogTail row={row} />}
    </div>
  );
}

/** The ✦ page's Jobs block — only when the thread has a job. */
export function PageJobsBlock({ threadId }: { threadId: string }) {
  const rows = threadJobs(useJobs(), threadId);
  if (rows.length === 0) return null;
  return (
    <PageBlock title="Jobs" dataPageBlock="jobs">
      <ColumnHeads grid={JOB_GRID} labels={["Job", "Last line", "State", { label: "Age", right: true }, ""]} />
      {rows.map((r) => (
        <JobLine key={r.id} row={r} />
      ))}
    </PageBlock>
  );
}
