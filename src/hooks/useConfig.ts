import { useState, useEffect } from "react";
import type { Config } from "../types";
import { getConfig } from "../lib/ipc";

const DEFAULT_CONFIG: Config = {
  font: "JetBrains Mono",
  font_size: 13,
  shell: "powershell.exe",
  repos: [],
};

export function useConfig() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch(() => {
        // Use defaults on error
      });
  }, []);

  return config;
}
