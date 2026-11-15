# App Attest Verification Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task with independent review. This internal cryptographic boundary precedes physical-device qualification and public enrollment.

**Goal:** Verify bounded Apple App Attest evidence in the actual Workers runtime without granting ownership or exposing an endpoint.

**Architecture:** A strict decoder and certificate adapter wrap the reviewed upstream verifier. Attestation facts and assertion verification are separate from strict application admission. D1 challenge consumption/counter mutation and StoreKit ownership remain subsequent integration work.

**Tech Stack:** TypeScript, existing workerd/Vitest, pinned node-app-attest 2.2.0, cbor2 2.4.2, pkijs 4.0.1 and asn1js 4.0.0.

**Spec:** `docs/superpowers/specs/2026-11-15-app-attest-verification.md`; `docs/superpowers/specs/2026-11-14-native-purchase-enrollment.md` remains binding for later enrollment.

## Global Constraints

- Preserve Cloudflare Workers/D1, existing compatibility date `2026-11-09` and `nodejs_compat`; no new production bindings, deployment, migration, route or ownership backfill.
- Bound decoded attestation to 64 KiB, assertion to 8 KiB and exact client payload to 8 KiB before library parsing. CBOR depth is at most 16, definite length only, unique keys, safe integers, no floats/bignums/tags/undefined/trailing objects.
- Pin Apple's App Attestation root independently from StoreKit roots. Validate certificate order/signatures/time/roles/key usage/critical extensions and exact trusted application/environment context. No handwritten DER or signature algorithm.
- Retain raw proofs, receipts, device identifiers and tokens only in protected ignored local evidence; no logs, chat, committed live fixtures or provider error text.
- No permissive helper may become public enrollment authority. Real physical paired attestation/assertion and current application policy remain release gates.
- Keep Auth0 without Enterprise. This verifier neither changes provider configuration nor replaces native identity or StoreKit entitlement verification.

## Review Focus

1. A bounded outer CBOR object can contain malformed or oversized embedded COSE/extensions; enforce the same decoder policy recursively.
2. Historical genuine fixtures can prove signature interoperability while failing current certificate/admission policy; tests must label those distinct claims.
3. A valid assertion over one byte sequence must fail for another; do not accept alternate hashing algorithms, reserialized JSON or caller-supplied keys.
4. Unknown critical certificate/authenticator extensions and ambiguous environment markers fail closed; do not broaden policy to make fixtures pass.
5. Workerd crypto and Node crypto may differ on P256 leaf/P384 issuer chains or DER handling; use actual runtime verification before integrating enrollment.

## Task 1 — Bounded attestation facts in workerd

**Files:** modify `package.json` and lockfile; create `src/chatgpt/attestation/cbor.ts`, `certificates.ts`, `facts.ts`, `types.ts`; create `test/worker/app-attest-facts.test.ts` and synthetic/public fixture provenance under `test/worker/fixtures/app-attest/`.

**Interfaces:**
- `AttestationContext = { teamId:string; bundleId:string; environment:"development"|"production" }`, trusted constructor configuration, not a request override.
- `verifyAttestationFacts(input:{attestation:Uint8Array; keyId:string; clientPayload:Uint8Array}, context:AttestationContext, dependencies?:{now:()=>number}):Promise<AttestationFacts|null>` in `facts.ts`. The exact clientPayload bytes are bounded to 8192 before parsing and passed unchanged to upstream challenge; upstream computes SHA256 internally. Do not supply a precomputed hash or patch the hashing implementation. Time injection is internal test dependency only. Invalid trusted configuration throws fixed `invalid_configuration`; untrusted proof/parser/library failures return null.
- `AttestationFacts` contains verified keyId, SPKI PEM public key, exact environment/AAGUID, counter, and parsed authenticator extensions. It is internal cryptographic evidence, explicitly insufficient for enrollment. Do not export it through a public Worker route or package barrel.
- `decodeStrictCbor(bytes:Uint8Array, maxBytes:number):unknown` in `cbor.ts` performs the shared bounded decoding; consumed-length and embedded-object handling must reject trailing bytes. Keep byte strings as bytes and maps as Maps; do not coerce arbitrary keys to object properties.

- [ ] Pin the reviewed dependencies, capture registry integrity/provenance and upstream fixture tag/license. Preserve existing dependency choices elsewhere; no compatibility-date/flag change to mask a failure.
- [ ] Write behavioral RED: genuine upstream Apple-root fixture accepted at its historical validity time for cryptographic facts, rejected at current server time; altered nonce, RP ID, credential/key, chain/order and environment denied. Distinguish older missing-extension fixtures from current admission evidence.
- [ ] Write strict-decoder RED for depth17, duplicate keys at outer/embedded levels, indefinite containers, invalid UTF8, tags, unsafe integers, floats, bignums, undefined/simple values, trailing objects and size boundary+1. Expected shapes and wrong-type values fail closed.
- [ ] Write real workerd RED for supported P256/P384 mixed certificate chain, expired/not-yet-valid leaves, leaf-as-CA/intermediate-as-leaf, invalid usage, unknown critical extension, malformed nonce extension, unsupported algorithms and public-key mismatch. Synthetic parser fixtures are labeled synthetic.
- [ ] Implement bounded parsing/certificate checks around upstream crypto; use maintained ASN.1/X.509 APIs. Investigate genuine fixture constraint mismatches rather than weakening checks. If required package crypto is unsupported in workerd, report the exact incompatibility and stop this task before substituting an unreviewed implementation.
- [ ] Run `npm run test:worker -- test/worker/app-attest-facts.test.ts` GREEN; then relevant Node tests, lint, Worker typecheck, build and Worker dry build. Record actual RED/GREEN and warnings in report, commit task-owned files and obtain independent review.

## Task 2 — Exact assertions and strict admission

**Files:** create `src/chatgpt/attestation/assertions.ts`, `admission.ts`; extend `types.ts`; create `test/worker/app-attest-assertions.test.ts`, `app-attest-admission.test.ts`, and fixture provenance/golden payload files in the same fixture directory.

**Interfaces:**
- Consume Task1 `AttestationFacts` and strict decoder. `verifyAssertionFacts(input:{assertion:Uint8Array; payload:Uint8Array}, device:{publicKeyPem:string; counter:number}, context:AttestationContext):Promise<{counter:number; extensions:ReadonlyMap<string,unknown>}|null>` is internal cryptographic evidence only; the future service obtains `device` from a previously verified database record, never from request input.
- Require unsigned increasing counter within upstream's supported signed-int32 range; deny counters above `2147483647`, stored-counter exhaustion, resets and replay. This function makes no database mutation.
- Compute `clientDataHash=SHA256(payload)`, `nonce=SHA256(authenticatorData||clientDataHash)`; verify ECDSA/SHA256 over `nonce` with maintained upstream verification. Never accept the alternate direct concatenation algorithm.
- `AttestationAdmissionPolicy = { validationCategories:readonly number[]; bundleVersions:readonly string[] }` requires explicit nonempty trusted allowlists: unique UInt32 categories from 2, 3 or 4, and unique nonempty well-formed version strings of at most 128 UTF8 bytes. `createAttestationAdmission(context:AttestationContext, policy:AttestationAdmissionPolicy)` captures immutable copies and returns strict `verifyAttestation` and `verifyAssertion` methods with the respective internal verifier inputs. Both require authenticator category/version evidence matching the policy; missing evidence fails closed. No default permissive policy, public time injection, request override or environment switch that disables checks. Keep attestation extension names `apple_validation_category_01`/`apple_bundle_version_01` distinct from documented assertion properties `validationCategory`/`bundleVersion`; physical paired evidence must qualify their exact encoding before public use. [Apple validation requirements](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server.md)
- Keep exact action/challenge/owner/session/namespace/revision/purchase-hash canonical payload construction in the later enrollment service. Here verify exact bytes and provide a fixed synthetic golden payload that the later Swift implementation must match; do not imply arbitrary verified bytes authorize a domain command.

- [ ] Write RED for upstream assertion fixture's exact algorithm and changed payload, RP ID, key, signature and counter; label its unpaired-key provenance. Test zero/negative/wrapped/max/exhausted counters and bounded embedded extensions. A different JSON serialization must fail the existing signature.
- [ ] Write RED for strict admission: missing or unknown required evidence, unapproved category/build, wrong environment, malformed policy and historical extension-free fixtures denied. Synthetic extension cases can prove parser/policy behavior only; do not represent them as genuine paired Apple evidence.
- [ ] Implement assertions and strict wrapper; keep low-level fact extraction distinct and prevent future public services from importing it as sufficient admission.
- [ ] Run the two focused workerd files GREEN and final relevant full checks once; independently review and commit. Document exact policy still awaiting physical capture and all runtime limitations.

## Separate physical-device gate

After the reviewed internal adapter is ready, prepare a separate native test build with restricted OS-backed attestation/assertion requests. The owner has an iPhone available. Capture a fresh development attestation and assertion from the same key, retain proof privately, and validate the Apple chain, exact team/bundle, AAGUID, required extension policy and matched-key assertion in workerd. Do not guess between conflicting documented environment markers or accept both algorithms. Public enrollment remains disabled until this succeeds and the separate StoreKit possession/status path and atomic D1 proof ledger are implemented and reviewed. Do not overwrite the owner's production app/data or initiate a real purchase automatically.
