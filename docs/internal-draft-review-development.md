# SIGN-04: native internal draft review records

This development slice records a review of exact native draft bytes and authoring inputs. It is separate from recipient `APPROVER`, certificate signing and corporate mandate authority. It does not enforce or authorize distribution. Each response explicitly returns `canAuthorizeSend: false` and `sendEnforcement: NOT_INTEGRATED`.

## Native boundary

The authenticated native tRPC `envelope.internalDraftReview` router exposes `request`, `get` and `decide`. The actor comes from the native session context; the service rechecks the active native user and current team-group membership inside every serializable database transaction. Native role-bearing memberships and active-account rows are share-locked. After visibility authorization, the envelope is locked for update and existing material rows are share-locked; the envelope lock also conflicts with key-share locks used by foreign-key child inserts. These are source safeguards awaiting real PostgreSQL contention proof, not accepted locking evidence. Envelope reads require the actual selected team, native visibility, a document envelope, no deletion and `DRAFT` state. A requester must be the owner or a current manager/admin. The designated reviewer must be a different current manager/admin who can see the envelope, and cannot be the owner or requester.

The new `InternalDraftReview` table preserves the requester, designated reviewer, policy version, snapshot hash and JSON snapshot, expiry and attributable final decision. The snapshot hashes native PDF bytes and binds ordered items, recipients, fields, attachments, owner/team, title, visibility, signature level, format version, form values and native document settings. It excludes recipient tokens and storage credentials. `internalVersion` remains a native format version, not a revision counter. Link attachments bind their native recorded references; remote linked content is not fetched or certified.

Request operation keys are unique per envelope/requester. Identical retries return the original record; changed reviewer, expiry or material input fails closed. A decision requires the expected snapshot hash and freshly matching current draft. Expired records, changed content, lost membership/role, disabled actors and different reviewers are denied. A conditional `PENDING` update records exactly one decision; an identical terminal retry returns the original decision and cannot replace it. `get` separates recorded state, current material match, expiry and current ability to record a decision. It returns no private snapshot contents.

## Running locally

Apply the committed Prisma migration to a new disposable PostgreSQL database using the repository's ordinary bootstrap. Generate the Prisma client. Set `NEXT_PRIVATE_INTERNAL_DRAFT_REVIEW_ENABLED=true` only in the task-owned local synthetic configuration. The default and supplied environment example disable this slice. No mailer, worker, identity provider, certificate service or payment processor is invoked by these review methods.

Focused checks:

```sh
npm run test -w @documenso/lib -- server-only/envelope/internal-draft-review.test.ts server-only/envelope/internal-draft-review-routes.test.ts
node --test packages/lib/server-only/document/send-document.validation.test.mjs
```

The 16 focused tests exercise actual native service/snapshot logic with isolated Prisma doubles and actual authenticated tRPC procedures with synthetic native context. They are not PostgreSQL persistence, locking, HTTP session or browser acceptance. Prisma schema validation and client generation also pass. An offline Prisma migration diff matches the new enum/table, indexes and envelope foreign key, with no existing-column rewrite; the migration preserves existing native columns and cascades review retention with hard envelope deletion. An affected strict TypeScript check covers the service, snapshot, tests and native routes without running the full build. Dependency installation uses the committed lockfile, Node 24.19.0 and npm 11.17.0 with lifecycle scripts disabled; generated clients are produced through the supported Prisma command.

## Open acceptance work

The native send path is deliberately unchanged by this slice. Its PDF prefill and CSC materialization currently sit outside the final send transaction; some authoring paths also persist PDF replacements after their transaction. Full SIGN-04 requires a separately tested material mutation/send boundary, execution-time current authority, withdrawal/revocation, approved rendered-output binding, policy selection, native audit/certificate integration where appropriate, a canonical gateway and review UI, unknown-outcome recovery and browser acceptance. A recorded approval here supplies none of that authority.

The current execution host cannot run a PostgreSQL server: `initdb` rejects UID 0 and supported non-root transitions fail in the runtime. Therefore migrations have not been applied and real native database/session acceptance is blocked. No SQLite, mocked persistence or source test is reported as database proof. Existing sender, recipient, signing, audit and certificate behavior is retained. The whole original SIGN-04 epic remains open.

## Native transactional send development increment (2026-10-03)

The current source adds an authenticated `executeSend` endpoint, immutable prepared PDF staging, per-envelope policy revisions, withdrawal/revocation and durable outbound intents. `sendEnforcement: NATIVE_TRANSACTIONAL_SEND` describes the implemented native boundary; it does not assert a live PostgreSQL proof or production commissioning. A review read still returns `canAuthorizeSend: false`: only execution-time native authority, policy, decision, expiry and material checks may commit a send.

Request preparation uses the same native PDF prefilling/normalization and qualified signature anchor renderer as ordinary distribution. It stages detached native `DocumentData` rows using private `BYTES_64`, regardless of the ordinary upload transport. The batch permits 1–100 PDF items and 32 MiB total prepared plus initial PDF bytes. Native hashes bind the raw authoring snapshot and each prepared item. Prepared reads require current native visibility and requester/reviewer/manager authority. Execution verifies those bytes and preserves each native current DocumentData pointer, including the initial PDF content.

The ordinary native send wrapper now holds a Serializable transaction and Envelope update lock across preparation and its native transition. Upload/data creation and anchor preparation accept the transaction client. Persisted required policy is checked inside this boundary, closing the legacy absent-policy preflight race at the source level. Approved execution reuses staged bytes, holds native membership/material locks, performs native audit/field/state writes and creates the send operation/outbound intent in the same transaction. Unique operation/review bindings prevent replay from committing a second send. Database rollback behavior and actual contention still require PostgreSQL execution.

Notification submission is separate and explicit after commit. `PENDING` becomes `DISPATCHING`, then `QUEUED` only after native submission acknowledgement; failures become `UNKNOWN`. Neither state claims recipient delivery. `UNKNOWN` and a stranded `DISPATCHING` operation cannot be automatically retried because an earlier call may already have reached a queue. The recovery read is bound to current native actor/team and the existing operation key. No workers or providers were started for this development increment.

Policy configuration records immutable revisions with actor/version/time. Final decisions remain immutable; withdrawal and revocation record separate actor/time/reason fields. Explicit current-admin retirement removes only detached private staging after 30-day terminal retention, keeps hashes/review evidence, and does not delete current native document data or external objects. Existing pre-increment records lack prepared artifacts and cannot execute approved sends; request a new review. Apply both native review migrations before running this branch, including while the feature flag is off.

Default activation remains off. The PostgreSQL runtime in this workspace refuses root and supported non-root identity transitions fail, so migration application, row-lock contention, true database rollback, concurrency and complete signed/certificate execution were not proven here. Source tests use explicit Prisma doubles; PDF preparation/anchor and native BYTES_64 decoder tests use the actual native implementations. No full Sign build was run, following AGENTS.md.
