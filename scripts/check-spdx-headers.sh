#!/usr/bin/env bash
#
# Verify every tracked TypeScript and Rust source file starts with the
# project's SPDX license header, matching the convention already used by
# the Solidity contracts (contracts/evm/**/*.sol start with
# `// SPDX-License-Identifier: MIT`).
#
# Usage:
#   ./scripts/check-spdx-headers.sh
#
# Only files known to git (`git ls-files`) are checked, so build output
# (dist/, target/), node_modules, and other ignored/generated paths are
# automatically excluded. Exits non-zero and lists offenders if any tracked
# *.ts or *.rs file is missing the header.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

HEADER="SPDX-License-Identifier: MIT"

# Only consider files tracked by git; explicitly skip generated declaration
# files and anything under a dist/build/target directory just in case one
# is ever accidentally committed.
mapfile -t FILES < <(
  git ls-files '*.ts' '*.rs' \
    | grep -v -E '(^|/)(dist|build|target|node_modules)/' \
    | grep -v -E '\.d\.ts$'
)

MISSING=()
for f in "${FILES[@]}"; do
  # The header must appear within the first 5 lines. This allows an
  # optional shebang line ahead of it (e.g. relayer/src/index.ts,
  # solver/src/index.ts) while still catching files where it's missing
  # entirely or buried too deep to be a real header.
  if ! head -n 5 "$f" | grep -qF "$HEADER"; then
    MISSING+=("$f")
  fi
done

if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "Missing SPDX license header (\"$HEADER\") in ${#MISSING[@]} file(s):" >&2
  for f in "${MISSING[@]}"; do
    echo "  - $f" >&2
  done
  echo >&2
  echo "Add '// $HEADER' as the first line of the file (right after a" >&2
  echo "shebang line if one is present). See CONTRIBUTING.md." >&2
  exit 1
fi

echo "SPDX license header check passed for ${#FILES[@]} file(s)."
