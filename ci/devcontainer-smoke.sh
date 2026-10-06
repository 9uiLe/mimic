#!/usr/bin/env bash
set -euo pipefail

test "$(node --version)" = 'v24.21.0'
test "$(pnpm --version)" = '12.9.1'
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:browser --project=chromium-desktop --project=chromium-mobile
output="$(node apps/cli/dist/main.js)"
test "$output" = '{"name":"mimic","state":"ready"}'
printf '%s\n' "$output"
