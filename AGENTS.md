# Project conventions

Reuse the sources pinned in docs/PROVENANCE.md before adding new implementations.
Keep this backend independent of product branding, billing and frontend frameworks.
Execution mode: single agent. Follow existing Kokoro API/data conventions with the
documented extraction decisions in docs/SCOPE.md. No automatic CI activation.

Keep TypeScript files under 300 lines; separate HTTP validation, access policy and
provider IO. Every tenant query must constrain organization ownership. Never log
tokens, passwords, provider secrets or raw request bodies. Keep source attribution.

User-directed validation: build, migration smoke check and a small number of real
database integration scenarios for tenant boundaries, privilege checks, token/key
revocation and provider retries. Do not add redundant unit tests or coverage targets.
