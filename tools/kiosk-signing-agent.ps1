<#
.SYNOPSIS
  The Auto-MB kiosk signing agent (ADR-0012 lane 2, migration 0091).

.DESCRIPTION
  Polls the Auto-MB server over outbound HTTPS for signing requests,
  signs each one's digest with the organisation's Class 3 DSC through
  Windows CNG, and posts the raw signature back.

  READ THIS BEFORE INSTALLING IT AS A SERVICE. Do not.

  The token driver draws its PIN dialog on the desktop of an INTERACTIVE
  session. A process launched from a service context has no such desktop,
  so the dialog has nowhere to appear and SignHash blocks forever rather
  than failing — no error, no timeout, no log line, just a signature that
  never comes. This was verified on the owner's HYPERSECU HYP2003
  (e-Mudhra Class 3, KSP "HyperPKI HYP2003 KSP India v3") on 2026-08-17,
  and it is the one fact that shapes how this is deployed.

  So: run it in the signer's own logged-in session. Double-click it, or
  register it with Task Scheduler as "run only when user is logged on"
  with "run with highest privileges" OFF. Not a Windows service, not
  PsExec, not a scheduled task running as SYSTEM.

  ADR-0012's other deployment preconditions still stand and are not
  optional: the machine runs nothing but this, accepts no inbound
  connections, auto-locks, and carries no remote-desktop software.

.PARAMETER BaseUrl
  The Auto-MB server, e.g. https://app.example.in — HTTPS only.

.PARAMETER Thumbprint
  The certificate to sign with, as its 40-character SHA-1 thumbprint.
  BY THUMBPRINT ONLY. A certificate store routinely holds several
  certificates with byte-identical subjects — an expiry, a renewal, a
  test issue — and "the one whose CN matches" silently picks whichever
  the enumeration returned first.

.PARAMETER TokenFile
  Path to a file holding the kiosk's bearer token, as issued once by
  Settings -> Signing kiosk. NOT the token itself: a token on a command
  line is a token in the process list, in the shell history and in
  Windows event logs. Protect the file with NTFS permissions so only the
  signer's account can read it.

.PARAMETER IntervalSeconds
  Seconds between polls when the queue is empty. Default 15.

.EXAMPLE
  .\kiosk-signing-agent.ps1 -BaseUrl https://app.example.in `
      -Thumbprint CFD1D2EF23018CEC652D1F380FC57FDCF5C0C4E4 `
      -TokenFile C:\auto-mb\kiosk.token
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [Parameter(Mandatory = $true)][string]$TokenFile,
  [int]$IntervalSeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($BaseUrl -notmatch '^https://' -and $BaseUrl -notmatch '^http://(localhost|127\.0\.0\.1)') {
  throw "BaseUrl must be https:// (http is allowed only for localhost testing): $BaseUrl"
}
$BaseUrl = $BaseUrl.TrimEnd('/')

# ---------------------------------------------------------------------
# The certificate, selected by thumbprint and nothing else.
# ---------------------------------------------------------------------
function Get-SigningCertificate {
  param([string]$Thumbprint)

  $normalised = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  if ($normalised.Length -ne 40) {
    throw "A certificate thumbprint is 40 hexadecimal characters; got $($normalised.Length)."
  }

  # CurrentUser\My is where a token's minidriver surfaces its
  # certificates for the logged-in user. LocalMachine is deliberately not
  # searched: a certificate there is not the one the interactive session
  # can open a PIN dialog for.
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
  $store.Open('ReadOnly')
  try {
    $match = $store.Certificates | Where-Object { $_.Thumbprint -eq $normalised }
  } finally {
    $store.Close()
  }

  if (-not $match) {
    throw "No certificate with thumbprint $normalised is present in CurrentUser\My. Is the token plugged in?"
  }
  if (@($match).Count -gt 1) {
    throw "More than one certificate carries thumbprint $normalised, which should be impossible; the store is corrupt."
  }
  return @($match)[0]
}

function Write-CertificateSummary {
  param($Certificate)

  $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
  if ($null -eq $key) {
    throw 'The certificate has no usable RSA private key; the token may be locked or its driver not installed.'
  }
  $provider = 'unknown'
  try {
    # The KSP name, when the key is a CNG key. A CAPI key answers
    # differently and is reported as such rather than guessed at.
    if ($key -is [System.Security.Cryptography.RSACng]) {
      $provider = $key.Key.Provider.Provider
    } else {
      $provider = "$($key.GetType().Name) (not CNG)"
    }
  } catch {
    $provider = 'unreadable'
  }

  Write-Host 'Signing certificate'
  Write-Host "  thumbprint : $($Certificate.Thumbprint)"
  Write-Host "  subject    : $($Certificate.Subject)"
  Write-Host "  issuer     : $($Certificate.Issuer)"
  Write-Host "  serial     : $($Certificate.SerialNumber)"
  Write-Host "  valid      : $($Certificate.NotBefore.ToString('yyyy-MM-dd')) to $($Certificate.NotAfter.ToString('yyyy-MM-dd'))"
  Write-Host "  key size   : $($key.KeySize) bits"
  Write-Host "  provider   : $provider"

  if ($Certificate.NotAfter -lt (Get-Date)) {
    throw 'This certificate has expired; a signature made with it would not verify.'
  }
  return $key
}

# ---------------------------------------------------------------------
# The one cryptographic operation this agent performs.
#
# SignHash, not SignData: the server sends a 32-byte SHA-256 digest of
# the CMS signed attributes and never sends the document. The agent
# cannot reconstruct what it is signing, and the server cannot be made to
# accept a signature over anything else — it re-derives this digest from
# the stored bytes before it will assemble a PDF.
#
# THE PIN DIALOG APPEARS HERE, on the first call of each session. It is
# drawn by the driver onto this session's desktop; that is why this
# script must not be a service.
# ---------------------------------------------------------------------
function Invoke-TokenSignature {
  param($PrivateKey, [byte[]]$Digest)

  if ($Digest.Length -ne 32) {
    throw "Expected a 32-byte SHA-256 digest; got $($Digest.Length) bytes."
  }
  return $PrivateKey.SignHash(
    $Digest,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
}

# ---------------------------------------------------------------------
# The server.
# ---------------------------------------------------------------------
function Read-KioskToken {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "The token file $Path does not exist."
  }
  $token = (Get-Content -LiteralPath $Path -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($token)) {
    throw "The token file $Path is empty."
  }
  return $token
}

function Invoke-Kiosk {
  param([string]$Path, [hashtable]$Body, [string]$Token)

  $headers = @{ Authorization = "Bearer $Token" }
  $arguments = @{
    Method      = 'POST'
    Uri         = "$BaseUrl$Path"
    Headers     = $headers
    ContentType = 'application/json'
  }
  if ($null -ne $Body) {
    $arguments['Body'] = ($Body | ConvertTo-Json -Compress -Depth 5)
  } else {
    $arguments['Body'] = '{}'
  }
  return Invoke-RestMethod @arguments
}

# ---------------------------------------------------------------------
# The loop.
# ---------------------------------------------------------------------
$certificate = Get-SigningCertificate -Thumbprint $Thumbprint
$privateKey = Write-CertificateSummary -Certificate $certificate
$token = Read-KioskToken -Path $TokenFile

Write-Host ''
Write-Host "Polling $BaseUrl every $IntervalSeconds seconds. Ctrl+C to stop."
Write-Host 'Leave this window open and this session logged in.'
Write-Host ''

while ($true) {
  try {
    $claimed = Invoke-Kiosk -Path '/api/signing/agent/claim' -Body $null -Token $token
    $job = $claimed.job
    if ($null -eq $job) {
      Start-Sleep -Seconds $IntervalSeconds
      continue
    }

    # WHAT IS ABOUT TO BE SIGNED, printed before the PIN dialog opens.
    # ADR-0012 requires the person authorising a signature to see the
    # document, its class, who asked for it and its SHA-256; in this lane
    # that person is whoever is standing here typing the PIN, so this is
    # where those four facts have to appear.
    Write-Host "$(Get-Date -Format 'HH:mm:ss')  signing request $($job.requestId)"
    Write-Host "  document   : $($job.documentType) $($job.documentNumber)"
    Write-Host "  raised by  : $($job.requestedByUserId) at $($job.requestedAt)"
    Write-Host "  SHA-256    : $($job.sourceSha256)"

    if ($job.certificateThumbprint -ne $certificate.Thumbprint) {
      # Refused before the token is touched: the server is pointing this
      # request at a certificate this kiosk does not hold, so the PIN
      # dialog would be asking for the wrong key.
      $reason = "This kiosk holds $($certificate.Thumbprint), not $($job.certificateThumbprint)."
      Write-Warning $reason
      Invoke-Kiosk -Path "/api/signing/agent/requests/$($job.requestId)/result" `
        -Body @{ failureReason = $reason } -Token $token | Out-Null
      continue
    }

    try {
      $digest = [Convert]::FromBase64String($job.digest)
      $signature = Invoke-TokenSignature -PrivateKey $privateKey -Digest $digest
      $result = Invoke-Kiosk -Path "/api/signing/agent/requests/$($job.requestId)/result" `
        -Body @{ signature = [Convert]::ToBase64String($signature) } -Token $token
      Write-Host "  signed     : $($result.signedSha256)"
    } catch {
      # A cancelled PIN dialog, an unplugged token, a locked card. Told to
      # the server so the queue says why it stopped, rather than holding a
      # claim until the authorisation lapses. The exception text is a
      # driver message and never contains the PIN.
      $reason = "The kiosk could not sign: $($_.Exception.Message)"
      Write-Warning $reason
      try {
        Invoke-Kiosk -Path "/api/signing/agent/requests/$($job.requestId)/result" `
          -Body @{ failureReason = $reason.Substring(0, [Math]::Min(500, $reason.Length)) } `
          -Token $token | Out-Null
      } catch {
        Write-Warning "…and the failure could not be reported: $($_.Exception.Message)"
      }
    }
  } catch {
    # A network blip, a restarted server, a revoked credential. Backed off
    # rather than exited: the owner should not have to notice a redeploy.
    Write-Warning "$(Get-Date -Format 'HH:mm:ss')  poll failed: $($_.Exception.Message)"
    Start-Sleep -Seconds ([Math]::Max($IntervalSeconds, 30))
  }
}
