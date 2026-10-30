#!/usr/bin/env sh
# Full verification, sequential (npm test and the Go suite share one DB).
set -eu
cd "$(dirname "$0")/../.."
: "${DATABASE_URL:=postgres://filspay:filspay_dev_password@localhost:5433/filspay}"
export DATABASE_URL

echo "==> migrate";       npm run migrate
echo "==> tsc api";       (cd apps/api && npx tsc --noEmit)
echo "==> tsc reporting"; (cd apps/reporting && npx tsc --noEmit)
echo "==> npm test";      npm test
echo "==> go test";       (cd apps/settlement && go test -count=1 -p 1 ./...)
echo "All suites passed."
