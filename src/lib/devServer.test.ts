import { describe, it, expect, beforeEach } from "vitest";
import {
  detectDevServerUrl,
  detectDevServerUrls,
  stripAnsi,
  parseManualUrl,
  noteDevServerOutput,
  devServerOfferFor,
  clearDevServerOffer,
  clearDevServerSession,
  registerSessionDir,
  sessionDirFor,
  setPreviewOpenCheck,
  __resetDevServerForTests,
} from "./devServer";

const ESC = "\u001b";
const SID = "session-1";

// ── REAL banners ─────────────────────────────────────────────────────────────
// Everything below is what the tool actually prints, transcribed from its
// output (ANSI variants included where the tool colours its banner). These are
// the fixtures the pattern set is calibrated against — if a pattern changes,
// these are what must still pass.

const VITE_PLAIN = [
  "",
  "  VITE v5.2.11  ready in 431 ms",
  "",
  "  ➜  Local:   http://localhost:5173/",
  "  ➜  Network: use --host to expose",
  "  ➜  press h + enter to show help",
].join("\r\n");

// Vite colours the arrow, bolds the label AND bolds the PORT — mid-URL. This
// is the sample that makes ANSI stripping load-bearing rather than cosmetic.
const VITE_ANSI = [
  "",
  `  ${ESC}[32mVITE v5.2.11${ESC}[39m  ${ESC}[2mready in 431 ms${ESC}[22m`,
  "",
  `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`,
  `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mNetwork${ESC}[22m: ${ESC}[2muse --host to expose${ESC}[22m`,
].join("\r\n");

const NEXT_PLAIN = [
  "   ▲ Next.js 14.2.3",
  "   - Local:        http://localhost:3000",
  "   - Environments: .env.local",
  "",
  " ✓ Ready in 2.1s",
].join("\r\n");

const NEXT_ANSI = [
  `   ${ESC}[1m▲ Next.js 14.2.3${ESC}[22m`,
  `   ${ESC}[2m- Local:${ESC}[22m        http://localhost:3000`,
].join("\r\n");

const UVICORN =
  "INFO:     Started server process [24512]\r\n" +
  "INFO:     Waiting for application startup.\r\n" +
  "INFO:     Application startup complete.\r\n" +
  "INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)\r\n";

const PY_HTTP_IPV4 = "Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...\r\n";
const PY_HTTP_IPV6 = "Serving HTTP on :: port 8000 (http://[::]:8000/) ...\r\n";

const WEBPACK = [
  "<i> [webpack-dev-server] Project is running at:",
  "<i> [webpack-dev-server] Loopback: http://localhost:8080/",
  "<i> [webpack-dev-server] On Your Network (IPv4): http://10.0.0.42:8080/",
  "<i> [webpack-dev-server] Content not from webpack is served from 'public'",
].join("\r\n");

const CRA = [
  "Compiled successfully!",
  "",
  "You can now view app in the browser.",
  "",
  "  Local:            http://localhost:3000",
  "  On Your Network:  http://192.168.1.14:3000",
].join("\r\n");

const DJANGO =
  "Starting development server at http://127.0.0.1:8000/\r\nQuit the server with CTRL-BREAK.\r\n";

describe("stripAnsi", () => {
  it("removes SGR sequences including ones inside a URL", () => {
    expect(stripAnsi(`http://localhost:${ESC}[1m5173${ESC}[22m/`)).toBe("http://localhost:5173/");
  });

  it("removes OSC hyperlink wrappers", () => {
    expect(stripAnsi(`${ESC}]8;;http://localhost:3000${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("Local:   http://localhost:5173/")).toBe("Local:   http://localhost:5173/");
  });
});

describe("detectDevServerUrl — real banners", () => {
  it("vite (plain)", () => {
    expect(detectDevServerUrl(VITE_PLAIN)).toBe("http://localhost:5173/");
  });

  it("vite (ANSI, port bolded mid-URL)", () => {
    expect(detectDevServerUrl(VITE_ANSI)).toBe("http://localhost:5173/");
  });

  it("next.js (plain)", () => {
    expect(detectDevServerUrl(NEXT_PLAIN)).toBe("http://localhost:3000/");
  });

  it("next.js (ANSI)", () => {
    expect(detectDevServerUrl(NEXT_ANSI)).toBe("http://localhost:3000/");
  });

  it("uvicorn — trailing '(Press CTRL+C to quit)' is not part of the URL", () => {
    expect(detectDevServerUrl(UVICORN)).toBe("http://127.0.0.1:8000/");
  });

  it("python http.server on 0.0.0.0 normalizes the wildcard bind to localhost", () => {
    expect(detectDevServerUrl(PY_HTTP_IPV4)).toBe("http://localhost:8000/");
  });

  it("python http.server on :: normalizes the IPv6 wildcard too", () => {
    expect(detectDevServerUrl(PY_HTTP_IPV6)).toBe("http://localhost:8000/");
  });

  it("webpack-dev-server takes the Loopback line, never the LAN one", () => {
    expect(detectDevServerUrls(WEBPACK)).toEqual(["http://localhost:8080/"]);
  });

  it("create-react-app ignores the On Your Network address", () => {
    expect(detectDevServerUrls(CRA)).toEqual(["http://localhost:3000/"]);
  });

  it("django keeps its trailing slash and drops the following sentence", () => {
    expect(detectDevServerUrl(DJANGO)).toBe("http://127.0.0.1:8000/");
  });

  it("keeps a path when the server announces one", () => {
    expect(detectDevServerUrl("Local: http://localhost:4321/admin/")).toBe(
      "http://localhost:4321/admin/"
    );
  });

  it("preserves an https scheme (vite --https)", () => {
    expect(detectDevServerUrl("  ➜  Local:   https://localhost:5173/")).toBe(
      "https://localhost:5173/"
    );
  });

  it("keeps [::1] verbatim (a specific address, not a wildcard bind)", () => {
    expect(detectDevServerUrl("listening on http://[::1]:4000/")).toBe("http://[::1]:4000/");
  });
});

describe("detectDevServerUrl — what it refuses", () => {
  it("no port", () => {
    expect(detectDevServerUrl("open http://localhost/ in a browser")).toBeNull();
  });

  it("no scheme", () => {
    expect(detectDevServerUrl("server started on localhost:5173")).toBeNull();
  });

  it("a non-loopback host", () => {
    expect(detectDevServerUrl("deployed to https://switchboard.example.com:443/")).toBeNull();
  });

  it("a LAN address alone", () => {
    expect(detectDevServerUrl("Network: http://192.168.1.14:3000")).toBeNull();
  });

  it("port 0 and out-of-range ports", () => {
    expect(detectDevServerUrl("http://localhost:0/")).toBeNull();
    expect(detectDevServerUrl("http://localhost:99999/")).toBeNull();
  });

  it("empty and non-string input", () => {
    expect(detectDevServerUrl("")).toBeNull();
    expect(detectDevServerUrl(undefined as unknown as string)).toBeNull();
  });

  it("ordinary compiler noise", () => {
    expect(detectDevServerUrl("error TS2345: Argument of type 'string' file.ts(5,10)")).toBeNull();
  });
});

describe("parseManualUrl", () => {
  it("a bare port", () => {
    expect(parseManualUrl("3000")).toBe("http://localhost:3000/");
    expect(parseManualUrl(":8080")).toBe("http://localhost:8080/");
  });

  it("host:port", () => {
    expect(parseManualUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(parseManualUrl("127.0.0.1:8000/admin")).toBe("http://127.0.0.1:8000/admin");
  });

  it("a full URL round-trips", () => {
    expect(parseManualUrl("http://localhost:5173/cases")).toBe("http://localhost:5173/cases");
  });

  it("a non-loopback host is allowed (the user typed it)", () => {
    expect(parseManualUrl("http://box.local:9000")).toBe("http://box.local:9000/");
  });

  it("normalizes a wildcard bind", () => {
    expect(parseManualUrl("0.0.0.0:8000")).toBe("http://localhost:8000/");
  });

  it("refuses junk", () => {
    expect(parseManualUrl("pnpm dev")).toBeNull();
    expect(parseManualUrl("")).toBeNull();
    expect(parseManualUrl("   ")).toBeNull();
    expect(parseManualUrl("switchboard")).toBeNull();
    expect(parseManualUrl("file:///c:/tmp/x.html")).toBeNull();
    expect(parseManualUrl("0")).toBeNull();
  });
});

describe("offer store", () => {
  beforeEach(() => {
    __resetDevServerForTests();
  });

  it("records an offer from a banner", () => {
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBe("http://localhost:5173/");
  });

  it("offers nothing for a session with no dev server", () => {
    noteDevServerOutput(SID, "$ git status\r\nnothing to commit\r\n");
    expect(devServerOfferFor(SID)).toBeNull();
  });

  it("stitches a URL split across two PTY chunks", () => {
    noteDevServerOutput(SID, "  ➜  Local:   http://local");
    expect(devServerOfferFor(SID)).toBeNull();
    noteDevServerOutput(SID, "host:5173/\r\n");
    expect(devServerOfferFor(SID)).toBe("http://localhost:5173/");
  });

  it("does not re-offer the same URL after it is dismissed (HMR reprints the banner)", () => {
    noteDevServerOutput(SID, VITE_PLAIN);
    clearDevServerOffer(SID);
    expect(devServerOfferFor(SID)).toBeNull();
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBeNull();
  });

  it("offers a NEW port after a restart picked a different one", () => {
    noteDevServerOutput(SID, VITE_PLAIN);
    clearDevServerOffer(SID);
    noteDevServerOutput(SID, "  ➜  Local:   http://localhost:5174/\r\n");
    expect(devServerOfferFor(SID)).toBe("http://localhost:5174/");
  });

  it("keeps sessions independent", () => {
    noteDevServerOutput("a", VITE_PLAIN);
    expect(devServerOfferFor("b")).toBeNull();
    expect(devServerOfferFor(null)).toBeNull();
  });

  it("forgets a closed session", () => {
    noteDevServerOutput(SID, VITE_PLAIN);
    clearDevServerSession(SID);
    expect(devServerOfferFor(SID)).toBeNull();
  });

  it("carries the session's working dir", () => {
    registerSessionDir(SID, "C:\\Users\\ericm\\projects\\lodestar");
    expect(sessionDirFor(SID)).toBe("C:\\Users\\ericm\\projects\\lodestar");
    expect(sessionDirFor("nope")).toBe("");
    expect(sessionDirFor(null)).toBe("");
  });
});

// ── "already framed" suppression ─────────────────────────────────────────────
// The anti-nag memory is per-SESSION `seen`, which cannot cover the two cases
// that actually annoyed: a server restart in a session whose offer was already
// taken, and a second tab announcing a port the first tab is already framing.
// The panel store answers "is this on screen?" through an injected check.
describe("offer store — a URL already being previewed", () => {
  beforeEach(() => {
    __resetDevServerForTests();
  });

  it("does not offer a URL that is already framed", () => {
    setPreviewOpenCheck((url) => url === "http://localhost:5173/");
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBeNull();
  });

  it("still offers a DIFFERENT port while one is framed", () => {
    setPreviewOpenCheck((url) => url === "http://localhost:5173/");
    noteDevServerOutput(SID, "  ➜  Local:   http://localhost:5174/\r\n");
    expect(devServerOfferFor(SID)).toBe("http://localhost:5174/");
  });

  it("suppresses the offer in a SECOND session too — a port is machine-wide", () => {
    setPreviewOpenCheck((url) => url === "http://localhost:5173/");
    noteDevServerOutput("tab-a", VITE_PLAIN);
    noteDevServerOutput("tab-b", VITE_PLAIN);
    expect(devServerOfferFor("tab-a")).toBeNull();
    expect(devServerOfferFor("tab-b")).toBeNull();
  });

  it("remembers the suppressed URL, so closing the preview does not resurrect the banner", () => {
    setPreviewOpenCheck(() => true);
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBeNull();
    // Preview closed; the SAME banner reprints. `seen` already holds it.
    setPreviewOpenCheck(() => false);
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBeNull();
  });

  it("offers normally when no check is wired", () => {
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBe("http://localhost:5173/");
  });

  it("a throwing check degrades to OFFERING, never to silent detection", () => {
    setPreviewOpenCheck(() => {
      throw new Error("panel store exploded");
    });
    noteDevServerOutput(SID, VITE_PLAIN);
    expect(devServerOfferFor(SID)).toBe("http://localhost:5173/");
  });
});
