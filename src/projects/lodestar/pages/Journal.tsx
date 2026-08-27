/**
 * Journal — the Stage-A capture surface. Lists entries (auto-captured per sim
 * trade + manual notes) and a write form. Read + journal only.
 */

import { useState } from "react";
import Panel from "../components/Panel";
import { usePoll } from "../hooks/usePoll";
import { api } from "../api/client";

export default function Journal() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const { data: entries } = usePoll(api.getJournal, 2000);

  const submit = async (): Promise<void> => {
    if (!text.trim()) return;
    setStatus("saving…");
    try {
      const entry = await api.writeJournal({ text: text.trim(), tags: ["manual"] });
      setStatus(`saved ${entry.entry_id}`);
      setText("");
    } catch (err) {
      setStatus(`error: ${String(err)}`);
    }
  };

  const ordered = entries ? [...entries].reverse() : [];

  return (
    <div className="space-y-4">
      <h1 className="font-mono text-lg font-medium tracking-tight">Journal</h1>

      <Panel title="new note">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="What happened, and why?"
          className="w-full rounded border border-line bg-bg px-2 py-1 text-sm text-text placeholder:text-dim focus:border-accent focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim()}
            className="rounded bg-accent px-3 py-1 text-xs font-medium text-bg disabled:opacity-40"
          >
            Save note
          </button>
          {status ? <span className="font-mono text-xs text-dim">{status}</span> : null}
        </div>
      </Panel>

      <Panel title={`entries (${ordered.length})`}>
        {ordered.length > 0 ? (
          <ul className="space-y-2">
            {ordered.map((e) => (
              <li key={e.entry_id} className="border-b border-line/50 pb-2 last:border-0">
                <div className="flex items-center gap-2 font-mono text-xs text-dim">
                  <span className="uppercase text-liq">{e.kind}</span>
                  {e.tags.map((t) => (
                    <span key={t} className="rounded bg-surface2 px-1.5 py-0.5">
                      {t}
                    </span>
                  ))}
                  {e.trade_ref ? <span className="ml-auto">{e.trade_ref}</span> : null}
                </div>
                <div className="mt-1 text-sm text-text">{e.text ?? "—"}</div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-sm text-dim">no journal entries yet</div>
        )}
      </Panel>
    </div>
  );
}
