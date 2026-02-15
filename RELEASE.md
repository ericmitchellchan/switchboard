# Switchboard Release Process

## 1. Generate Signing Keys (One-Time)

```powershell
pnpm tauri signer generate -w $env:USERPROFILE\.tauri\switchboard.key
```

This creates:
- `~/.tauri/switchboard.key` — private key (keep secret)
- `~/.tauri/switchboard.key.pub` — public key

Then add the updater config to `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "createUpdaterArtifacts": "v1Compatible"
  },
  "plugins": {
    "updater": {
      "pubkey": "<contents of switchboard.key.pub>",
      "endpoints": [
        "https://github.com/ericmitchellchan/switchboard/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Add `"createUpdaterArtifacts": "v1Compatible"` inside the existing `bundle` section, and add the `plugins` section at the top level.

Then uncomment the updater plugin in `src-tauri/src/lib.rs`:
```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

## 2. GitHub Secrets

Add these secrets to the repository at Settings → Secrets → Actions:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/switchboard.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose during key generation |

## 3. Trigger a Release

```bash
git tag v0.1.0
git push origin v0.1.0
```

This triggers the GitHub Actions workflow which:
1. Builds the NSIS installer (.exe)
2. Signs the update bundle
3. Generates `latest.json` for the auto-updater
4. Creates a **draft** release — review and publish manually

## 4. Local Production Build

```powershell
.\build.ps1 -Full
```

This loads the signing key from `~/.tauri/switchboard.key` and runs `pnpm tauri build`. The output installer is at:
```
src-tauri/target/release/bundle/nsis/Switchboard_0.1.0_x64-setup.exe
```

## 5. Testing the Update Flow

1. Build and install v0.1.0
2. Bump version in `package.json` and `src-tauri/tauri.conf.json` to v0.1.1
3. Build, create a GitHub release with the new artifacts
4. Launch the installed v0.1.0 — it should detect and install the update on startup
5. After relaunch, verify the version is v0.1.1

## Version Bumping

Update version in **both** files before tagging:
- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version` (under `[package]`)
