# Creates the code-signing certificate this project builds with.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-cert.ps1
#
# Why this exists: the subject used to be the author's own name, which is the
# one identity that survived every other rename — a `Get-AuthenticodeSignature`
# on the installed binary reported a person, not a product. A certificate cannot
# be forged, so the fix is to own a neutral one.
#
# What it writes:
#   build\codesign.cer                       public cert, committed, imported by the installer
#   %USERPROFILE%\.runtimebroker-signing\    the .pfx and its password, never committed
#
# The thumbprint is printed at the end. Paste it (and the subject) into
# src/signing.js — that module is the only place the build reads it from, and
# `npm run check` fails while the committed .cer and the thumbprint disagree.
#
# Existing certificates are left alone: signtool selects by thumbprint, so an old
# one in the store is harmless, and the installer removes the retired root on
# upgrade. Nothing here needs administrator rights; the signer's key lives in the
# current user's store.

$ErrorActionPreference = 'Stop'

$subject = 'CN=Runtime Broker Components, O=Runtime Components, C=US'
$root = Split-Path -Parent $PSScriptRoot
$cerPath = Join-Path $root 'build\codesign.cer'
$secretDir = Join-Path $env:USERPROFILE '.runtimebroker-signing'
$pfxPath = Join-Path $secretDir 'codesign.pfx'
$passPath = Join-Path $secretDir 'codesign.pfx.pass'

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -KeyUsage DigitalSignature `
  -KeySpec Signature `
  -KeyExportPolicy Exportable `
  -KeyLength 4096 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(5)

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cerPath) | Out-Null
Export-Certificate -Cert $cert -FilePath $cerPath -Type CERT | Out-Null

New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
$password = [Convert]::ToBase64String((1..24 | ForEach-Object { [byte](Get-Random -Max 256) }))
Export-PfxCertificate -Cert $cert -FilePath $pfxPath `
  -Password (ConvertTo-SecureString -String $password -AsPlainText -Force) | Out-Null
Set-Content -Path $passPath -Value $password -NoNewline

Write-Output "subject    $($cert.Subject)"
Write-Output "thumbprint $($cert.Thumbprint)"
Write-Output "public     $cerPath"
Write-Output "private    $pfxPath  (password: $passPath)"
Write-Output ''
Write-Output "Now set THUMBPRINT and SUBJECT in src/signing.js to the values above,"
Write-Output "then run: npm run check"
