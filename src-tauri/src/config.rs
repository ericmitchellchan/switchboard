use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RepoConfig {
    pub path: String,
    pub color: String,
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_font")]
    pub font: String,
    #[serde(default = "default_font_size")]
    pub font_size: f64,
    #[serde(default = "default_shell")]
    pub shell: String,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
    /// Optional override for the personal knowledge-base checkout root (T6).
    /// Resolution order lives in kb.rs: env SWITCHBOARD_KB_PATH → this field →
    /// the built-in default. Absent from config.json = None.
    #[serde(default)]
    pub kb_path: Option<String>,
}

fn default_font() -> String {
    "JetBrains Mono".to_string()
}

fn default_font_size() -> f64 {
    13.0
}

fn default_shell() -> String {
    if cfg!(target_os = "macos") {
        "/bin/zsh".to_string()
    } else if cfg!(target_os = "linux") {
        "/bin/bash".to_string()
    } else {
        "powershell.exe".to_string()
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font: default_font(),
            font_size: default_font_size(),
            shell: default_shell(),
            repos: vec![],
            kb_path: None,
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("switchboard").join("config.json")
}

pub fn load_config() -> Config {
    let path = config_path();
    log::info!("Loading config from {:?}", path);
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str(&contents) {
                Ok(cfg) => cfg,
                Err(e) => {
                    log::error!("Failed to parse config: {}", e);
                    Config::default()
                }
            },
            Err(e) => {
                log::error!("Failed to read config file: {}", e);
                Config::default()
            }
        }
    } else {
        log::warn!("Config file not found at {:?}, using defaults", path);
        Config::default()
    }
}

