
# Switchboard release: verify -> latest.json -> GitHub release.
#
# Assumes .\build.ps1 -Full has already produced a SIGNED bundle. This script
# does not build; it packages what the build made and publishes it, so a failed
# publish can be retried without paying for another cargo release build.
#
#   .\release.ps1              # publish the current version
#   .\release.ps1 -DryRun      # write latest.json, print the plan, publish nothing
#
# Why the pieces are here:
#  - The app checks releases/latest/download/latest.json, so latest.json must be
#    an ASSET on the newest non-prerelease release. That is the whole contract.
#  - The platform key must match the RUNNING app's target triple. Eric's machine
#    is arm64, so an x64-only release is invisible to it (silently: the updater
#    just reports no update).
#  - gh defaults to the eric-kyde account on this machine; switchboard is
#    ericmitchellchan. Wrong account = "Repository not found".

param(
    [switch]$DryRun,
    [string]$Notes = ""
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$REPO = "ericmitchellchan/switchboard"

# --- 1. Version agreement across all three files -----------------------------
$pkgVersion  = (Get-Content package.json -Raw | ConvertFrom-Json).version
$confVersion = (Get-Content src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
$cargoLine   = Select-String -Path src-tauri/Cargo.toml -Pattern '^version = "(.+)"' | Select-Object -First 1
$cargoVersion = $cargoLine.Matches[0].Groups[1].Value

if ($pkgVersion -ne $confVersion -or $pkgVersion -ne $cargoVersion) {
    Write-Error "Version mismatch - package.json=$pkgVersion tauri.conf.json=$confVersion Cargo.toml=$cargoVersion. All three must agree."
    exit 1
}
$version = $pkgVersion
$tag = "v$version"
Write-Host "Version $version (all three files agree)" -ForegroundColor Green

# --- 2. Locate the signed bundle ---------------------------------------------
$nsisDir = "src-tauri/target/release/bundle/nsis"
if (-not (Test-Path $nsisDir)) {
    Write-Error "No bundle at $nsisDir - run .\build.ps1 -Full first."
    exit 1
}

$installer = Get-ChildItem $nsisDir -Filter "*$version*-setup.exe" | Select-Object -First 1
if (-not $installer) {
    Write-Error "No installer matching *$version*-setup.exe in $nsisDir - the bundle is stale (built from a different version?). Re-run .\build.ps1 -Full."
    exit 1
}

$sigFile = "$($installer.FullName).sig"
if (-not (Test-Path $sigFile)) {
    Write-Error "No signature at $sigFile - the build did not sign. The app REFUSES an unsigned update, so publishing this would produce a permanently failing update chip. Check the signing key/password in build.ps1."
    exit 1
}

# STALE SIGNATURE GUARD. A build that fails at the signing step still leaves the
# freshly bundled installer AND the PREVIOUS run's .sig sitting next to it -- the
# 0.2.1 bundle dir had an Aug 2 installer beside a May 8 signature. Publishing
# that pair yields an update that downloads and then fails verification on every
# install, which reads to the user as a broken app rather than a broken release.
$sigInfo = Get-Item $sigFile
if ($sigInfo.LastWriteTime -lt $installer.LastWriteTime) {
    Write-Error @"
Signature is OLDER than the installer:
  installer  $($installer.LastWriteTime)  $($installer.Name)
  signature  $($sigInfo.LastWriteTime)  $($sigInfo.Name)
That means the last build bundled but did NOT sign, leaving a stale .sig behind.
Re-run .\build.ps1 -Full and confirm it completes the signing step.
"@
    exit 1
}
$signature = (Get-Content $sigFile -Raw).Trim()

# Target triple -> the key the running app looks itself up under.
# arm64-setup.exe => windows-aarch64, x64-setup.exe => windows-x86_64.
$platformKey = if ($installer.Name -match "arm64") { "windows-aarch64" }
               elseif ($installer.Name -match "x64") { "windows-x86_64" }
               else { Write-Error "Cannot infer target triple from $($installer.Name)"; exit 1 }

Write-Host "Installer   $($installer.Name) ($([math]::Round($installer.Length/1MB,1)) MB)"
Write-Host "Platform    $platformKey"
Write-Host "Signature   $($signature.Substring(0,32))..."

# --- 3. latest.json -----------------------------------------------------------
$assetUrl = "https://github.com/$REPO/releases/download/$tag/$($installer.Name)"
if (-not $Notes) { $Notes = "Switchboard $version" }

$latest = [ordered]@{
    version   = $version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        $platformKey = [ordered]@{
            signature = $signature
            url       = $assetUrl
        }
    }
}

$latestPath = Join-Path $nsisDir "latest.json"
$latest | ConvertTo-Json -Depth 5 | Out-File $latestPath -Encoding utf8
Write-Host "Wrote $latestPath" -ForegroundColor Green

if ($DryRun) {
    Write-Host "`n--- DRY RUN - nothing published ---" -ForegroundColor Yellow
    Get-Content $latestPath
    Write-Host "`nWould run: gh release create $tag --repo $REPO ..."
    exit 0
}

# --- 4. Publish ---------------------------------------------------------------
& gh auth switch --user ericmitchellchan | Out-Null
$active = (& gh api user --jq .login)
if ($active -ne "ericmitchellchan") {
    Write-Error "gh is authenticated as '$active', expected ericmitchellchan."
    exit 1
}

$existing = & gh release view $tag --repo $REPO 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Host "Release $tag exists - replacing its assets" -ForegroundColor Yellow
    & gh release upload $tag $installer.FullName $sigFile $latestPath --repo $REPO --clobber
} else {
    & gh release create $tag `
        $installer.FullName $sigFile $latestPath `
        --repo $REPO `
        --title "Switchboard $version" `
        --notes $Notes
}
if ($LASTEXITCODE -ne 0) { Write-Error "gh release failed"; exit 1 }

# --- 5. Verify the endpoint the app actually reads ----------------------------
$endpoint = "https://github.com/$REPO/releases/latest/download/latest.json"
try {
    $fetched = Invoke-RestMethod -Uri $endpoint -MaximumRedirection 5
    if ($fetched.version -eq $version) {
        Write-Host "`nEndpoint serves $($fetched.version) - the update is live." -ForegroundColor Green
    } else {
        Write-Warning "Endpoint serves $($fetched.version), expected $version."
    }
} catch {
    Write-Warning "Endpoint not reachable anonymously: $_"
    Write-Warning "If the repo is PRIVATE this is expected - the updater sends no auth and will never see this release."
}
