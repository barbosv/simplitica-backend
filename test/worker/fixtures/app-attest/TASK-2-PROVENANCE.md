# Assertion and admission evidence

`assertion-upstream.json` extracts the unchanged assertion, public SPKI PEM,
exact UTF8 payload, team and bundle constants from the public
[node-app-attest v2.2.0 assertion test](https://raw.githubusercontent.com/uebelack/node-app-attest/v2.2.0/test/verifyAssertion.test.js),
revision `7f20c1cf577d0ffaff4ec71406e99c902f94f2bf`. The upstream MIT license is
retained in `LICENSE.node-app-attest`. The source-file and extracted fixture
SHA256s appear in `task-2-provenance.json`.

That public signature verifies in the existing workerd runtime using
`SHA256(payload)`, `nonce=SHA256(authenticatorData||clientDataHash)` and maintained
upstream ECDSA/SHA256 verification over `nonce`. The alternate direct concatenation
algorithm fails. This key is unpaired with the published Apple-root attestation
fixtures. This is signature interoperability evidence, not Apple-root or current
paired-device evidence. The historical 37-byte authenticator header sets `0x40`
without credential fields. The internal parser treats `0x40` as opaque, permits
only mask `0xc1`, and requires ED iff exactly one strict extension map follows.
It makes no WebAuthn user-presence or attested-credential claim from these flags.
Strict admission denies this extension-free assertion.

`synthetic-assertions.ts` creates fresh test-only P256 ECDSA key pairs inside each
runtime test, signs exact bytes through maintained Node-compatible crypto, and
keeps private keys only in the test closure. These keys are never Apple-attested.
The malformed embedded-extension controls first verify with maintained upstream
before requiring adapter rejection. Their validity says nothing about Apple's
actual extension encoding or current-device behavior.

The assertion extension parser accepts a *single provisional candidate*: exact
CBOR property names `validationCategory` (UInt32 number) and `bundleVersion`
(nonempty well-formed text, at most 128 UTF8 bytes). No attestation-name aliases,
category byte-array fallback, normalization, alternate algorithms or permissive
mode exist. Apple's [validation guide](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server.md)
names these assertion properties but does not supply a paired fixture qualifying
their byte encoding. Attestation parsing retains distinct `apple_*` wire names
and its previously qualified parser-only four-byte category format. A fresh
physical iPhone attestation/assertion pair must qualify exact flags/encodings and
explicit policy before public use. The extension-guide attestation's nonce
mismatch remains a full-verifier denial; it is not positive admission evidence.

The admission attestation positive control substitutes synthetic *facts* only,
because this suite contains no genuine paired current-extension attestation.
It exercises the real allowlist boundary while proving neither Apple trust nor
wire encoding. Genuine legacy attestation is tested at its historical valid time
and still denied for missing policy evidence. No public time hook was added.

Assertions have no environment/AAGUID marker. The future service must select the
previously verified device record for the trusted constructor environment; an
assertion cannot establish that environment afresh. Wrong RP context and
attestation environment are rejected. The verifier never accepts a request key
through any public service or route; this internal API expects a stored record.

`payload-golden.json` is a fixed 410-byte synthetic interoperability vector for a
later Swift implementation. Its exact ordered compact UTF8 bytes, base64, hex,
length and SHA256 are pinned; there is no BOM or newline in the signed payload.
The JSON artifact's final newline is outside those bytes. Values are invented
non-secret placeholders. The signature tests reject a different serialization
and changes to every bound field. This is a byte vector, not a domain-command
serializer or authorizer; the later service must prescribe canonical payloads,
validate expected action/challenge/owner/session/namespace/environment/revision
and exact purchase-proof hashes, and atomically consume challenges/counters with
D1 lifecycle writes. No arbitrary verified payload grants action authority.

No live proof, receipt, private key, deployment or paired device capture appears
in these artifacts. StoreKit possession/status, atomic D1 replay accounting and
restricted native request construction remain separate release gates.
