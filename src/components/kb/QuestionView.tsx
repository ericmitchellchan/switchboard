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

import { useState } from "react";
import type { CSSProperties } from "react";
import type { Artifact } from "../../types";
import { usePage } from "../../lib/pageStore";
import { answerQuestion, closeArtifactByIdentity, artifactIdentity, getActiveTabSession } from "../../lib/panelStore";

const MONO = "var(--font-mono)";

const OPTION_STYLE: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-subtle)",
  borderRadius: 3,
  color: "var(--text-secondary)",
  fontFamily: MONO,
  fontSize: 11,
  padding: "4px 10px",
  cursor: "pointer",
};

type QuestionArtifact = Extract<Artifact, { kind: "question" }>;

export function QuestionView({ artifact, active }: { artifact: QuestionArtifact; active: boolean }) {
  const { threadId, questionId } = artifact;
  const { page } = usePage(threadId, active);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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
        setNote(
          "saved on the page — no live terminal right now; the agent reads it when the thread is next running"
        );
      }
    } catch (err) {
      // The WRITE failed: nothing was typed, the text stays in the box.
      setNote(`could not save the answer: ${String(err)} — your text is kept here`);
    } finally {
      setBusy(false);
    }
  };

  if (!open && !answered) {
    return (
      <Centered>
        <span style={{ color: "var(--text-secondary)" }}>this question is no longer on the page</span>
        <span style={{ color: "var(--text-faint)" }}>
          the agent may have replaced it — check the ✦ page
        </span>
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
          <span style={{ color: "var(--text-dim)" }}>you answered: </span>
          {answered.answer.text}
        </span>
        <span style={{ color: "var(--text-faint)" }}>recorded on the page</span>
      </Centered>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "22px 20px",
        fontFamily: MONO,
        fontSize: 11.5,
        color: "var(--text-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span
          style={{
            flex: "none",
            width: 20,
            height: 20,
            border: "1px solid var(--text-secondary)",
            borderRadius: 3,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--text-primary)",
            fontSize: 12,
          }}
        >
          ?
        </span>
        <span style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.5 }}>
          {open!.text}
        </span>
      </div>

      {open!.options.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {open!.options.map((o) => (
            <button
              key={o}
              type="button"
              style={{ ...OPTION_STYLE, opacity: busy ? 0.5 : 1 }}
              disabled={busy}
              onClick={() => void submit(o)}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--text-primary)";
                e.currentTarget.style.borderColor = "var(--text-secondary)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-secondary)";
                e.currentTarget.style.borderColor = "var(--border-subtle)";
              }}
            >
              {o}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter newline — the composer's own rule.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit(draft);
            }
            e.stopPropagation();
          }}
          placeholder={open!.options.length > 0 ? "or type your own answer…" : "type your answer…"}
          rows={3}
          disabled={busy}
          style={{
            resize: "vertical",
            background: "var(--bg-primary)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 3,
            color: "var(--text-primary)",
            fontFamily: MONO,
            fontSize: 11.5,
            lineHeight: 1.5,
            padding: "6px 8px",
            outline: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            type="button"
            style={{ ...OPTION_STYLE, opacity: busy || draft.trim().length === 0 ? 0.5 : 1 }}
            disabled={busy || draft.trim().length === 0}
            onClick={() => void submit(draft)}
          >
            answer →
          </button>
          <span style={{ fontSize: 9.5, color: "var(--text-faint)" }}>
            the answer lands on the page and goes to the agent as your message
          </span>
        </div>
      </div>

      {note && (
        <div
          style={{
            border: "1px solid var(--border-subtle)",
            background: "var(--bg-elevated)",
            padding: "8px 10px",
            fontSize: 10.5,
            color: "var(--text-muted)",
            lineHeight: 1.5,
          }}
        >
          {note}
        </div>
      )}
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
