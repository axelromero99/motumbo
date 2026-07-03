# One-time setup for a fresh clone: fetches vendored dependencies.
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path "$root\vendor\box3d")) {
    # Pinned: lockstep peers must run identical physics (same pin as ci.yml).
    git clone https://github.com/erincatto/box3d.git "$root\vendor\box3d"
    git -C "$root\vendor\box3d" checkout 1c5ac42c376eb216734df1f35d14bf33c29bb6e7
}

Push-Location "$root\web"
npm install
Pop-Location
