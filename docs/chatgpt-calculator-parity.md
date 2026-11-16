# Reproduce the native/backend calculator comparison

Both implementations use `usd-line-cents-v1` and the same literal fixtures. From an installed backend checkout, pass the native checkout path:

```sh
npm ci
npm run qualify:calculator-parity -- /path/to/voice-invoice
```

The committed runner checks the native/backend fixture bytes and pinned SHA256 digests, then executes the actual backend calculator against23 valid/110 invalid cases and3 valid/13 invalid raw calculator cases. It executes the actual strict-JSON parser against7 valid/18 invalid preflight cases, including decoded duplicate names and scalar-distinct canonical Unicode equivalents. It exits nonzero on fixture drift, result/error mismatch, or parser disagreement. Output contains counts and code/fixture hashes, without credentials or record data. The runner alone executes Node; the native XCTest commands below independently check Swift using the byte-identical fixtures:

```sh
swift test --package-path /path/to/voice-invoice/Shared/CloudInvoiceCore
swift test --package-path /path/to/voice-invoice/Shared/CloudInvoiceCore --configuration release
```

Local evidence on November16,2026: Node26.0.0 passed all checks; Swift6.3.3 passed14 XCTest methods in both debug and release, zero failures/skips. A temporary native-fixture copy with one added newline was rejected as byte drift. Source calculator and raw-JSON parser were unchanged by this verification runner. The native repository's `docs/verification/chatgpt-native-2026-11-16.md` and sanitized artifacts record the corresponding native runs.

This verifies the reviewed backend/native versioned calculation contract. The main app's historical calculator has different rounding and remains in place until explicit version-aware integration preserves finalized historical totals. No production configuration, deployment or migration is part of this check.
