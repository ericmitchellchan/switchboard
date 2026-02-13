let tauriLog: typeof import("@tauri-apps/plugin-log") | null = null;
let initPromise: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = import("@tauri-apps/plugin-log")
      .then((mod) => {
        tauriLog = mod;
      })
      .catch(() => {
        // Plugin not available (e.g. Vite-only dev) — fall back to console
        tauriLog = null;
      });
  }
  return initPromise;
}

// Fire-and-forget log helpers that fall back to console if plugin unavailable
export const log = {
  debug(msg: string) {
    if (tauriLog) {
      tauriLog.debug(msg).catch(() => {});
    } else {
      console.debug(`[DEBUG] ${msg}`);
    }
  },
  info(msg: string) {
    if (tauriLog) {
      tauriLog.info(msg).catch(() => {});
    } else {
      console.info(`[INFO] ${msg}`);
    }
  },
  warn(msg: string) {
    if (tauriLog) {
      tauriLog.warn(msg).catch(() => {});
    } else {
      console.warn(`[WARN] ${msg}`);
    }
  },
  error(msg: string) {
    if (tauriLog) {
      tauriLog.error(msg).catch(() => {});
    } else {
      console.error(`[ERROR] ${msg}`);
    }
  },
};

/** Call once at app startup to pipe Rust-side logs into browser devtools */
export async function initLogger(): Promise<void> {
  await ensureInit();
  if (tauriLog) {
    await tauriLog.attachConsole();
  }
}
