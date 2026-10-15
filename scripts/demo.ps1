# DoxOps end-to-end demo on Windows PowerShell.
# Usage:  .\scripts\demo.ps1 [-Model gemma4:e4b] [-MaxDeps 0]   (0 = every at-risk dependency)
param(
    [string]$Model = "gemma4:e4b",
    [int]$MaxDeps = 0,
    [string]$Target = "https://github.com/rishrek/LinkWatch"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv not found: winget install --id astral-sh.uv -e" }
    uv python install 3.12 3.13
    if (-not (Test-Path "doxops\.venv")) { uv venv -p 3.12 doxops\.venv }
    $env:VIRTUAL_ENV = (Resolve-Path "doxops\.venv").Path
    uv pip install -e ".\doxops"
    $doxops = Join-Path $env:VIRTUAL_ENV "Scripts\doxops.exe"

    & $doxops doctor --model $Model
    if ($LASTEXITCODE -ne 0) { throw "doctor reported a problem; fix it and re-run" }

    $out = "doxops-out\demo-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    $runArgs = @("run", $Target, "--model", $Model, "--out", $out)
    if ($MaxDeps -gt 0) { $runArgs += @("--max-deps", $MaxDeps) }
    & $doxops @runArgs
    if ($LASTEXITCODE -ne 0) { throw "doxops run failed with exit code $LASTEXITCODE" }
    Start-Process (Join-Path $out "report.html")
}
finally {
    Pop-Location
}
