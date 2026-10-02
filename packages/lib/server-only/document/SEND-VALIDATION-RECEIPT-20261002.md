# Send validation ordering — partial SIGN-04 prerequisite

Parent/source: a1d4bec1430a937395db9a4aae28979cd71c2831 on codex/tm50/sign-capabilities-20261002.

Moves prefilled PDF rendering/storage/envelope-item replacement after recipient authentication and required-field validation. Two previously denied paths no longer modify PDF storage/item state. Valid prefill ordering before the send transaction is preserved.

FAST: adjacent send-document.validation.test.mjs executes actual TypeScript orchestration with isolated VM dependency doubles on Node v24.19.0; 3/3 pass. Original source fails both denial-effect assertions. No full build run, following AGENTS. This is orchestration regression proof, not native database, storage-provider, signature or browser acceptance. Other send-time validation/effects and concurrency remain separate review needs.

SIGN-04 remains open: APPROVER is recipient participation, internalVersion is format version, canonical signatures service is read-only. Durable material review snapshot, independent current reviewer, policy/hash/version binding, revocation/expiry, material-change invalidation and atomic send recheck remain unimplemented/unverified. National identity/certificates/notarization remain provider/legal gates. No provider challenge, signing, queue delivery, deployment, flag activation or whole-epic acceptance claimed.
