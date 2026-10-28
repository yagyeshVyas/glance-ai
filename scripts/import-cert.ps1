# Imports the code-signing certificate into the current user's trust stores so
# installers signed on the build machine verify as "Yagyesh Vyas" instead of
# "Unknown publisher". Run on each machine that should trust the signatures
# (no admin required):
#   powershell -ExecutionPolicy Bypass -File scripts\import-cert.ps1
$ErrorActionPreference = 'Stop'
$cer = Join-Path $PSScriptRoot '..\build\codesign.cer'
if (-not (Test-Path $cer)) { Write-Error "Certificate not found: $cer" }

# idempotent: only add when the thumbprint is not already present
$cert = Get-PfxCertificate $cer
$thumb = $cert.Thumbprint
$already = Get-ChildItem Cert:\CurrentUser\TrustedPeople | Where-Object { $_.Thumbprint -eq $thumb }
if ($already) { Write-Output "Already trusted (thumbprint $thumb). Nothing to do."; exit 0 }

certutil -user -addstore Root $cer | Out-Null
certutil -user -addstore TrustedPeople $cer | Out-Null
Write-Output "Imported $($cert.Subject) ($thumb) into CurrentUser Root + TrustedPeople."
Write-Output "Installers signed by this certificate now verify on this machine."
