#!/usr/bin/env bash
# Assert that the toolchain on PATH is the one this repo pins, and record it in
# the build log. A job that silently floats to a newer compiler produces results
# that differ from the gating jobs for no code reason.
#
# Usage: scripts/check-toolchain.sh rust|foundry|all
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_rust() {
  local pinned actual
  pinned="$(sed -n 's/^channel = "\(.*\)"/\1/p' "$REPO_ROOT/rust-toolchain.toml")"
  if [ -z "$pinned" ]; then
    echo "error: no channel found in rust-toolchain.toml" >&2
    exit 1
  fi

  actual="$(rustc --version)"
  echo "rustc: $actual"
  echo "cargo: $(cargo --version)"
  echo "pinned (rust-toolchain.toml): $pinned"

  # rust-toolchain.toml only takes effect when rustup runs inside the repo, so
  # this check is the only thing that proves it did.
  if ! grep -q " $pinned " <<<"$actual "; then
    echo "error: rustc is not the pinned toolchain $pinned" >&2
    exit 1
  fi
  echo "✔ rust toolchain matches rust-toolchain.toml"
}

check_foundry() {
  echo "forge: $(forge --version | head -1)"

  # FOUNDRY_VERSION is set at workflow level; locally it is usually unset, in
  # which case the version is recorded but not enforced.
  if [ -z "${FOUNDRY_VERSION:-}" ]; then
    echo "⏭ FOUNDRY_VERSION unset — recording version only"
    return 0
  fi

  echo "pinned (FOUNDRY_VERSION): $FOUNDRY_VERSION"
  local sha="${FOUNDRY_VERSION#nightly-}"
  if ! forge --version | grep -q "${sha:0:7}"; then
    echo "error: forge is not the pinned build $FOUNDRY_VERSION" >&2
    exit 1
  fi
  echo "✔ forge matches FOUNDRY_VERSION"
}

case "${1:-all}" in
  rust) check_rust ;;
  foundry) check_foundry ;;
  all) check_rust; check_foundry ;;
  *) echo "usage: $0 rust|foundry|all" >&2; exit 2 ;;
esac
