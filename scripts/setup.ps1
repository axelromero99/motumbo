# One-time setup for a fresh clone: fetches vendored dependencies.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path "$root\vendor\box3d")) {
    git clone https://github.com/erincatto/box3d.git "$root\vendor\box3d"
}

Push-Location "$root\web"
npm install
Pop-Location
