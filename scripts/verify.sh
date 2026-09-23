#!/usr/bin/env bash
# The single gate every change must pass. Human-owned: the Ralph loop runs this file directly,
# so changing package.json scripts or prd.json cannot weaken it.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$1"; }

step "typecheck"
npx tsc --noEmit

step "tests"
npx vitest run --reporter=default --reporter=json --outputFile=.verify-vitest.json
jq -r '.numTotalTests' .verify-vitest.json > .verify-test-count
jq -e '.numFailedTests == 0 and .numPendingTests == 0 and .numTodoTests == 0' .verify-vitest.json > /dev/null \
  || { echo "tests failed, skipped or todo"; exit 1; }

step "build"
npx tsc -p tsconfig.build.json

step "security audit"
node scripts/security-audit.mjs

printf '\nVERIFY PASSED\n'
