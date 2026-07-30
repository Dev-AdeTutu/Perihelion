# Performance Budgets

Perihelion enforces cost budgets in CI on both chains. A budget is not a target, it is a gate: a
change that crosses one fails the build.

## Why these are gates

`PerihelionEscrow.lock` is the solver's per-fill cost and feeds directly into the `V_min`
calculation in `docs/ECONOMICS.md` and into the solver's fee estimator. A regression that pushes
`lock` past the profitable threshold changes protocol economics, so it must not land silently.

On Soroban the constraint is harder: contracts have a hard size limit and per-invocation CPU and
memory ceilings, so a regression can make an entrypoint unusable rather than merely expensive.

## EVM gas snapshot

- Baseline: `contracts/evm/.gas-snapshot`
- Test surface: `contracts/evm/test/GasSnapshot.t.sol` plus the rest of the suite
- CI: `.github/workflows/evm.yml`, the `evm` job runs `forge snapshot --check --tolerance 1`

The 1% tolerance absorbs compiler nondeterminism across runs. Tighten it once the build is fully
reproducible end to end.

Every pull request also gets a gas diff comment so the size and location of a change are visible
to reviewers rather than only a pass or fail.

Local check:

```bash
cd contracts/evm && forge snapshot --check --tolerance 1
```

## Soroban resource baselines

- Baseline: `contracts/soroban/settlement/ci/resource-baselines.json`
- Enforced by: budget assertions in `contracts/soroban/settlement/src/test.rs`, run by
  `make test-soroban`, plus the wasm size step in `.github/workflows/soroban.yml`

The baseline file holds a `max_wasm_size_bytes` ceiling, a `tolerance_percent` applied to the
per-entrypoint limits, and CPU instruction and memory ceilings for `lz_receive`, `fill_intent`,
and `cancel_expired_intent`.

## Updating a baseline

Baselines only move deliberately, and never in a PR whose stated purpose is something else.

1. Confirm the regression is intended. If a change is meant to be cost-neutral, a moved baseline
   is a bug report, not a chore.
2. Regenerate in the same PR as the code change:
   - EVM: `cd contracts/evm && forge snapshot`
   - Soroban: edit `settlement/ci/resource-baselines.json` to the newly measured values
3. In the PR description, state the old and new numbers, the cause, and for `lock` the effect on
   `V_min` in `docs/ECONOMICS.md`.
4. Reviewers treat an unexplained baseline change as a blocker.
