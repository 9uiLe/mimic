#!/usr/bin/env bash
set -euo pipefail

test "$(node --version)" = 'v24.21.0'
test "$(pnpm --version)" = '12.9.1'
pnpm install --frozen-lockfile
case "${1:-}" in
  quality)
    pnpm run check
    output="$(node apps/cli/dist/main.js)"
    test "$output" = '{"name":"mimic","state":"ready"}'
    printf '%s\n' "$output"
    ;;
  chromium-desktop|chromium-mobile)
    pnpm run test:browser --project="$1"
    ;;
  *)
    echo 'Expected quality, chromium-desktop, or chromium-mobile' >&2
    exit 1
    ;;
esac
