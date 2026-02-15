param(
    [switch]$Full
)

$env:PATH = "C:\Users\ericm\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64;" + $env:PATH
$env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\um\x64"
$env:INCLUDE = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\um"

if ($Full) {
    # Full production build with NSIS installer + signing
    $keyPath = "$env:USERPROFILE\.tauri\switchboard.key"
    if (Test-Path $keyPath) {
        $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $keyPath -Raw
        Write-Host "Signing key loaded from $keyPath"
    } else {
        Write-Warning "No signing key found at $keyPath — build will not be signed"
        Write-Warning "Generate one with: pnpm tauri signer generate -w $keyPath"
    }

    Set-Location "C:\Users\ericm\Cursor\Antigravity\switchboard"
    & "C:\Users\ericm\AppData\Roaming\npm\pnpm.cmd" tauri build 2>&1
} else {
    # Quick cargo check (default)
    Set-Location "C:\Users\ericm\Cursor\Antigravity\switchboard\src-tauri"
    & "C:\Users\ericm\.cargo\bin\cargo.exe" check 2>&1
}
