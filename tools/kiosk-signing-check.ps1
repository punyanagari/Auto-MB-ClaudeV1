<#
.SYNOPSIS
  The real-token check for the Auto-MB kiosk signing lane.

.DESCRIPTION
  THE OWNER RUNS THIS, AT THE KIOSK. Nobody else can, and no CI job ever
  will: the token's PIN dialog is drawn on the desktop of an interactive
  session, so a signing call made from a build agent, a service, or an
  automation harness blocks forever instead of failing. That is why the
  automated suite stops where it does.

  What CI already proves, without a token
  ---------------------------------------
  `apps/server/test/pdf-signing.test.ts` and
  `apps/server/test/signing.integration.test.ts` run the whole pipeline —
  the PDF revision, the ByteRange, the CMS assembly, the embedding, the
  0060 verifier reading the result as `signed_and_intact`, the queue, the
  claim race, the tenancy walls — against a deterministic RSA key
  standing in for the token behind a two-member interface.

  What only this script can prove
  -------------------------------
  That the physical thing behaves as the interface assumes:

    1. the certificate is present and is selected BY THUMBPRINT;
    2. the private key is reachable through a CNG provider, and which one;
    3. `RSACng.SignHash(digest, SHA256, Pkcs1)` produces a signature that
       verifies under the certificate's own public key — the exact call
       and the exact padding the server's CMS assembly assumes;
    4. optionally, that a real request in a real queue completes
       end to end.

  It prints VERIFIED:True only if every check it was asked to make passed.

  HOW TO RUN IT. Double-clicking a .ps1 opens it in Notepad rather than
  running it. From a PowerShell window in the signer's own session — not
  an elevated one, and not over remote desktop:

    Unblock-File .\kiosk-signing-check.ps1
    powershell -ExecutionPolicy RemoteSigned -File .\kiosk-signing-check.ps1 `
      -Thumbprint <40 hex characters>

  `Unblock-File` is needed once for a copy that came from another machine;
  the mark-of-the-web blocks it whatever the execution policy says. The
  scripts are not Authenticode-signed, so an AllSigned machine will refuse
  them.

.PARAMETER Thumbprint
  The 40-character SHA-1 thumbprint of the signing certificate.

.PARAMETER BaseUrl
  Optional. With -TokenFile, also completes one real queued request
  against this server, which is the end-to-end proof.

.PARAMETER TokenFile
  Optional. Path to the kiosk's bearer token file. Required with
  -BaseUrl.

.PARAMETER ExportChain
  Optional. Writes the certificate and its issuers to this path as
  concatenated PEM — the value Settings -> Signing kiosk asks for when
  registering the kiosk. Paste the file's contents, signer first.

.EXAMPLE
  .\kiosk-signing-check.ps1 -Thumbprint CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4

.EXAMPLE
  .\kiosk-signing-check.ps1 -Thumbprint CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4 `
      -ExportChain C:\auto-mb\chain.pem

.EXAMPLE
  .\kiosk-signing-check.ps1 -Thumbprint CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4 `
      -BaseUrl https://app.example.in -TokenFile C:\auto-mb\kiosk.token
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [string]$BaseUrl,
  [string]$TokenFile,
  [string]$ExportChain
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# TLS, pinned — same reason as the agent script: an unpinned 5.1 host fails
# a modern endpoint with a message that names the wrong cause.
[Net.ServicePointManager]::SecurityProtocol =
  [Net.SecurityProtocolType]::SystemDefault -bor [Net.SecurityProtocolType]::Tls12

# HTTPS or loopback, and nothing else. This is the FIRST script the owner
# runs, and with -TokenFile it sends the kiosk's bearer credential; one
# mistyped scheme would put that credential on the wire in clear. The agent
# script carries the same guard and this one had been missing it.
if ($BaseUrl -and
    $BaseUrl -notmatch '^https://' -and
    $BaseUrl -notmatch '^http://(localhost|127\.0\.0\.1)') {
  throw "BaseUrl must be https:// (http is allowed only for localhost testing): $BaseUrl"
}

$failures = New-Object System.Collections.Generic.List[string]
function Add-Failure { param([string]$Message) $failures.Add($Message); Write-Warning $Message }

# ---------------------------------------------------------------------
# 1. The certificate, by thumbprint.
# ---------------------------------------------------------------------
$normalised = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
if ($normalised.Length -ne 40) {
  throw "A certificate thumbprint is 40 hexadecimal characters; got $($normalised.Length)."
}

$store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
$store.Open('ReadOnly')
try {
  $all = @($store.Certificates)
  $matched = @($all | Where-Object { $_.Thumbprint -eq $normalised })
} finally {
  $store.Close()
}

Write-Host "CurrentUser\My holds $($all.Count) certificate(s)."
if ($matched.Count -ne 1) {
  throw "Expected exactly one certificate with thumbprint $normalised; found $($matched.Count). Is the token plugged in?"
}
$certificate = $matched[0]

# The reason the pin is a thumbprint and not a name, made visible: if
# another certificate in this store shares this one's subject, selecting
# by name would have been a coin toss.
$sameSubject = @($all | Where-Object { $_.Subject -eq $certificate.Subject })
Write-Host ''
Write-Host 'Selected certificate (by thumbprint)'
Write-Host "  thumbprint      : $($certificate.Thumbprint)"
Write-Host "  subject         : $($certificate.Subject)"
Write-Host "  issuer          : $($certificate.Issuer)"
Write-Host "  serial          : $($certificate.SerialNumber)"
Write-Host "  valid from      : $($certificate.NotBefore.ToString('yyyy-MM-dd'))"
Write-Host "  valid to        : $($certificate.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "  same subject in store: $($sameSubject.Count)"
if ($sameSubject.Count -gt 1) {
  Write-Host '  (subject-name selection would have been ambiguous here — this is exactly why the pin is a thumbprint)'
}
if ($certificate.NotAfter -lt (Get-Date)) {
  Add-Failure 'The certificate has expired; a signature made with it would not verify.'
}

# ---------------------------------------------------------------------
# 2. The private key, and which provider holds it.
# ---------------------------------------------------------------------
$privateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
if ($null -eq $privateKey) {
  throw 'The certificate has no usable RSA private key. Check that the token driver and its minidriver are installed.'
}
$providerName = 'not a CNG key'
if ($privateKey -is [System.Security.Cryptography.RSACng]) {
  $providerName = $privateKey.Key.Provider.Provider
}
Write-Host ''
Write-Host 'Private key'
Write-Host "  algorithm       : RSA $($privateKey.KeySize) bits"
Write-Host "  provider (KSP)  : $providerName"
if ($privateKey.KeySize -lt 2048) {
  Add-Failure "The key is only $($privateKey.KeySize) bits; the signing profile assumes RSA 2048 or better."
}
if ($providerName -eq 'not a CNG key') {
  Add-Failure 'The private key is not reachable through CNG. The server assumes RSACng.SignHash semantics.'
}

# ---------------------------------------------------------------------
# 3. SignHash, and the round trip through the public key.
#
# The PIN dialog appears at this point. If nothing appears and this hangs,
# the script is not running in an interactive session — which is the whole
# reason the agent must not be a Windows service.
# ---------------------------------------------------------------------
Write-Host ''
Write-Host 'Signing a test digest. The token PIN dialog should appear now…'
$sample = [System.Text.Encoding]::UTF8.GetBytes('auto-mb kiosk signing check')
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try { $digest = $sha256.ComputeHash($sample) } finally { $sha256.Dispose() }

$signature = $privateKey.SignHash(
  $digest,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
Write-Host "  signature       : $($signature.Length) bytes"
if ($signature.Length -ne ($privateKey.KeySize / 8)) {
  Add-Failure "A PKCS#1 signature should be $($privateKey.KeySize / 8) bytes; got $($signature.Length)."
}

$publicKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
$verified = $publicKey.VerifyHash(
  $digest,
  $signature,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
Write-Host "  verifies under its own certificate : $verified"
if (-not $verified) {
  Add-Failure 'The signature does not verify under the certificate public key. The key pair does not match the certificate.'
}

# ---------------------------------------------------------------------
# 4. The chain, exported for registration.
# ---------------------------------------------------------------------
if ($ExportChain) {
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  # Building may report an untrusted root — the CCA India root is often
  # not installed as a trusted root on a fresh Windows box, and that is
  # not a reason to refuse to EXPORT the chain. The server makes the
  # trust decision, against the anchors an operator installed there.
  [void]$chain.Build($certificate)
  $pem = New-Object System.Text.StringBuilder
  foreach ($element in $chain.ChainElements) {
    $base64 = [Convert]::ToBase64String($element.Certificate.RawData)
    [void]$pem.AppendLine('-----BEGIN CERTIFICATE-----')
    for ($index = 0; $index -lt $base64.Length; $index += 64) {
      [void]$pem.AppendLine($base64.Substring($index, [Math]::Min(64, $base64.Length - $index)))
    }
    [void]$pem.AppendLine('-----END CERTIFICATE-----')
  }
  Set-Content -LiteralPath $ExportChain -Value $pem.ToString() -Encoding ascii
  Write-Host ''
  Write-Host "Chain written to $ExportChain ($($chain.ChainElements.Count) certificate(s), signer first)."
  Write-Host 'Paste its contents into Settings -> Signing kiosk, with this thumbprint.'
}

# ---------------------------------------------------------------------
# 5. Optional: one real request, end to end.
# ---------------------------------------------------------------------
if ($BaseUrl) {
  if (-not $TokenFile) { throw '-BaseUrl requires -TokenFile.' }
  $BaseUrl = $BaseUrl.TrimEnd('/')
  $token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
  $headers = @{ Authorization = "Bearer $token" }

  Write-Host ''
  Write-Host "Claiming one request from $BaseUrl…"
  $claimed = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/signing/agent/claim" `
    -Headers $headers -ContentType 'application/json' -Body '{}'
  if ($null -eq $claimed.job) {
    Write-Host '  the queue is empty — raise a signing request in the app and run this again'
    Add-Failure 'No queued request was available, so the end-to-end path was not exercised.'
  } else {
    $job = $claimed.job
    Write-Host "  request     : $($job.requestId)"
    Write-Host "  document    : $($job.documentType) $($job.documentNumber)"
    Write-Host "  SHA-256     : $($job.sourceSha256)"
    # The same pin the agent applies before it opens a PIN dialog. Without
    # it this script would happily sign a job raised for a DIFFERENT
    # certificate, produce a signature the server then rejects, and burn
    # the request — while printing VERIFIED:False for a reason that has
    # nothing to do with the token.
    if ($job.certificateThumbprint -ne $certificate.Thumbprint) {
      Add-Failure "The queued request names certificate $($job.certificateThumbprint), but this token holds $($certificate.Thumbprint). Nothing was signed."
      Write-Host ''
      Write-Host "VERIFIED:False ($($failures.Count) problem(s))"
      foreach ($failure in $failures) { Write-Host "  - $failure" }
      exit 1
    }
    $jobSignature = $privateKey.SignHash(
      [Convert]::FromBase64String($job.digest),
      [System.Security.Cryptography.HashAlgorithmName]::SHA256,
      [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $body = @{ signature = [Convert]::ToBase64String($jobSignature) } | ConvertTo-Json -Compress
    $result = Invoke-RestMethod -Method Post `
      -Uri "$BaseUrl/api/signing/agent/requests/$($job.requestId)/result" `
      -Headers $headers -ContentType 'application/json' -Body $body
    Write-Host "  status      : $($result.status)"
    Write-Host "  signed SHA-256 : $($result.signedSha256)"
    if ($result.status -ne 'signed') {
      Add-Failure "The server did not accept the signature: $($result.status)."
    }
  }
}

# ---------------------------------------------------------------------
Write-Host ''
if ($failures.Count -eq 0) {
  Write-Host 'VERIFIED:True'
  exit 0
}
Write-Host "VERIFIED:False ($($failures.Count) problem(s))"
foreach ($failure in $failures) { Write-Host "  - $failure" }
exit 1
