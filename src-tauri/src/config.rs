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
}

fn default_font() -> String {
    "JetBrains Mono".to_string()
}

fn default_font_size() -> f64 {
    13.0
}

fn default_shell() -> String {
    "powershell.exe".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font: default_font(),
            font_size: default_font_size(),
            shell: default_shell(),
            repos: vec![],
        }
    }
}

fn config_path() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("switchboard").join("config.json")
}

pub fn load_config() -> Config {
    let path = config_path();
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
            Err(_) => Config::default(),
        }
    } else {
        Config::default()
    }
}

