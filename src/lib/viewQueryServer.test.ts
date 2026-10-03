// SWIT-118 — the view query server (src-tauri/resources/mcp/view-query-server.py).
// Its rules and a real HTTP round trip against a temporary DuckDB file live in
// scripts/test_view_query_server.py; this file runs them (skipping ONLY when
// python itself is missing — a traceback is a failure), and checks the view
// tool's description names the server at a path that exists and that the
// installer ships it.

import { describe, it, expect } from "vitest";
import { backendErrorLine } from "./viewStore";
// @ts-expect-error — no @types/node in the frontend tsconfig; vitest's node
// runtime provides the real module (facts.test.ts's convention).
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cp = require("node:child_process") as {
  execFileSync: (f: string, a: string[], o: { encoding: string; timeout: number; stdio: unknown }) => string;
};
const fs = require("fs") as { existsSync: (p: string) => boolean; readFileSync: (p: string, e: string) => string };
const server = require("../../src-tauri/resources/mcp/switchboard-mcp.cjs") as Record<string, unknown>;

type SpawnFailure = { code?: unknown; status?: unknown; stderr?: unknown; message?: unknown };
const isPythonMissing = (err: unknown) => {
  const e = (err ?? {}) as SpawnFailure;
  return e.code === "ENOENT" || e.status === 9009;
};

function viewTool(): { description: string } {
  for (const v of Object.values(server)) {
    const list = Array.isArray(v) ? v : [v];
    for (const t of list) if (t && typeof t === "object" && (t as { name?: string }).name === "view") return t as { description: string };
  }
  throw new Error("the MCP server exports no view tool");
}

describe("the view query server", () => {
  it("scripts/test_view_query_server.py passes (skips with a note when python is unavailable)", () => {
    try {
      cp.execFileSync("python", ["scripts/test_view_query_server.py"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      if (isPythonMissing(err)) {
        console.info("[swit-118] python unavailable — the query server's tests were SKIPPED");
        return;
      }
      const e = err as SpawnFailure;
      throw new Error(`the query server's tests failed: ${String(e.message)}\n${typeof e.stderr === "string" ? e.stderr.slice(-3000) : ""}`);
    }
  }, 90_000);

  it("the view tool tells the agent how to run it, at a path that exists", () => {
    const d = viewTool().description;
    const m = d.match(/python "([^"]+view-query-server\.py)"/);
    expect(m).not.toBeNull();
    expect(fs.existsSync(m![1])).toBe(true);
    expect(d).toContain("http://127.0.0.1:8792/q/<db>/<query>");
  });

  it("a failed read's line carries the server's reason, not just the status", () => {
    expect(backendErrorLine(400, '{"error": "missing parameter: expiry"}')).toBe("the backend answered 400: missing parameter: expiry");
    expect(backendErrorLine(502, "<html>bad gateway</html>")).toBe("the backend answered 502");
    expect(backendErrorLine(422, JSON.stringify({ error: "x".repeat(500) })).length).toBeLessThan(260);
  });

  it("the installer ships it beside the MCP server", () => {
    const conf = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8")) as { bundle: { resources: string[] } };
    expect(conf.bundle.resources).toContain("resources/mcp/view-query-server.py");
  });
});
