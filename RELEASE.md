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
- Background **check** failures are silent (logged only) — offline, the check
  fails every launch, and a permanent error chip would be noise.

Code: `src/lib/updaterState.ts` (pure state machine, unit-tested),
`src/lib/updater.ts` (plugin calls + 6h loop), `src/components/UpdateChip.tsx`.

> **Repo visibility — RESOLVED 2026-08-02: the repo is PUBLIC.**
> `check()` sends no auth header (see `src/lib/updater.ts`), so
> `releases/latest/download/` has to be anonymously fetchable. Private + a
> token was rejected: the token would ship inside the binary, and every already
> installed copy lacks the code to send it anyway. If the repo ever goes
> private again, self-update dies silently — that is the tradeoff being bought.

## 1. Signing Keys

- `~/.tauri/switchboard.key` — **private key. NEVER commit it.**
- `~/.tauri/switchboard.key.pub` — public key; its contents go in
  `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` **verbatim** (the
  `.pub` file already holds the base64 the config wants — do not re-encode it).
- `~/.tauri/switchboard.key.password` — the key's password, read automatically
  by `build.ps1`. Outside the repo by design.

**The key is encrypted and cannot practically be made passwordless.** Tauri's
`signer generate -p ""` writes a scrypt-encrypted key that then refuses an
empty password at signing time, so "no password" is not reachable through the
CLI. The password file is the equivalent: builds sign with no ceremony, and the
secret never enters the repo.

Regenerating the keypair **orphans every installed copy** — the pubkey baked
into shipped builds no longer matches, so old installs surface an update chip
that fails signature verification on click. After a regeneration, the next
version must be installed **manually** once; self-update resumes from there.

```powershell
# only if the key is lost or compromised
node node_modules/@tauri-apps/cli/tauri.js signer generate `
  -w $env:USERPROFILE\.tauri\switchboard.key -f --ci -p "<password>"
```

Then paste `switchboard.key.pub`'s contents into `tauri.conf.json` → `pubkey`,
and write the password to `~/.tauri/switchboard.key.password`.

> Call `node node_modules/@tauri-apps/cli/tauri.js`, not `pnpm tauri` — the
> `pnpm.cmd` shim mangles empty/quoted arguments on Windows.

### Key custody checklist

- [ ] Copy `~/.tauri/switchboard.key` **and** `switchboard.key.password` into
      the password manager — the local files are the only copies.
- [ ] Add GitHub Actions secrets (below) so tagged releases sign in CI.
- [ ] Confirm the key is not in any repo (`git log -p --all -- '*switchboard.key*'`).

## 2. GitHub Secrets

Add these secrets to the repository at Settings → Secrets → Actions
(`.github/workflows/release.yml` already reads them):

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/switchboard.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose during key generation |

## 3. Cutting a Release (the local path — this is the one that works)

```powershell
# 1. bump all THREE version files (see below), commit
# 2. build + sign
.\build.ps1 -Full
# 3. verify what would be published
.\release.ps1 -DryRun
# 4. publish
.\release.ps1
```

`release.ps1` does not build. It verifies the three versions agree, finds the
signed installer, reads its `.sig`, writes `latest.json`, creates the GitHub
release, and then **fetches the endpoint the app actually reads** to confirm
the update is live. Re-running it against an existing tag re-uploads assets
with `--clobber`, so a failed publish is retryable without another cargo build.

> **The target triple must match.** `latest.json`'s platform key is derived
> from the installer name: `arm64-setup.exe` → `windows-aarch64`,
> `x64-setup.exe` → `windows-x86_64`. Eric's machine is **arm64**; an x64-only
> release is invisible to it, and invisible *silently* — the updater reports
> "no update" rather than an error.

### The CI path (`.github/workflows/release.yml`)

Tag-triggered, builds a **draft** release. The matrix covers `windows-11-arm`
(arm64), `windows-latest` (x64) and `macos-14`; `tauri-action` merges every
platform into one `latest.json`. Requires the two signing secrets in §2. Free
arm64 runners are a public-repo benefit.

## 4. Testing the Update Flow

1. Have version N installed.
2. Bump all three files to N+1, `.\build.ps1 -Full`, `.\release.ps1`.
3. Launch the installed N — the status bar shows
   `update vN+1 — restart to install` (checked at launch, then every 6h).
4. Click the chip — progress on the chip, then install + relaunch.
5. Confirm the version after relaunch.

> **The session lives inside the app.** Eric runs Claude Code in a terminal
> *inside* Switchboard, so installing an update — by the chip or by the
> installer — restarts the app and **ends any session running in it**. Never
> ask for a "close it and check" verification mid-session; verify everything
> verifiable first and leave the install as the last step.

## Version Bumping

Update the version in **all three** files before tagging — `release.ps1`
refuses to publish if they disagree:
- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version` (under `[package]`)
