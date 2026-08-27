/**
 * Research freshness chip (T14): one line saying which build a research
 * surface is reading and from what data window — "thin evidence is stated,
 * not hidden" applies to STALENESS too. Fetches /research/status once per
 * mount (cheap; the endpoint reads build_meta only).
 */

import { useEffect, useState } from "react";
import { api, type ResearchStatus } from "../../api/client";

export default function ResearchStatusChip({ dataset }: { dataset: string }) {
  const [status, setStatus] = useState<ResearchStatus | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getResearchStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // staleness must never silently disappear (review F9)
  if (failed) return <span className="font-mono text-[9px] text-dim">freshness unknown</span>;
  const row = status?.datasets.find((d) => d.dataset === dataset);
  if (!status) return null;
  if (!row) {
    return (
      <span className="font-mono text-[9px] text-dn" title={`dataset '${dataset}' has not been built`}>
        not built — run build_research
      </span>
    );
  }
  // built_at is naive-UTC text ("2026-07-02 21:04:11.…"); parse it AS UTC —
  // local-time parsing showed "built -1d ago" in UTC-negative zones (review F9).
  const builtMs = new Date(row.built_at.replace(" ", "T") + "Z").getTime();
  const builtDays = Math.max(0, Math.floor((Date.now() - builtMs) / 86_400_000));
  return (
    <span
      className="font-mono text-[9px] text-dim"
      title={`built ${row.built_at} · ${row.rows.toLocaleString()} rows`}
    >
      {row.data_window} · built {builtDays === 0 ? "today" : `${builtDays}d ago`}
    </span>
  );
}
