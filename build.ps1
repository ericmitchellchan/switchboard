param(
    [switch]$Full
)

$env:PATH = "C:\Users\ericm\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64;" + $env:PATH
$env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\um\x64"
$env:INCLUDE = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\um"

if ($Full) {
    # Full production build with NSIS installer + signing
    #
    # The updater key is scrypt-encrypted and tauri needs its password at bundle
    # time. A truly passwordless key is not reachable through the tauri CLI --
    # `signer generate -p ""` still writes an encrypted key that then refuses an
    # empty password -- so the password lives in a file NEXT TO THE KEY, outside
    # the repo, and this script supplies it. Same no-ceremony outcome: run
    # build.ps1 -Full and it signs.
    $keyPath = "$env:USERPROFILE\.tauri\switchboard.key"
    $pwPath  = "$env:USERPROFILE\.tauri\switchboard.key.password"
    if (Test-Path $keyPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
        Write-Host "Signing key loaded from $keyPath"

        if (Test-Path $pwPath) {
            $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $pwPath -Raw).Trim()
            Write-Host "Signing key password loaded from $pwPath"
        } elseif (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
            # Without this the bundler reaches the LAST step of a multi-minute
            # build and dies on "incorrect updater private key password".
            Write-Error "No signing password at $pwPath and TAURI_SIGNING_PRIVATE_KEY_PASSWORD is unset - the build would fail at the signing step. See RELEASE.md."
            exit 1
        }
    } else {
        Write-Warning "No signing key found at $keyPath - build will not be signed"
        Write-Warning "Generate one with: pnpm tauri signer generate -w $keyPath"
    }

    Set-Location "$PSScriptRoot"
    & "C:\Users\ericm\AppData\Roaming\npm\pnpm.cmd" tauri build 2>&1
} else {
    # Quick cargo check (default)
    Set-Location "$PSScriptRoot\src-tauri"
    & "C:\Users\ericm\.cargo\bin\cargo.exe" check 2>&1
}
