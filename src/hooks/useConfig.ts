import { useState, useEffect } from "react";
import type { Config } from "../types";
import { getConfig } from "../lib/ipc";
import { applyConfigShellMode } from "../lib/shellMode";

// Brief fallback if the Tauri `get_config` invoke fails before the real
// (platform-aware) default arrives from Rust. Platform-detect from UA so the
// fallback doesn't claim PowerShell on a Mac.
const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent);
const isLinux =
  typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent) && !isMac;

const DEFAULT_CONFIG: Config = {
  font: "JetBrains Mono",
  font_size: 13,
  shell: isMac ? "/bin/zsh" : isLinux ? "/bin/bash" : "powershell.exe",
  repos: [],
};

export function useConfig() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  useEffect(() => {
    getConfig()
      .then((cfg) => {
        // Shell mode is read ONCE (SWIT-55): the first config value latches;
        // a `?shell=` already on the URL has won before this resolves.
        applyConfigShellMode(cfg.shell_mode);
        setConfig(cfg);
      })
      .catch(() => {
        // Use defaults on error
      });
  }, []);

  return config;
}
