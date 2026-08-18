# ADR-0012: Hybrid outbound signing — eSign by default, kiosk-held DSC where the token certificate is mandated

- Status: Accepted (owner decision 2026-08-14), **amended 2026-08-18 by
  migration `0091_signing_requests.sql`**
- Date: 2026-08-14
- Amends: ADR-0009 (outbound DSC signing). The cryptographic profile of
  ADR-0009 stands in full; its transport and consent chapters are
  superseded for the reasons below.

## Amendment, 2026-08-18 — what building lane 2 changed

The kiosk lane is built. Four things in the text below turned out to be
wrong or premature when it met the hardware, and they are listed here
rather than left for a reader to discover the hard way. Migration
`0091_signing_requests.sql`'s header carries the full reasoning for each;
this is the index.

1. **The kiosk is NOT a headless Windows service.** § Lane 2 says it is.
   It cannot be: the token's PIN dialog is drawn on the desktop of an
   INTERACTIVE session, so a signing call made from a service context
   blocks forever — no error, no timeout, no log line. Verified on the
   owner's HYPERSECU HYP2003 (e-Mudhra Class 3, KSP
   `HyperPKI HYP2003 KSP India v3`) on 2026-08-17. The outbound-only
   polling this ADR specifies is unchanged; only the process model moves,
   to a script the signer starts in their own logged-in session
   (`tools/kiosk-signing-agent.ps1`).

   **This also changes the security argument, not just the deployment.**
   § "The approval is the authority" accepts the lane's risk on the basis
   that an unattended token with a cached PIN is a signing oracle. A
   token that cannot be driven at all without a person at its desktop is
   a weaker oracle than that — but only weaker, because PIN caching
   within one interactive session is real, and because the person at that
   desktop is trusting the QUEUE about what to sign. Both mitigations are
   built: see 3 below.

2. **The kiosk lane has no server-visible approval act.** This ADR
   describes the signer approving each request from a phone; that is lane
   1's flow. In lane 2 the approver is whoever is standing at the token
   typing the PIN, and the server cannot see them. So the four facts
   § "The approval is the authority" requires the approver to see — the
   document, its class, who asked, and the SHA-256 — are printed by the
   agent to its own console before the PIN dialog opens, and shown in
   full on the queue screen so the two can be compared by eye.

3. **Signing is its own authority, `can_sign_documents`** (owner ruling
   2026-08-18), and it is the resolution of this ADR's "raising a
   signature request and approving one are distinct permissions". The
   first draft of 0091 reused `issue` and argued the distinction was
   lane 1's alone. That was wrong, and the reason is the sharpest
   statement of what the two mechanisms do: the **digest binding answers
   WHICH DOCUMENT** may be signed — the token only ever sees the digest
   of a preparation the server can rebuild — and the **authority answers
   WHO MAY QUEUE ONE**, which is the gap a signer at a kiosk cannot see
   past. Neither is redundant.

4. **PAdES B-B, not B-T.** § Lane 1 and ADR-0009 both assume the RFC 3161
   timestamp is applied at signing time. The TSA contract has not landed,
   so no timestamp is embedded: `/M` carries the signer's claimed time,
   labelled a claim by the verifier, and the unsigned-attribute slot is
   left empty rather than filled with a self-asserted time dressed up as
   attestation. The "B-T now / B-LT asynchronously" policy applies from
   the moment the TSA contract exists.

Everything else in this ADR stands, including the whole of lane 1, which
remains unbuilt and gated on ESP onboarding.

## Context

ADR-0009 designed attended token signing: the authorised signer sits at
the machine holding the USB token, a browser extension reaches a native
helper over Native Messaging, consent is a native always-on-top window,
and the PIN is entered in the driver's own dialog for every session.

The owner has since stated the operational reality that design must
serve, and it is different in one decisive way: the signer will not be
at the token machine. The intended flow is that the Class 3 token stays
connected to one computer in a private location; documents needing
signature are raised in Auto-MB by staff; the signer approves each
request **from a phone, from anywhere**; the token machine signs and the
signed PDF becomes available to authorised viewers.

Approve-from-anywhere is not a variation on the attended design — it is
its negation. It also happens to be, almost exactly, the product
definition of Aadhaar eSign (C-DAC e-Hastakshar), which ADR-0009
recorded as the live alternative that deletes the token, the helper and
the driver matrix at the cost of per-signature fees and an
eSign-issued certificate in place of the organisation's own DSC
certificate.

Neither lane alone satisfies both facts on the table: the owner's flow
wants remote approval, and some railway-facing documents may be expected
to carry the organisation's registered DSC certificate specifically.

## Decision

Outbound signing is built as **two lanes behind one signature-request
workflow**. Staff raise a signature request on a document; routing to a
lane is a property of the document class, not a per-request choice.

### Lane 1 — Aadhaar eSign, the default

Every document class signs via eSign unless explicitly routed to lane 2.
The signer receives the approval on their phone through the ESP's
consent flow (OTP or app), per signature, from anywhere. There is no
token, no kiosk, no helper and no unattended private key anywhere in
this lane.

The ESP returns a PKCS#7/CMS signature; the server embeds it and applies
the RFC 3161 timestamp exactly as ADR-0009 specifies for its own CMS
assembly. PAdES baseline requirements, the 16384-byte `/Contents`
reservation, approval-signatures-only, incremental save, and the B-T
now / B-LT asynchronously policy all apply unchanged.

### Lane 2 — kiosk-held DSC, by exception

Reserved for document classes where the counterparty mandates the
organisation's own DSC certificate. The owner enumerates these classes;
the list is expected to be short and may be empty at launch.

The token stays in a dedicated machine in a private location, running a
headless Windows service. ADR-0009's browser extension and Native
Messaging transport are **superseded**: there is no browser in this
flow, no localhost listener, no `Origin` check of ours, and none of the
Chrome 142/147 local-network gating exposure. The service polls the
Auto-MB server over outbound HTTPS only — the kiosk accepts no inbound
connections — fetches approved signing jobs, signs via Windows CNG
(`X509Store` + `RSACng.SignHash`, as ADR-0009 chose), and returns the
raw signature. CMS assembly, SignedAttrs construction (EXPLICIT `SET OF`
tag, `signing-certificate-v2`, no `signing-time`), timestamping and
embedding remain server-side and follow ADR-0009 to the letter.

### The approval is the authority, and it must be bound to the bytes

This is the load-bearing security decision of the kiosk lane, and it is
stated here in full because the lane is unattended.

A token left connected to an unattended machine, with its PIN cached for
the service session, is a signing oracle: whoever controls that machine
can sign anything as the organisation. ADR-0009 warned against exactly
this, and this ADR accepts the risk **only** under the following
binding, which turns the phone approval from acknowledgement into
authorisation:

1. The signer's phone shows the document name, class, requesting user
   and the document's SHA-256 before approval.
2. Approval produces a server-side authorisation record signed by the
   server, carrying that hash, the document id, the signer identity and
   an expiry.
3. The kiosk service verifies the authorisation's signature and its hash
   against the bytes it is about to sign, and signs **nothing** that
   does not carry a valid, unexpired, unconsumed authorisation. Each
   authorisation is single-use.
4. Every kiosk signature is written to the audit trail against its
   authorisation; a signature without one is by construction impossible
   through the service, and the reconciliation job alarms if one ever
   appears in storage anyway.

Kiosk hardening is a deployment precondition, not advice: the machine
runs nothing but the signing service, accepts no inbound connections,
auto-locks, and its PIN caching scope is the narrowest the token driver
supports. The service binary is Authenticode-signed. Remote-desktop
software on the kiosk is prohibited.

### Signing authority and MFA

Signing authority joins the per-feature permission matrix and the MFA
policy in `apps/server/src/mfa-policy.ts` (unchanged from ADR-0009).
Raising a signature request and approving one are distinct permissions;
approval is signer-only in both lanes.

## Consequences

- **Procurement now has three clocks, and eSign's is the longest.**
  (1) The RFC 3161 TSA contract from ADR-0009 stands — both lanes need
  it. (2) eSign requires ASP onboarding with an ESP (NSDL eGov, C-DAC or
  eMudhra): agreement, integration testing and audit. This should start
  first. (3) The kiosk machine and an Authenticode certificate for the
  service binary — small, but real.
- The owner's existing Class 3 token unblocks kiosk-lane development
  immediately; the first implementation step is confirming the token's
  certificate appears in the Windows certificate store (CSP/minidriver
  present), which validates ADR-0009's CNG path.
- Per-signature eSign fees become an operating cost; the routing default
  (eSign unless mandated otherwise) makes this cost proportional to
  volume rather than a gate on any document.
- Signatures from the two lanes carry different certificates. Operator
  documentation must say which documents carry which, and the
  "Validity Unknown in Adobe until the CCA root is imported" fact from
  ADR-0009 applies to both.
- ADR-0009's browser extension, Native Messaging manifest and native
  consent window are not built. If a future requirement ever puts the
  signer back at the token machine, that chapter can be revived; nothing
  in this ADR forecloses it.
- The signature-request workflow, the two-lane router, the kiosk
  service, and the eSign gateway are a wave-4 vertical, to be
  commissioned as a pack once ASP onboarding and the TSA contract are in
  motion.
