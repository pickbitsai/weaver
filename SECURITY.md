# Security policy

Security fixes are applied to the latest version on the default branch.

Please report vulnerabilities through GitHub Private Vulnerability Reporting
when available, or through a private contact method on the maintainer's GitHub
profile. Do not open a public issue containing a manuscript, private outline,
credential, local path, or unpublished production artifact.

## Trust boundary

Weaver reads and writes local book workspaces. It makes no network requests,
has no telemetry, and has no runtime dependencies.

The CLI can:

- copy the bundled synthetic template into a new directory;
- read manuscript, outline, style, and narrative-state files;
- write an explicit narrative-state acceptance manifest;
- write grounding packets when an output path is requested;
- write immutable release artifacts beneath the configured release directory.

It refuses to initialize a non-empty directory, refuses to overwrite an
existing grounding packet, and refuses to reuse a release ID for changed source
unless the caller explicitly passes `--force`.

Treat book workspaces and release output as private data. Run the CLI with only
the filesystem permissions it needs.
