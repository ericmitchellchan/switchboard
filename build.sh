#!/usr/bin/env bash
# macOS / Linux equivalent of build.ps1.
#   ./build.sh           → quick `cargo check` (default)
#   ./build.sh --full    → production tauri build (DMG on macOS, .deb/.AppImage on Linux)
set -euo pipefail
cd "$(dirname "$0")"

if [ "${1:-}" = "--full" ]; then
  KEY_PATH="$HOME/.tauri/switchboard.key"
  if [ -f "$KEY_PATH" ]; then
    TAURI_SIGNING_PRIVATE_KEY=$(cat "$KEY_PATH")
    export TAURI_SIGNING_PRIVATE_KEY
    echo "Signing key loaded from $KEY_PATH"
  else
    echo "Warning: No signing key found at $KEY_PATH — build will not be signed"
    echo "Generate one with: pnpm tauri signer generate -w $KEY_PATH"
  fi
  pnpm tauri build
else
  cd src-tauri
  cargo check
fi
