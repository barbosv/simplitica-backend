# App Attest fixture provenance

The three `attestation-*.json` files are unmodified public upstream fixtures from
[node-app-attest v2.2.0](https://github.com/uebelack/node-app-attest/tree/v2.2.0/test/fixtures),
tag commit `7f20c1cf577d0ffaff4ec71406e99c902f94f2bf`. Their upstream MIT license is
retained in `LICENSE.node-app-attest`. `provenance.json` records file SHA256s and
registry tarball integrities, provenance endpoints, licenses and source revisions
for the four exact dependency pins. Registry provenance metadata is recorded as
published; this is not a claim that an independent Sigstore verification ran.

`attestation-development.json` and `attestation-production.json` verify through
the genuine Apple App Attestation root in workerd at `2024-03-01T00:00:00Z`.
Their leaves have expired. Both contain legacy authenticator data without current
application validation extensions. These prove historical signature and binding
interoperability, not current enrollment admission.

`attestation-extensions.json` comes from Apple's public validation guide, as
identified by its upstream `source` field. Upstream uses it to test extension
parsing only. Its published challenge does not reproduce the certificate nonce:
both upstream and this adapter reject it as full attestation evidence, including
at its historical certificate time. Its credential key and extension CBOR are
useful parser examples. It must not be represented as a successfully paired
attestation/payload or current admission evidence.

`synthetic-certificates.json` is generated locally by `generate-synthetic.py`
(Python 3, cryptography 50.0.2). These are random synthetic P256/P384 profile
certificates with fixed validity `2024-01-01` through `2025-01-01`, plus intentionally
invalid profile variants. The generator discards all private keys. Re-running it
changes keys and signatures. Tests call the adapter's maintained-parser profile
boundary directly, so invalid roles, usages, extensions, algorithms and nonce
shapes fail for those reasons, independently of certificate-signature rejection.
They do not establish Apple trust. Only the genuine public upstream fixtures are
used for acceptance by the complete verifier. The test mutating a signature in
each genuine certificate first confirms its profile is still accepted, then
requires full-verifier rejection.

No physical-device proof or receipt was captured for these fixtures. Live proofs
remain excluded from commits and logs. Paired physical-device qualification and
explicit current admission policy are separate release gates.
