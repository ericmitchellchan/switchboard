// THE QUESTION TAB (SWIT-51, R3 rule 1) — the one write-back channel besides
// the composer. The agent's `ask` opened this tab; picking an option (or
// typing) writes the answer to answers.json FIRST (durability — a failed
// terminal write never loses what Eric typed), then types it into the
// thread's terminal as HIS message and the tab closes itself. With no live
// terminal the answer is saved on the page and the tab stays and says so
// (Ky's rule verbatim).
//
// The question's TEXT lives on the page (pageStore) — this artifact carries
// ids only, so a restored tab whose question was answered meanwhile renders
// the answered state instead of re-asking.
//
// SKIN (SWIT-57): the kit's QUESTION BLOCK — the question · options as a
// plain LIST (one row per option, the row IS the target, ↑/↓/Tab move, Enter
// picks) · one input · one quiet action. No glyph box, no bordered pills, no
// sentence about where the answer goes: that sentence is requirements.md R4's,
// not the tab's. Outcome states are one plain line. Everything here traces to
// design/wireframe-kit/components.md (list row, textarea, quiet button).

import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Artifact } from "../../types";
import { usePage } from "../../lib/pageStore";
import { answerQuestion, closeArtifactByIdentity, artifactIdentity, getActiveTabSession } from "../../lib/panelStore";

const MONO = "var(--font-mono)";

/** kit: list row (content-body variant, `5px 8px`). */
const OPTION_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "5px 8px",
  background: "none",
  border: "none",
  boxShadow: "none",
  color: "var(--text-secondary)",
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.5,
  textAlign: "left",
  cursor: "pointer",
  outline: "none",
};

/** kit: textarea. Transparent — the field takes the panel's surface. */
const FIELD: CSSProperties = {
  width: "100%",
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-primary)",
  fontFamily: MONO,
  fontSize: 11.5,
  lineHeight: 1.5,
  padding: "5px 8px",
  outline: "none",
  resize: "vertical",
};

/** kit: quiet button. */
const QUIET: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-secondary)",
  fontFamily: MONO,
  fontSize: 11,
  padding: "3px 10px",
  cursor: "pointer",
};

type QuestionArtifact = Extract<Artifact, { kind: "question" }>;

export function QuestionView({ artifact, active }: { artifact: QuestionArtifact; active: boolean }) {
  const { threadId, questionId } = artifact;
  const { page } = usePage(threadId, active);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [fieldFocus, setFieldFocus] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const open = page.openQuestions.find((q) => q.id === questionId);
  const answered = page.answeredQuestions.find((a) => a.question.id === questionId);

  const submit = async (text: string) => {
    const clean = text.trim();
    if (clean.length === 0 || busy || !open) return;
    setBusy(true);
    setNote(null);
    try {
      const outcome = await answerQuestion(threadId, questionId, open.text, clean);
      if (outcome === "sent") {
        // Written on the page AND typed into the terminal — the tab's job is
        // done. Close SELF (the host session's strip holds this identity).
        const host = getActiveTabSession();
        if (host) closeArtifactByIdentity(host, artifactIdentity(artifact));
      } else {
        setNote("saved on the page — no live terminal");
      }
    } catch (err) {
      // The WRITE failed: nothing was typed, the text stays in the box.
      setNote(`could not save: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  // ↑/↓ walk the option rows and on into the input (the kit's
  // keyboard-selectable list). Only the rows dispatch here — inside the
  // textarea the arrows move the caret and stay the textarea's.
  const moveFocus = (e: KeyboardEvent, dir: 1 | -1) => {
    const root = rootRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-kit-row], textarea"));
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    const next = nodes[i + dir];
    if (!next) return;
    e.preventDefault();
    next.focus();
  };

  if (!open && !answered) {
    return (
      <Centered>
        <span style={{ color: "var(--text-secondary)" }}>This question is no longer on the page.</span>
      </Centered>
    );
  }

  if (answered) {
    return (
      <Centered>
        <span style={{ fontSize: 12, color: "var(--text-secondary)", maxWidth: 420 }}>
          {answered.question.text}
        </span>
        <span style={{ color: "var(--text-primary)" }}>
          <span style={{ color: "var(--text-dim)" }}>you: </span>
          {answered.answer.text}
        </span>
      </Centered>
    );
  }

  const canSend = !busy && draft.trim().length > 0;

  return (
    <div
      ref={rootRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: 14,
        fontFamily: MONO,
        fontSize: 11.5,
        color: "var(--text-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.5 }}>{open!.text}</div>

      {open!.options.length > 0 && (
        <div
          role="listbox"
          aria-label="Options"
          style={{ display: "flex", flexDirection: "column" }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") moveFocus(e, 1);
            else if (e.key === "ArrowUp") moveFocus(e, -1);
          }}
        >
          {open!.options.map((o) => (
            <OptionRow key={o} label={o} disabled={busy} onPick={() => void submit(o)} />
          ))}
        </div>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFieldFocus(true)}
        onBlur={() => setFieldFocus(false)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter newline — the composer's own rule.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit(draft);
          }
          e.stopPropagation();
        }}
        placeholder={open!.options.length > 0 ? "or type your own…" : "type your answer…"}
        rows={2}
        disabled={busy}
        style={{ ...FIELD, borderColor: fieldFocus ? "var(--text-dim)" : "var(--border-subtle)" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {note && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{note}</span>}
        <button
          type="button"
          style={{ ...QUIET, marginLeft: "auto", opacity: canSend ? 1 : 0.4, cursor: canSend ? "pointer" : "default" }}
          disabled={!canSend}
          onClick={() => void submit(draft)}
        >
          answer
        </button>
      </div>
    </div>
  );
}

/** One option = one list row. Hover fills `--bg-active`; keyboard focus draws
 *  the active bar (the kit's selected-row mark), so ↑/↓ shows where you are. */
function OptionRow({ label, disabled, onPick }: { label: string; disabled: boolean; onPick: () => void }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return (
    <button
      type="button"
      role="option"
      aria-selected={focus}
      data-kit-row=""
      disabled={disabled}
      onClick={onPick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        ...OPTION_ROW,
        background: hover || focus ? "var(--bg-active)" : "none",
        boxShadow: focus ? "inset 2px 0 0 var(--text-primary)" : "none",
        color: hover || focus ? "var(--text-primary)" : "var(--text-secondary)",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 24,
        textAlign: "center",
        fontFamily: MONO,
        fontSize: 11,
        color: "var(--text-dim)",
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
