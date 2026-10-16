# Security Policy

## Report a vulnerability

Please do not post suspected vulnerabilities in public issues, discussions, or
social media. Use [GitHub private vulnerability reporting for PingApp](https://github.com/pingappdev/pingapp/security/advisories/new).
Include the affected component and version, impact, and steps to reproduce. Do
not include real users' personal information, wallet secrets, or live
credentials. Test only against local or test environments; do not access or
alter another person's account or funds.

The project has no published response-time guarantee. Reports are reviewed
privately, and reporters should coordinate public disclosure with the
maintainers after a fix or mitigation is available. If private reporting is
unavailable to you, contact a repository maintainer through GitHub and ask for
a private reporting channel; do not send sensitive details in a public issue.

## Supported versions

The latest published release and the current `main` branch are the versions
maintainers intend to review for security reports. Older releases have no
guaranteed backport or support period. There is no fixed security-fix SLA.

## Scope

Reports may cover the API and worker, web and Android clients, smart contracts,
deployment tooling, and the security impact of their integrations. Do not
attempt tests against production services, real users, or live assets. The
contract and application have the limitations described in the project
[README](README.md); a successful test suite does not establish that every
token, provider, or deployment configuration is safe.
