# Builds the C simulation to WASM and copies the artifacts into the web app.
$ErrorActionPreference = "Stop"
$tools = "C:\Users\user1\dev\tools"
$root = Split-Path $PSScriptRoot -Parent

& "$tools\emsdk\emsdk_env.ps1" | Out-Null

$cmake = "$tools\cmake\bin\cmake.exe"
$ninja = "$tools\ninja\ninja.exe"
$toolchain = "$env:EMSDK\upstream\emscripten\cmake\Modules\Platform\Emscripten.cmake"

& $cmake -S $root -B "$root\build\wasm" -G Ninja `
    "-DCMAKE_MAKE_PROGRAM=$ninja" `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    -DCMAKE_BUILD_TYPE=Release
if ($LASTEXITCODE -ne 0) { exit 1 }

& $cmake --build "$root\build\wasm" --target sim
if ($LASTEXITCODE -ne 0) { exit 1 }

New-Item -ItemType Directory -Force "$root\web\src\gen" | Out-Null
Copy-Item "$root\build\wasm\tumbo.js", "$root\build\wasm\tumbo.wasm" "$root\web\src\gen\" -Force
Write-Host "OK -> web/src/gen/tumbo.js + tumbo.wasm"
