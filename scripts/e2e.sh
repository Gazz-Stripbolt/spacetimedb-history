#!/usr/bin/env bash
# Publish a demo module and run the protocol and browser tests against it.
#
#   scripts/e2e.sh rust|csharp|typescript      (needs a local server: `spacetime start`)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LANG_=${1:?usage: $0 rust|csharp|typescript}
SERVER=${SERVER:-local}
HTTP=${HTTP:-http://127.0.0.1:3000}
DB=${DB:-hist-$LANG_}

cd "$ROOT"
npm run build -w typescript --silent >/dev/null   # the demos import the packages' compiled dist/
[[ -f demo/web/dist/index.html && -f demo/typescript/src/page.gen.ts ]] || node demo/web/build.mjs
echo "== publish demo/$LANG_ as $DB"
spacetime publish -s "$SERVER" -y "$DB" -p "demo/$LANG_" --delete-data >/dev/null 2>&1
echo "== protocol tests"
DB=$DB HOST=${HTTP/http/ws} npx tsx tests/server.test.mts 2>&1 | grep -v 'INFO Connecting'
echo "== browser tests"
spacetime publish -s "$SERVER" -y "$DB" -p "demo/$LANG_" --delete-data >/dev/null 2>&1
PAGE="$HTTP/v1/database/$DB/route/" npx tsx tests/browser.test.mts 2>&1 | grep -v 'INFO Connecting'
