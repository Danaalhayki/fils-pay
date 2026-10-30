# Builds CyberStar_FilsPay_Submission.pdf from the Markdown document and
# BUGS.md (Appendix A), using marked for HTML and headless Edge for the PDF.
#   powershell -ExecutionPolicy Bypass -File docs/submission/build-pdf.ps1
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Resolve-Path "$here/../.."
$out = Join-Path $here "out"
New-Item -ItemType Directory -Force $out | Out-Null

npx.cmd -y marked@12 -i (Join-Path $here "CyberStar_FilsPay_Submission.md") -o (Join-Path $out "main.html")
if ($LASTEXITCODE -ne 0) { throw "marked failed (main)" }
npx.cmd -y marked@12 -i (Join-Path $root "BUGS.md") -o (Join-Path $out "bugs.html")
if ($LASTEXITCODE -ne 0) { throw "marked failed (BUGS.md)" }

$css = @"
@page { size: A4; margin: 16mm 14mm; }
body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #1a1a1a; }
h1 { font-size: 20pt; border-bottom: 3px solid #0b5; padding-bottom: 4px; }
h2 { font-size: 15pt; color: #064; border-bottom: 1px solid #ccc; padding-bottom: 2px; margin-top: 18px; }
h3 { font-size: 12pt; color: #222; margin-top: 14px; page-break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #eef6f0; }
code { font-family: Consolas, monospace; font-size: 8.8pt; background: #f3f3f3; padding: 0 2px; }
pre { background: #f6f8f7; border: 1px solid #ddd; padding: 8px; font-size: 7.6pt; line-height: 1.25; white-space: pre; overflow: hidden; page-break-inside: avoid; }
pre code { background: none; padding: 0; font-size: inherit; }
img { display: block; max-width: 92%; max-height: 105mm; margin: 6px auto 12px; border: 1px solid #ccc; page-break-inside: avoid; }
.pagebreak { page-break-before: always; }
.appendix-title { page-break-before: always; }
"@

$main = Get-Content (Join-Path $out "main.html") -Raw -Encoding utf8
$bugs = Get-Content (Join-Path $out "bugs.html") -Raw -Encoding utf8
$html = @"
<!doctype html><html><head><meta charset="utf-8"><title>CyberStar FilsPay Submission</title>
<base href="$(([System.Uri]"$here\").AbsoluteUri)">
<style>$css</style></head><body>
$main
<h2 class="appendix-title">Appendix A — Full findings (BUGS.md)</h2>
$bugs
</body></html>
"@
$htmlPath = Join-Path $out "CyberStar_FilsPay_Submission.html"
Set-Content -Path $htmlPath -Value $html -Encoding utf8

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Edge or Chrome not found" }

$pdf = Join-Path $here "CyberStar_FilsPay_Submission.pdf"
$uri = ([System.Uri]$htmlPath).AbsoluteUri
& $edge --headless=new --disable-gpu --no-pdf-header-footer "--print-to-pdf=$pdf" $uri | Out-Null
Start-Sleep -Seconds 3
if (-not (Test-Path $pdf)) { throw "PDF not produced" }
Write-Host "Wrote $pdf"
