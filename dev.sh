#!/usr/bin/env bash
# macOS / Linux equivalent of dev.ps1. No MSVC env needed — Rust toolchain
# comes from rustup (cargo on PATH) and pnpm is invoked directly.
set -euo pipefail
cd "$(dirname "$0")"
pnpm tauri dev
