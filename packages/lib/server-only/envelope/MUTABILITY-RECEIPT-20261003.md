# Synchronous native snapshot mutability guard

Base: Sign `5f9a4f10a3018ffdf7edac2d3db446a1a3f37da7`, branch `codex/tm50/sign-capabilities-20261002`.

Native authoring callers use the documented snapshot overload without awaiting it. An async implementation converted the expected immediate denial into a rejected promise, permitting caller preparation to proceed. The snapshot overload now returns void and throws synchronously. The transaction overload retains Promise<void>, rereads the current native row, and propagates both current-state denial and read failures. No native role, signature-level or envelope-state guard was weakened.

Focused actual-source checks: original base1/3 pass,2 fail, including immediate-denial and return-type assertions; corrected3/3 pass. Existing send validation3/3 pass. Expanded pending send-ordering checks also pass; they are a separate source change. Node24.19.0 and locked npm11.17.0 dependency install; Prisma6.19.3 generators completed. Affected strict TypeScript check for both edited native service modules passes; source formatting and diff whitespace checks pass. Tests strip and execute the actual source with isolated dependencies. They do not constitute database, provider, concurrency, signature assurance, or production release proof. No full build was run under repository instructions.
