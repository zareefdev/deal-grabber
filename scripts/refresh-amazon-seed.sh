#!/bin/sh
# Refreshes data/amazon-seed.json from this machine's (residential) connection and
# publishes it. CI runs on a datacenter IP that Amazon throttles for hours at a
# time, so this seed is what keeps the Amazon half of the feed populated there.
set -u
cd "$(dirname "$0")/.." || exit 1
mkdir -p data

node server.js --amazon-seed >> .amazon-seed.log 2>&1
status=$?
tail -n 400 .amazon-seed.log > .amazon-seed.log.tmp 2>/dev/null && mv .amazon-seed.log.tmp .amazon-seed.log
[ "$status" -eq 0 ] || exit 0

git diff --quiet -- data/amazon-seed.json && exit 0

git add data/amazon-seed.json
git commit -q -m "data: refresh Amazon seed from a residential scrape

Co-authored-by: CommandCodeBot <noreply@commandcode.ai>" || exit 0
git pull --rebase --autostash --quiet origin main >/dev/null 2>&1 || true
git push --quiet origin main >/dev/null 2>&1 || true
