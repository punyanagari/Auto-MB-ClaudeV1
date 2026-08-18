<#
.SYNOPSIS
  Shared guards for the Auto-MB kiosk signing scripts (ADR-0012 lane 2).

.DESCRIPTION
  Dot-sourced by `kiosk-signing-agent.ps1` and `kiosk-signing-check.ps1`.
  It holds only what both do IDENTICALLY: the TLS pin, the transport guard,
  thumbprint normalisation, opening the certificate store, and the one
  cryptographic call. Nothing here decides anything — where the two scripts
  legitimately differ (the agent REFUSES an expired certificate, the check
  RECORDS it and carries on to a verdict) that difference stays in the
  script it belongs to.

  It is not a script to run. It has no `param` block and does nothing on
  its own; every function is defined and none is called.

  COPY IT TO THE KIOSK ALONGSIDE THE OTHER TWO. All three files live in
  the same directory and both scripts dot-source this one from beside
  themselves, so a kiosk that has only the agent will refuse to start.
  Unblock all three the same way:

    Unblock-File .\kiosk-signing-*.ps1
#>

Set-StrictMode -Version Latest

# TLS, pinned. Windows PowerShell 5.1 still negotiates from an old default
# on some builds, and a modern server simply closes the connection — which
# surfaces as "The underlying connection was closed", a message that sends
# an operator hunting for a firewall that is not the problem.
function Set-KioskTlsDefaults {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.SecurityProtocolType]::SystemDefault -bor [Net.SecurityProtocolType]::Tls12
}

# HTTPS or loopback, and nothing else. These scripts send the kiosk's
# bearer credential, and one mistyped scheme would put that credential on
# the wire in clear.
function Assert-KioskBaseUrl {
  param([string]$BaseUrl)

  if ($BaseUrl -notmatch '^https://' -and $BaseUrl -notmatch '^http://(localhost|127\.0\.0\.1)') {
    throw "BaseUrl must be https:// (http is allowed only for localhost testing): $BaseUrl"
  }
}

# A thumbprint as the store spells it: hexadecimal, upper case, 40 long.
# Copied out of certmgr it arrives with spaces, and sometimes with an
# invisible left-to-right mark on the first character.
function Get-KioskNormalisedThumbprint {
  param([string]$Thumbprint)

  $normalised = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
  if ($normalised.Length -ne 40) {
    throw "A certificate thumbprint is 40 hexadecimal characters; got $($normalised.Length)."
  }
  return $normalised
}

# Everything in CurrentUser\My, which is where a token's minidriver
# surfaces its certificates for the logged-in user. LocalMachine is
# deliberately not searched: a certificate there is not the one the
# interactive session can open a PIN dialog for.
#
# The store is handed back whole rather than pre-filtered, because the two
# callers ask different questions of it — one wants the single match, the
# other also wants to know how many certificates share its subject.
function Get-KioskStoreCertificates {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
  $store.Open('ReadOnly')
  try {
    return @($store.Certificates)
  } finally {
    $store.Close()
  }
}

# The one cryptographic operation either script performs.
#
# SignHash, not SignData: the server sends a 32-byte SHA-256 digest of the
# CMS signed attributes and never sends the document. The agent cannot
# reconstruct what it is signing, and the server cannot be made to accept a
# signature over anything else — it re-derives this digest from the stored
# bytes before it will assemble a PDF.
#
# THE PIN DIALOG APPEARS HERE, on the first call of each session. It is
# drawn by the driver onto this session's desktop; that is why neither
# script may run as a service.
function Invoke-KioskSignHash {
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
