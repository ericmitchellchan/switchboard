# Switchboard Release Process

## In-App Self-Update (how it works)

The app checks the updater endpoint (`plugins.updater.endpoints` in
`src-tauri/tauri.conf.json` → the GitHub release asset
`https://github.com/ericmitchellchan/switchboard/releases/latest/download/latest.json`)
**on launch and every 6 hours**. Nothing downloads or installs automatically.

- Update available → a small chip appears in the status bar:
  `update vX.Y.Z — restart to install`
- Click the chip → the update downloads (progress shown on the chip), installs,
  and the app relaunches (`tauri-plugin-process`).
- Download/install failure → the chip dims to `update failed — retry`
  (clickable; hover shows the error). The app is never blocked.
- Background **check** failures are silent (logged only) — with a private repo
  or no network the check fails every launch, and a permanent error chip would
  be noise.

Code: `src/lib/updaterState.ts` (pure state machine, unit-tested),
`src/lib/updater.ts` (plugin calls + 6h loop), `src/components/UpdateChip.tsx`.

> **IMPORTANT — repo visibility**: the repo is currently **PRIVATE**, and the
> Tauri updater cannot authenticate against private GitHub release assets, so
> the endpoint 404s and self-update stays dormant (silent, by design). It
> activates as soon as either:
> 1. **The repo goes public** — zero further work; releases just work.
> 2. **Release assets move to a public host** (S3/R2/GitHub Pages/etc.) — repo
>    stays private, but the release workflow must upload `latest.json`, the
>    installer, and `.sig` there, and the endpoint in `tauri.conf.json` must
>    change.
>
> Pick one; no proxy service — that's overkill for a personal app.

## 1. Signing Keys (ALREADY GENERATED — do not regenerate)

The keypair exists (generated Feb 2026):
- `~/.tauri/switchboard.key` — **private key. NEVER commit it.** Regenerating
  it would orphan every installed copy (the public key baked into shipped
  builds would no longer match).
- `~/.tauri/switchboard.key.pub` — public key; its contents are already in
  `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.

If you ever DO need a fresh keypair (key lost/compromised):

```powershell
pnpm tauri signer generate -w $env:USERPROFILE\.tauri\switchboard.key
```

then update `pubkey` in `tauri.conf.json` and ship a manually-installed
release, since old installs can't verify the new signature.

### Key custody checklist

- [ ] Copy `~/.tauri/switchboard.key` (and its password, if one was set) into
      the password manager — the local file is the only copy.
- [ ] Add GitHub Actions secrets (below) so tagged releases sign in CI.
- [ ] Confirm the key is not in any repo (`git log -p --all -- '*switchboard.key*'`).

## 2. GitHub Secrets

Add these secrets to the repository at Settings → Secrets → Actions
(`.github/workflows/release.yml` already reads them):

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
3. Build, create a GitHub release with the new artifacts (`latest.json`,
   installer, `.sig`) — on a host the installed app can reach (see the repo
   visibility note above)
4. Launch the installed v0.1.0 — the status bar should show the
   `update v0.1.1 — restart to install` chip
5. Click the chip — download progress shows on the chip, then the app
   installs and relaunches
6. After relaunch, verify the version is v0.1.1

## Version Bumping

Update version in **both** files before tagging:
- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version` (under `[package]`)
