# Chain-completion certificates — never trust anchors

Empty on purpose. Drop a licensed CA's sub-CA certificate here (`.pem`,
`.crt` or `.cer`) when a signer embedded only its leaf certificate and its
chain therefore has nowhere to go — the ProDigiSign case described in
`packages/documents/src/pdf-signature/trust-anchors.ts`.

Certificates here can **complete** a path and can never **end** one: the
path is only trusted when it terminates at a certificate in the parent
directory. Nothing here grants trust, so a wrong file here weakens nothing;
the same file one directory up would.

Licensed-CA certificates come from <https://www.cca.gov.in/ca_certificates.html>.
Ship them here only for a signer this deployment actually receives
documents from, and record which one and why.
