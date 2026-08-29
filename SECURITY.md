# Security Policy

## Supported versions

Security fixes land on the latest tagged release only - older releases do
not receive patches. Update with `/broke update`: it installs only
Ed25519-signed release assets after verifying signature and checksum, so
the update path itself refuses tampered artifacts.

| Version                | Supported |
| ---------------------- | --------- |
| latest tagged release  | yes       |
| anything older         | no        |

## Reporting a vulnerability

Please do NOT report security issues in a public GitHub issue.

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**
(<https://github.com/777marvin/ext-broke/security/advisories/new>). The
report stays private between you and the maintainer until a fix is ready.

Please include:

- the affected version (or commit) and how you run broke;
- a description of the issue;
- steps or a proof of concept to reproduce it;
- your assessment of the impact.

Do not include secrets, other people's data, or unrelated sensitive
material in a report.

## Response targets

- Acknowledgement: within 48 hours.
- Initial assessment (affected versions, severity, plan): within 7 days.
- Fix or documented mitigation: as fast as the severity demands, with 30
  days as the target for high-severity issues.
- Public disclosure: coordinated with the reporter, normally with the
  release that ships the fix, including a CHANGELOG entry.

## Scope

In scope: this repository's extension code - especially the surfaces that
touch conversation content (summarization targets and their consent gates,
best-effort secret masking, snapshot/flush history handling, the search
index scanner and its privacy filters, the error archive) and the
self-update trust model (signature verification, artifact integrity,
transactional update recovery).

Out of scope: the AiderDesk host application, model providers and their
APIs, and the local Ollama server. Mitigations that are explicitly
documented as best effort (regex secret masking, prompt-injection limits
of summarization) are known trade-offs, not vulnerabilities - but a
well-argued case for why a trade-off is unacceptable is welcome.

## Safe harbor

Good-faith security research and responsible disclosure within this
policy is welcome; the maintainer will not pursue action against it.
