# Native speech money parsing correctness

Continue the complete integration by repairing confirmed main-app parsing defects revealed by executable arm64 tests. This is a narrow legacy speech/copy correction, not a change to the new versioned cloud calculator or historical stored totals.

A single written monetary occurrence must count once even if several extraction regexes match it. Two distinct occurrences must remain distinct even when their amounts are equal. Preserve the existing last-for-amount preference, international separators, existing ASCII digit grammar and sentence punctuation handling. Money stripping removes complete supported currency phrases, not ordinary quantities/room numbers or the digits alone while leaving a currency symbol behind. Invisible currency formatting marks already documented by the source must be removed consistently, without invalid ICU escapes.

Keep existing semantic price/quantity expectations and public methods. Fix source rather than weakening tests. Use actual current simulator XCTest and existing failure evidence. Do not change main/cloud calculator rounding, historical persisted invoices, auth/proof/providers, subscription, PDF layout, UI, schemes or original checkout. All native source edits stay in isolated voice-invoice feature worktree. No real sign-in/purchase/send/production actions.

Additional inherited failures (quantity extraction, normalization/copy, CSV test parsing, PDF geometry/typography harness, pricing fixtures and UI harness) remain visible and are separate subsequent focused tasks; resolving this source component is not full native qualification.
