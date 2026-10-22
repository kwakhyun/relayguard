# Security policy

This initial 0.1 release is a defensive reference implementation with executable tests, not a completed independent security audit.

Do not publish working credentials or customer data in public issues. GitHub private vulnerability reporting is enabled. [Report a vulnerability privately](https://github.com/kwakhyun/relayguard/security/advisories/new) through this repository's Security tab. There is no guaranteed response-time SLA.

Include the affected version, a minimal synthetic reproduction, expected versus actual policy behavior, and the relevant trust boundary. Avoid testing a third-party service without authorization.

If a relay credential is exposed, revoke it and review audit logs. If a provider credential is exposed, revoke or rotate it with that provider; revoking a relay key does not revoke the provider token. If the host, database or administrator is compromised, isolate the deployment and preserve an external audit copy before restoring from a trusted source.

See `docs/threat-model.md` for supported defenses and known limitations. Dependency advisory results are time-specific and do not prove absence of unknown vulnerabilities.
