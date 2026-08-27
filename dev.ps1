$env:PATH = "C:\Users\ericm\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64;" + $env:PATH
$env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\um\x64"
$env:INCLUDE = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\um"

Set-Location "$PSScriptRoot"
# DEV IDENTITY (platform evolution, Inc 0 — SWIT-29): the WIP build runs as
# "Switchboard Dev" (com.switchboard.dev) so it sits BESIDE the installed daily
# driver. What is isolated: the webview storage (workspace/localStorage — its
# own identifier + origin), and the scrollback mirror + threads.json (lib.rs
# scopes the local-data folder to `switchboard-dev` for a `.dev` identifier).
# What is SHARED on purpose: %APPDATA%/switchboard/config.json (the repo list).
# Releases (build.ps1 -Full) still use tauri.conf.json.
& "C:\Users\ericm\AppData\Roaming\npm\pnpm.cmd" tauri dev --config src-tauri/tauri.conf.dev.json 2>&1
