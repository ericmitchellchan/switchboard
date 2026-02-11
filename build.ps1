$env:PATH = "C:\Users\ericm\.cargo\bin;C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\bin\Hostx64\x64;" + $env:PATH
$env:LIB = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.19041.0\um\x64"
$env:INCLUDE = "C:\Program Files (x86)\Microsoft Visual Studio\2019\BuildTools\VC\Tools\MSVC\14.29.30133\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.19041.0\um"

Set-Location "C:\Users\ericm\Cursor\Antigravity\switchboard\src-tauri"
& "C:\Users\ericm\.cargo\bin\cargo.exe" check 2>&1
