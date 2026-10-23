# Security policy

## Supported versions

Security fixes are developed on `main` and included in the next tagged
release. The latest tagged release is the supported packaged version.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please use GitHub's private security-advisory form:

https://github.com/zhaorui-bi/OpenAqua-Harness/security/advisories/new

Do not open a public issue for an unpatched vulnerability. Include the affected
version or commit, operating system, reproduction steps, impact, and any safe
mitigation you have identified. Never attach real API keys, access tokens,
private source-water or facility data, unpublished knowledge records, session data, or complete user configuration.

## Security boundary

OpenAqua Harness runs local agent and engineering processes with the current
user's permissions. Chromium sandboxing protects the Electron renderer; it is
not a sandbox for model-directed backend tools. Researchers should use a
dedicated workspace, review index rebuilds, knowledge staging, evaluations, and
other long or destructive operations, protect bearer URLs, and keep untrusted
JSON/data files outside sensitive directories.

The application stores configuration and job logs locally. These may contain
provider details, file paths, water-quality inputs, facility constraints,
retrieved evidence, model output, or other confidential research metadata. Keep the OpenAqua home and job directories private and do
not commit them.
