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
// SKIN (SWIT-57, re-cut post-0.5.0): the kit's QUESTION BLOCK — the question ·
// options as a MULTIPLE-CHOICE list (OptionRow: radio glyph `○`/`●` + the
// option in `--text-primary`, the row IS the target, ↑/↓/Tab move, Enter or
// Space picks) between two `--border` hairlines · a dim `or` · one textarea ·
// one quiet `answer` button right-aligned under it. Eric on the first cut:
// "I couldn't even tell. I thought this was just a list" — the rows were
// secondary-toned text with no affordance. No bordered pills, no sentence
// about where the answer goes: that sentence is requirements.md R4's, not the
// tab's. Outcome states are one plain line. Everything here traces to
// design/wireframe-kit/components.md (question block, list row, textarea,
// quiet button).
//
// THE DEFAULT (SWIT-58): the agent's proposal is listed FIRST (pageStore's
// orderedOptions — the file keeps the asked order) with one dim `default`
// word after it, no sentence. The question's KIND rides with the answer so a
// `convention` is appended to conventions.md by the app; the tab draws no
// kind marker — the kit has no shape for one and the outcome is the same row.

import { useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { Artifact } from "../../types";
import { usePage, orderedOptions } from "../../lib/pageStore";
import { answerQuestion, closeArtifactByIdentity, artifactIdentity, getActiveTabSession } from "../../lib/panelStore";
import { OptionRow } from "./OptionRow";

const MONO = "var(--font-mono)";

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
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fieldFocus, setFieldFocus] = useState(false);
  const [answerHover, setAnswerHover] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const open = page.openQuestions.find((q) => q.id === questionId);
  const answered = page.answeredQuestions.find((a) => a.question.id === questionId);

  const submit = async (text: string) => {
    const clean = text.trim();
    if (clean.length === 0 || busy || !open) return;
    setBusy(true);
    setChosen(text);
    setNote(null);
    try {
      const outcome = await answerQuestion(threadId, questionId, open.text, clean, open.kind);
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
      setChosen(null);
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
          style={{
            display: "flex",
            flexDirection: "column",
            // The choice block is visibly a block: one hairline above, one below.
            borderTop: "1px solid var(--border)",
            borderBottom: "1px solid var(--border)",
            padding: "4px 0",
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") moveFocus(e, 1);
            else if (e.key === "ArrowUp") moveFocus(e, -1);
          }}
        >
          {orderedOptions(open!).map((o) => (
            <OptionRow
              key={o}
              label={o}
              isDefault={o === open!.defaultOption}
              disabled={busy}
              chosen={chosen === o}
              onPick={() => void submit(o)}
            />
          ))}
        </div>
      )}

      {open!.options.length > 0 && (
        <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: -6 }}>or</div>
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
        placeholder={open!.options.length > 0 ? "type your own…" : "type your answer…"}
        rows={2}
        disabled={busy}
        style={{ ...FIELD, borderColor: fieldFocus ? "var(--text-dim)" : "var(--border-subtle)" }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {note && <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{note}</span>}
        {/* Always drawn at full strength: at 0.4 while the box was empty it
            read as absent (0.5.0). An empty submit is a no-op, so the button
            only dims while a send is in flight. */}
        <button
          type="button"
          style={{
            ...QUIET,
            marginLeft: "auto",
            opacity: busy ? 0.4 : 1,
            cursor: busy ? "default" : "pointer",
            // kit: quiet hover = text `--text-primary` + border `--text-secondary`.
            color: answerHover && canSend ? "var(--text-primary)" : "var(--text-secondary)",
            borderColor: answerHover && canSend ? "var(--text-secondary)" : "var(--border-subtle)",
          }}
          disabled={busy}
          onMouseEnter={() => setAnswerHover(true)}
          onMouseLeave={() => setAnswerHover(false)}
          onClick={() => void submit(draft)}
        >
          answer
        </button>
      </div>
    </div>
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
