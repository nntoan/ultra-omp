#!/usr/bin/env bash
set -euo pipefail

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' 'curl is required to bootstrap OMP and Bun.' >&2
  exit 1
fi

if ! command -v omp >/dev/null 2>&1; then
  printf '%s\n' 'OMP is not installed; running the official OMP installer.' >&2
  curl -fsSL https://omp.sh/install | sh
  export PATH="${PI_INSTALL_DIR:-$HOME/.local/bin}:$HOME/.bun/bin:$PATH"
  if ! command -v omp >/dev/null 2>&1; then
    printf '%s\n' 'OMP was installed but is not on PATH. Add the official installer directory to PATH and retry.' >&2
    exit 1
  fi
fi

runner=
if command -v bunx >/dev/null 2>&1; then
  runner=bunx
elif command -v npx >/dev/null 2>&1; then
  runner=npx
else
  printf '%s\n' 'No bunx or npx found; installing Bun.' >&2
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bunx >/dev/null 2>&1; then
    printf '%s\n' 'Bun installation completed but bunx is not on PATH.' >&2
    exit 1
  fi
  runner=bunx
fi

exec "$runner" @nntoan/ultra-omp -- "$@"
