# Dependency and lockfile policy

Perihelion keeps dependency updates and security triage explicit so that the bridge can be rebuilt reproducibly and audited consistently.

## Lockfiles and vendored dependencies

- The repository commits the npm lockfile at [package-lock.json](../package-lock.json) and the Soroban Rust lockfile at [contracts/soroban/Cargo.lock](../contracts/soroban/Cargo.lock).
- The repository does not commit [node_modules](../node_modules) or other generated install trees. Those directories are ignored and should be recreated with `npm ci`.
- The Soroban lockfile is committed because the contract workspace is part of the audited release artifact and must remain reproducible.

## Update cadence

- Dependencies should be reviewed on a regular basis, at least once per release train and whenever a dependency advisory is published.
- Runtime-critical components (SDK, relayer, solver, and contract dependencies) should be updated promptly when a patched version is available.
- Lockfiles must be regenerated and committed together with any manifest changes.
- [.github/dependabot.yml](../.github/dependabot.yml) opens a weekly update PR for each of the three ecosystems in use: npm (root workspace, covering `sdk`, `relayer`, `solver`, `mempool`, `test`), cargo (`contracts/soroban`), and github-actions (workflow-pinned actions). Dev dependencies and `@types/*` packages are grouped separately from runtime npm dependencies to keep PR volume manageable.
- Dependabot PRs are reviewed by whichever CODEOWNERS rule matches the changed manifest — a `contracts/soroban/Cargo.toml` bump routes to `@Perihelion-Protocol/soroban-maintainers`, a workflow bump to `@Perihelion-Protocol/maintainers`, and so on. No separate reviewer list is needed; see [CODEOWNERS](../.github/CODEOWNERS).
- A major-version bump (e.g. the pending `@stellar/stellar-sdk` v12 → current major) should not be merged as a routine Dependabot PR — close it with a comment linking to a tracked upgrade issue instead, since major bumps typically require code changes beyond the manifest.

## Vulnerability triage

- CI runs an npm audit job and a Rust advisory scan job on pushes, pull requests, and a weekly schedule.
- The workflow fails on high and critical advisories unless they are explicitly allowlisted in [.github/dependency-audit-allowlist.json](../.github/dependency-audit-allowlist.json) for the npm side and in [deny.toml](../deny.toml) for the Rust side.
- Any allowlisted advisory must include a short rationale and an expiry date in the corresponding file so the exception does not become permanent.

## Maintenance checklist

1. Update dependency manifests.
2. Regenerate the relevant lockfiles.
3. Re-run the security scan locally and in CI.
4. Document any allowlisted exception with rationale and expiry.
