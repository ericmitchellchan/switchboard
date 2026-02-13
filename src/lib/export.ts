import { save } from "@tauri-apps/plugin-dialog";
import { serializeTerminal } from "./terminal";
import { writeFile } from "./ipc";

export async function exportSessionOutput(sessionId: string, sessionName: string): Promise<void> {
  const content = serializeTerminal(sessionId);
  if (!content) return;

  const safeName = sessionName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const filePath = await save({
    defaultPath: `${safeName}-${timestamp}.txt`,
    filters: [{ name: "Text", extensions: ["txt", "log"] }],
  });
  if (!filePath) return;

  await writeFile(filePath, content);
}
