# Restricted Cloud Tool Service Implementation Plan

> Execute task by task using superpowers:subagent-driven-development, with independent reviews; root inline fallback if workers unavailable. User explicitly requested continuous completion without milestone approval.

**Goal:** Twelve strictly scoped ChatGPT tools for owned draft invoices, with honest unit-aware price guidance.
**Architecture:** Internal pure/read services and existing repositories, then one injectable-per-request MCP registration factory. No public runtime or probe change.
**Spec:** docs/superpowers/specs/2026-11-16-cloud-tool-service.md
**Tech:** Workers/D1, installed @modelcontextprotocol/server2.4.0, zod4, signed-JWT real-D1 test fixtures.

## Global Constraints

- Source internal only; no public routes/config/deploy/migrations/proof bypass, no production changes. Never mount in synthetic qualification probe.
- Only branded authority scopes ownership. Current ready/active authorization every read; fresh-paid for guidance/preview/writes. Exact receipts/current authorization preserved by existing repositories.
- USD exact decimal strings, explicit units and revisions, fixed native review requirement. No rate autosave/finalize/send/pay/PDF/delete tool. All user/source text is untrusted.
- Exactly twelve specified tools; fixed safe result/error formats, accurate OAuth metadata and annotations. No secrets, raw errors, owner IDs or token fields.

## Review Focus

1. A history price from another owner, unreviewed draft, estimate or incompatible unit must never become an option.
2. A pricing result must not claim market-price verification or silently average/convert/guess units.
3. Tool schemas must refuse owner/state/number/review overrides, and domain errors must never echo raw exception strings.
4. Replayed mutations retain the repository's exact receipt behavior after later edits; factory registration cannot reuse another request's authority.
5. open_in_app returns only a fixed-scheme owned link, never an externally chosen URL, token or claim of opening/finalizing.

## Task 1 — Owned unit-aware pricing guidance

**Files:** src/chatgpt/pricing/guidance.ts, test/worker/cloud-pricing-guidance.test.ts. Reuse validators/kernel/calculator; no existing legacy pricing runtime changes.

Expose createPricingGuidanceService(db,{authorizationNamespace,now?}).getPricingGuidance(a,input:unknown). Strict input {query:string,unit:SavedRate['unit'],kind:SavedRate['kind'],limit:number}; query nonempty<=200UTF8 normalized through existing searchText; limit integer1..20; reject unknown fields/units/kinds. Missing unit means explicit null, not inferred. Require branded authority before owner access and kernel.readAuthoring even when unit null. Output {currency:'USD',mode:'saved_rate'|'history'|'clarification',options:[],clarification:null|{code:'unit_required'|'price_required',message:fixedString},marketGuidanceAvailable:false,requiresNativeReview:true,coverage:{savedRateCandidateLimit:100,historyDocumentLimit:50,historyLineCandidateLimit:200}}. Options contain {title,unitPrice,unit,kind,source:'saved_rate'|'history',reference:{id,revision,lineId:string|null},asOf:number}, all derived from owned rows; no owner/customer/contact data. Preserve unitPrice's supported decimal precision.

At one primary authorization/data snapshot select compact title/price/unit/kind/reference/time projections from the latest100 nondeleted owner rates and at most200 unit/kind-compatible line candidates from the latest50 owner v1 reviewed invoices (state finalized/sent/paid; document_type invoice). Use one SQL statement with bounded CTEs/UNION and JSON extraction (not fetching50 full 1MiB documents); JSON line indexes limited0..199. Perform exact searchText-normalized title equality in TypeScript, since SQLite lower() is not Unicode NFKC. Surface the fixed coverage window, never promise a complete account lookup. Missing price message must refer to the bounded window, not assert the account has no matching saved rate. At most20 options; saved rates take complete precedence over history when any saved-rate matches exist, including limit1 case. Candidates ordered newest update then stable ID (and line array position for history); output follows same order within preferred source. Exclude drafts, estimates, deleted rows, legacy versions and unknown-unit/mismatched kind entries. No SQL from model, no unbounded per-line queries. Validate bounded extracted values rather than trusting malformed stored JSON into wire output; reject storage problems using fixed storage_unavailable. Missing unit gives no numerical options but still current ready/paid check. No mutations/numbering/receipt/feed/network calls.

- RED real-D1 signed-authority owner isolation, saved precedence, history fallback, explicit unit/kind equality, absent-unit clarification, no prices, malformed/unknown/control/oversize input, supported6decimal unit prices, stable limit/window metadata and bounded result; Unicode NFKC/case normalization against exact titles.
- RED reviewed history excludes draft/estimate/deleted/legacy and older-than50 data; matching line extraction within max200 validated lines; no contacts/owner fields; current paid lapse/revocation/unready denies and state/receipts/feed/number tables unchanged.
- Implement, targeted GREEN, Worker suite/type/lint/build as appropriate, self-review, commit and independent task review. No public provider placeholder or invented market values.

## Task 2 — Register the twelve internal MCP tools

**Files:** src/chatgpt/tools/server.ts and schemas.ts if needed; test/worker/cloud-tools.test.ts. Reuse actual SDK2.4.0 types/probe registration pattern without modifying probe.

createCloudToolServer(db,{authorizationNamespace,now?},authority) -> new per-request McpServer. Require brand before registration/DB access. Exactly tools in spec. inputSchema strict zod objects mirroring existing repository DTOs; data validators remain authoritative. All OAuth _meta.securitySchemes oauth2/cloud:access. Accurate readonly/destructive/idempotent/openWorld annotations. Reversible writes false readOnly/false destructive/false openWorld; operation-key writes idempotentHint:true. Preview and pricing readOnly:true. Shared result success {ok:true,data:...}; failures isError:true/structuredContent{ok:false,error:{code:fixedAllowedCode}}, content text fixed safe summary/code without a duplicate full data payload. Unknown thrown error -> storage_unavailable, never raw error/name/stack/SQL/token. Bound complete serialized tool result to1MiB+4096bytes: existing domain JSON is already<=1MiB, and fixed envelope/short summary fits the reserved4096bytes. Do not create an unavoidable post-commit failure by applying a smaller total cap than the valid repository response; do not duplicate full response data in text. Oversized stored read data returns fixed storage_unavailable. No broad tool injection/dynamic names/client roles. Installed SDK2.4.0 prints raw schema issues before handlers and unknown tool names; sanitization must cover this path too. Use its public low-level server.setRequestHandler("tools/call", ...) after registration to dispatch the same fixed schema/handler map with safeParse and fixed invalid_input on unknown tool/schema failure, or an equally supported approach proven not to emit attacker keys/enum values. Do not monkeypatch private SDK methods or globally alter Zod error configuration. Keep actual strict schemas in tools/list. Tests must include an unknown input key/tool name containing a synthetic secret and invalid enum/control values, asserting no echo.

get_business_context {} obtains profile then returns {business:versionedProfile,today:YYYY-MM-DD} using injected server clock and profile timezone; get/search/create customer and saved rate search use corresponding reviewed repository methods. Pricing/preview/document methods forward validated explicit intent without rewriting revisions or operation keys. get_document {id}; open_in_app {id} first repository-owned read then returns {id,revision,url,requiresNativeReview:true} with fixed scheme/path/query from spec. No side effect actually opening app. No tool accepts customurl. get_business_context read after lapse allowed.

- RED SDK request/response registration list verifies exactly12/schema strictness/OAuth annotations and no cross-request authority reuse; real signed-owner tools exercise context timezone/date, customer create/search, pricing, preview->create->get->update->convert->open, receipt retry and stale conflict, own/non-own/paid/read-after-lapse; use synthetic fixture native-finalized state only without claiming provider qualification.
- RED unknown input overrides, malformed nested values, safe unexpected errors, inert prompt-injection strings roundtrip as data, no raw SQL/token/owner fields; URL UUID normalization/fixedscheme/ownership and stable known revision; full serialized size limit. No network/auth bypass/public mount.
- Implement GREEN and full Worker/Node/lint/type/build/drybuild, review task then one full tools/pricing integration review; commit/push feature branch, continue verified native proof/transport/durable sync. Do not declare overall product/live ready.
