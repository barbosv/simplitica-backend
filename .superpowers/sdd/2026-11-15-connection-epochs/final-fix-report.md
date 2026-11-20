# Single final fix wave — I1 and M2

Base: `3bce7c97418cdc2590c0f45e8beb383861c7fc1a`. Binding scope: `final-fix-brief.md` and `whole-branch-review.md`. This report records local source/test evidence; independent scoped re-review is pending with the root coordinator.

## Change

I1: removed only the redundant `c.token_not_before <= tokenIssuedAt` predicate and its SQL argument from repository admission. The stored legacy timestamp and mutation logic remain schema-compatible, with a source comment explicitly denying it authorization authority. Admission still requires exact signed epoch, active connection and active approving device owned by the identity. The token authorizer still verifies signature, fixed issuer/audience/client, scope, subject, identity, exact externally configured namespace, exp/nbf, and nonnegative safe-integer/not-future iat. No authorizer or Action source changed, no current-D1-epoch fallback was introduced, and every MCP refresh remains denied.

Added two parameterized real Worker integration cases: native approval at protocol clock .100, private authenticated Hono/D1 hook lookup, actual jose RS256 signing with the hook's coherent current epoch/namespace and integer-second iat, followed by admission at .200. One case first leaves an elevated legacy timestamp using an earlier approval/revoke with a clock 60 seconds ahead, then approves epoch 3 after clock rollback. Each case reuses the exact signed bearer at .200, .999, the next second and one millisecond before expiry; expiry and connection revocation both deny it. The protocol clock is deterministic/injected; cryptography, hook handling, SQL and admission are real. Lookup supplies authority only for this fresh issuance, never for a previously issued token.

Repository assertions now permit same-second current epochs, backward-clock new epochs, safe millisecond boundaries and current epochs below a concurrent winner's legacy timestamp. Old-generation denial assertions remain, including delayed actual signing with a later iat, disconnected generation, missing epoch, wrong signed owner, device revocation and namespace restore. No test fetches the latest database epoch to upgrade an old token.

M2: the historical foundation refresh-continuity sentence is explicitly superseded by access-only MCP authorization. Its original lifecycle instructions are labeled historical where they describe the obsolete iat floor. The current epoch spec and plan explicitly remove approval-time authority while retaining normal JWT time validation. Historical evidence remains intact.

## RED before source edits

Command (run twice before any production source change):

`npm run test:worker -- test/worker/cloud-connections.test.ts test/worker/cloud-token.test.ts`

The initial run exited 1 with 8 failures / 207 passes. Seven were expected admission assertions receiving null; the elevated-fence fixture errored with `CloudAccountError: invalid_input` because its challenge expiry used the original clock. Fixed only the test fixture to expire relative to its own context clock, then repeated RED before touching source.

The corrected RED exited 1: **8 expected assertion failures / 207 passes / 215 tests**, two failed files, 3.02 seconds. All failures were `expected null to deeply equal` an authorized owner:

- `admits same-second current epochs and persists one owner/client approval across instances`
- `denies old epochs while admitting the new epoch below a legacy fence after a backward-clock reconnect`
- `accepts safe millisecond boundary 0 while respecting whole seconds`
- `accepts safe millisecond boundary 9007199254740991 while respecting whole seconds`
- `concurrent same-generation approvals accept exactly one command`
- `admits same-second private-hook issuance repeatedly despite an elevated legacy fence: false`
- `admits same-second private-hook issuance repeatedly despite an elevated legacy fence: true`
- `never upgrades an old epoch after disconnect/reconnect despite delayed signing or a later iat` (new current-epoch/below-fence positive control only; old-epoch negatives retained)

Corrected RED log: `/tmp/connection-epochs-final-red.log`. The earlier fixture-error run was inspected before correcting it; the corrected run replaced that temporary log.

## GREEN and final checks

| Command | Result | Local evidence |
| --- | --- | --- |
| `npm run test:worker -- test/worker/cloud-connections.test.ts test/worker/cloud-token.test.ts test/worker/cloud-epoch-hook.test.ts` | Exit 0; 263 tests / 3 files; 3.12s | `/tmp/connection-epochs-final-green.log` |
| `npm test` | Exit 0; 167 tests / 20 files; 7.79s | `/tmp/connection-epochs-final-node.log` |
| `npm run test:worker` | Exit 0; 466 tests / 15 files; 11.81s | `/tmp/connection-epochs-final-worker.log` |
| `npm run lint` | Exit 0; no findings | `/tmp/connection-epochs-final-lint.log` |
| `npm run typecheck:worker` | Exit 0 | `/tmp/connection-epochs-final-typecheck.log` |
| `npm run build` | Exit 0; Node TypeScript build and fixture copy | `/tmp/connection-epochs-final-build.log` |
| `npm run build:worker` | Exit 0; Worker typecheck and local Wrangler dry-run bundle | `/tmp/connection-epochs-final-worker-build.log` |
| `git diff --check` | Exit 0; no whitespace errors | Inspected before commit |

The full Node/Worker suites were each broadened once after affected GREEN because repository source is shared. No redundant full suite repeat. Worker build uses the existing `wrangler deploy --env="" --dry-run --outdir dist-worker` package script: installed CLI help states dry-run compiles/checks without uploading, and output ended `--dry-run: exiting now.` No deployment occurred.

Warnings observed and deferred (M3): Vite's native-config-loader warning for the existing JSON import without import attributes in `vitest.worker.config.ts`; Stripe Worker bundle sourcemaps pointing to missing source files; vendored jsrsasign `suspicious-boolean-not` at line 230 and `equals-nan` at line 235. Wrangler also printed an available-version notice (installed 4.159.0, available 4.162.0); no update made. No check failed due to these warnings. No warnings were suppressed or unrelated vendor/tooling files changed.

## Self-review and remaining boundaries

Reviewed the complete task diff against the brief. The sole production behavior change is removing the approval iat comparison. Kept expectedRevision atomic command guards, generation increment/tombstones, namespace verification, owner/device joins, sanitized errors and all JWT validity checks. Existing migration files and SQL data contracts are unchanged. Reviewed the new integration ordering and immutable bearer reuse; the only hook-derived epochs are for fresh post-approval issuance. The old-token rejection fixtures retain their original fixed epochs. Documentation clearly identifies superseded decisions instead of erasing historical evidence.

M1 remains deferred in the existing progress ledger: historical refresh lifecycle runner failure cleanup needs a separate focused task before reuse. M3 remains deferred tooling cleanup. No attempt was made to implement either. Root will perform the independent scoped review; this self-review does not substitute for it.

Live hosted Auth0/ChatGPT expiry and reauthorization, physical native purchase/App Attest verification, entitlement/write-time rechecks and cold restore/namespace operations remain release gates. No subagents, new route, deployment, migration execution outside ephemeral tests, provider change, package change, UI interaction, real secret access, push, merge or unrelated cleanup occurred. The only credential-looking new fixture is an explicit synthetic local hook value.
