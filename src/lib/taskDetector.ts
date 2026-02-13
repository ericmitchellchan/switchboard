interface DetectedTask {
  text: string;
  fingerprint: string;
  priority: "high" | "med" | "low";
  category: "build" | "test" | "git" | "runtime";
}

interface TaskDetectorState {
  lineBuffer: string[];
  knownFingerprints: Set<string>;
  lastDetectionTime: number;
}

const detectors = new Map<string, TaskDetectorState>();

const DEBOUNCE_MS = 2000;

export function initTaskDetector(sessionId: string): void {
  detectors.set(sessionId, {
    lineBuffer: [],
    knownFingerprints: new Set(),
    lastDetectionTime: 0,
  });
}

export function destroyTaskDetector(sessionId: string): void {
  detectors.delete(sessionId);
}

// Detection patterns (global flag for matchAll — find every occurrence in the buffer)
const RUST_ERROR = /error\[E(\d+)\].*?(?:-->|at)\s*([^\s:]+):(\d+)/g;
const RUST_ERROR_SIMPLE = /error\[E(\d+)\]/g;
const TS_ERROR = /error TS(\d+).*?([^\s(]+)\((\d+),/g;
const TS_ERROR_SIMPLE = /error TS(\d+)/g;
const TEST_FAIL = /(?:FAILED|FAIL)\s+(.+)/g;
const GIT_CONFLICT = /CONFLICT \(content\): Merge conflict in (.+)/g;

// Resolution patterns
const RUST_BUILD_SUCCESS = /Compiling.*finished|Finished/;
const TS_BUILD_SUCCESS = /Found 0 errors/;
const TEST_SUCCESS = /(?:test result: ok|Tests:.*passed|All tests passed|PASSED)/i;
const GIT_RESOLVE = /All conflicts fixed/;

export function detectTasks(sessionId: string, text: string): DetectedTask[] {
  const state = detectors.get(sessionId);
  if (!state) return [];

  const now = Date.now();
  const results: DetectedTask[] = [];

  // Add lines to buffer
  const newLines = text.split(/\r?\n/);
  state.lineBuffer.push(...newLines);
  // Keep rolling 20-line buffer
  if (state.lineBuffer.length > 20) {
    state.lineBuffer = state.lineBuffer.slice(-20);
  }

  // Debounce: skip if too soon
  if (now - state.lastDetectionTime < DEBOUNCE_MS) {
    return results;
  }

  const combined = state.lineBuffer.join("\n");

  // Rust errors — try detailed first, fall back to simple for unmatched codes
  let hasDetailedRust = false;
  for (const m of combined.matchAll(RUST_ERROR)) {
    hasDetailedRust = true;
    const [, code, file, line] = m;
    const fp = `rust:${file}:${line}:E${code}`;
    if (!state.knownFingerprints.has(fp)) {
      state.knownFingerprints.add(fp);
      state.lastDetectionTime = now;
      results.push({
        text: `Rust error E${code} at ${file}:${line}`,
        fingerprint: fp,
        priority: "high",
        category: "build",
      });
    }
  }
  if (!hasDetailedRust) {
    for (const m of combined.matchAll(RUST_ERROR_SIMPLE)) {
      const [, code] = m;
      const fp = `rust:E${code}`;
      if (!state.knownFingerprints.has(fp)) {
        state.knownFingerprints.add(fp);
        state.lastDetectionTime = now;
        results.push({
          text: `Rust error E${code}`,
          fingerprint: fp,
          priority: "high",
          category: "build",
        });
      }
    }
  }

  // TypeScript errors — same detailed-then-simple pattern
  let hasDetailedTs = false;
  for (const m of combined.matchAll(TS_ERROR)) {
    hasDetailedTs = true;
    const [, code, file] = m;
    const fp = `ts:${file}:TS${code}`;
    if (!state.knownFingerprints.has(fp)) {
      state.knownFingerprints.add(fp);
      state.lastDetectionTime = now;
      results.push({
        text: `TS error TS${code} in ${file}`,
        fingerprint: fp,
        priority: "high",
        category: "build",
      });
    }
  }
  if (!hasDetailedTs) {
    for (const m of combined.matchAll(TS_ERROR_SIMPLE)) {
      const [, code] = m;
      const fp = `ts:TS${code}`;
      if (!state.knownFingerprints.has(fp)) {
        state.knownFingerprints.add(fp);
        state.lastDetectionTime = now;
        results.push({
          text: `TypeScript error TS${code}`,
          fingerprint: fp,
          priority: "high",
          category: "build",
        });
      }
    }
  }

  // Test failures
  for (const m of combined.matchAll(TEST_FAIL)) {
    const testName = m[1].trim().substring(0, 80);
    const fp = `test:${testName}`;
    if (!state.knownFingerprints.has(fp)) {
      state.knownFingerprints.add(fp);
      state.lastDetectionTime = now;
      results.push({
        text: `Test failed: ${testName}`,
        fingerprint: fp,
        priority: "high",
        category: "test",
      });
    }
  }

  // Git conflicts
  for (const m of combined.matchAll(GIT_CONFLICT)) {
    const file = m[1].trim();
    const fp = `git:conflict:${file}`;
    if (!state.knownFingerprints.has(fp)) {
      state.knownFingerprints.add(fp);
      state.lastDetectionTime = now;
      results.push({
        text: `Merge conflict in ${file}`,
        fingerprint: fp,
        priority: "high",
        category: "git",
      });
    }
  }

  return results;
}

export function detectResolutions(sessionId: string, text: string): string[] {
  const state = detectors.get(sessionId);
  if (!state || state.knownFingerprints.size === 0) return [];

  const prefixes: string[] = [];

  if (RUST_BUILD_SUCCESS.test(text)) {
    prefixes.push("rust:");
  }
  if (TS_BUILD_SUCCESS.test(text)) {
    prefixes.push("ts:");
  }
  if (TEST_SUCCESS.test(text)) {
    prefixes.push("test:");
  }
  if (GIT_RESOLVE.test(text)) {
    prefixes.push("git:conflict:");
  }

  // Clean resolved fingerprints from known set
  for (const prefix of prefixes) {
    for (const fp of state.knownFingerprints) {
      if (fp.startsWith(prefix)) {
        state.knownFingerprints.delete(fp);
      }
    }
  }

  return prefixes;
}
