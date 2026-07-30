#!/usr/bin/env bash
# Compares a fresh EVM build against the pins in contracts/evm/.pinned-bytecode/.
# Pass --update to rewrite the pins instead of failing (intentional-change path).
set -euo pipefail

EVM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../contracts/evm" && pwd)"
PIN_DIR="${EVM_DIR}/.pinned-bytecode"
CONTRACTS=(PerihelionEscrow PerihelionTimelock)
UPDATE=0
[ "${1:-}" = "--update" ] && UPDATE=1

cd "$EVM_DIR"
# Only src/ matters for the pins, and skipping tests keeps the check independent
# of the test suite compiling.
forge build --force --skip test --skip script >/dev/null

fail=0
for contract in "${CONTRACTS[@]}"; do
  artifact="out/${contract}.sol/${contract}.json"
  if [ ! -f "$artifact" ]; then
    echo "::error::missing build artifact ${artifact}"
    exit 1
  fi

  for pair in "creation:bytecode" "runtime:deployedBytecode"; do
    kind="${pair%%:*}"
    field="${pair##*:}"
    got=$(jq -r ".${field}.object" "$artifact" | sha256sum | cut -d' ' -f1)
    pin="${PIN_DIR}/${contract}-${kind}.sha256"

    if [ "$UPDATE" -eq 1 ]; then
      echo "$got" > "$pin"
      echo "updated ${contract} ${kind}: ${got}"
      continue
    fi

    want=$(cut -d' ' -f1 "$pin")
    if [ "$got" != "$want" ]; then
      echo "::error::${contract} ${kind} bytecode changed: ${want} -> ${got}"
      echo "  If intentional, run: ./scripts/check-pinned-bytecode.sh --update"
      fail=1
    else
      echo "ok ${contract} ${kind}: ${got}"
    fi
  done
done

exit $fail
