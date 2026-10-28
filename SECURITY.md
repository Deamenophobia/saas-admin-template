# Security policy

Security fixes target the latest developer-preview release. Older preview versions
are not maintained separately; API and database migration contracts may still change.

Report suspected vulnerabilities privately through this repository's **Security →
Report a vulnerability** page. Include the affected version, reproduction steps,
expected impact and a minimal example with synthetic data. Do not publish credentials,
personal data, database dumps or working exploits in public issues.

The integration tests cover important authorization and credential boundaries; they
are not an independent security audit. Before deployment, review the documented
limits in [SCOPE.md](docs/SCOPE.md), [SSO.md](docs/SSO.md) and
[PROVIDERS.md](docs/PROVIDERS.md), including single-process throttling, local session
revocation, provider compatibility and operator-managed event delivery.
