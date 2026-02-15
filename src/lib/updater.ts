import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { log } from "./logger";

export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check();
    if (!update) {
      log.debug("No update available");
      return;
    }

    log.info(
      `Update available: ${update.version} (current date: ${update.date})`
    );

    await update.downloadAndInstall();
    log.info("Update installed, relaunching");
    await relaunch();
  } catch (e) {
    // Silent failure — personal tool, no UI dialog needed
    log.warn(`Update check failed: ${e}`);
  }
}
