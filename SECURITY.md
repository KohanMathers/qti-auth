# Security policy

QTIAuth handles authentication, sessions and personal data, so we take vulnerability reports
seriously.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Email **hello@quietterminal.co.uk** with:

- a description of the issue and its impact,
- steps to reproduce, or a proof of concept,
- the affected version, commit or configuration,
- whether you'd like to be credited, and under what name.

## What to expect

- Acknowledgement within 3 working days.
- Initial assessment (confirmed or not, and severity) within 10 working days.
- Updates at least every 14 days until the issue is resolved.
- Coordinated disclosure: we'll agree a disclosure date with you. Our default is 90 days after the report, or sooner once a fix is released.
- Credit in the release notes and advisory, if you want it.

## Scope

In scope:

- code in this repository,
- published container images,
- the default configuration and Compose files.

Out of scope:

- vulnerabilities in a specific deployment caused by its own configuration choices (report those to that deployment's operator),
- denial of service through sheer request volume,
- reports from automated scanners without a demonstrated impact,
- missing security headers or best-practice suggestions with no exploitable issue.

## Supported versions

Before v1.0 only the latest commit on `main` receives security fixes. A support policy for released versions will be published with v1.0.

## Safe harbour

We won't pursue or support legal action against good-faith research that avoids privacy violations, data destruction and service disruption, only tests against your own deployments, and gives us reasonable time to fix the issue before disclosure.
