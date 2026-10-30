# Full verification, sequential (npm test and the Go suite share one DB).
#   powershell -ExecutionPolicy Bypass -File scripts/ai/verify.ps1
$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot/../.."
Set-Location $root

if (-not $env:DATABASE_URL) {
  $env:DATABASE_URL = "postgres://filspay:filspay_dev_password@localhost:5433/filspay"
}

function Step($name, [scriptblock]$cmd) {
  Write-Host "==> $name"
  & $cmd
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $name"; exit $LASTEXITCODE }
}

Step "migrate" { npm.cmd run migrate }
Step "tsc api" { Push-Location apps/api; npx.cmd tsc --noEmit; $c = $LASTEXITCODE; Pop-Location; $global:LASTEXITCODE = $c }
Step "tsc reporting" { Push-Location apps/reporting; npx.cmd tsc --noEmit; $c = $LASTEXITCODE; Pop-Location; $global:LASTEXITCODE = $c }
Step "npm test" { npm.cmd test }
Step "go test" { Push-Location apps/settlement; go test -count=1 -p 1 ./...; $c = $LASTEXITCODE; Pop-Location; $global:LASTEXITCODE = $c }
Write-Host "All suites passed."
