#!/bin/sh
# Run the whole lot-wise document-mode suite.
#
# Every test boots against a throwaway SPICE_DATA_DIR, so none of this
# touches data/config.db. Run from the repo root:  sh tests/run-lotwise.sh
set -e
cd "$(dirname "$0")/.."

fail=0
for t in \
  tests/lotwise-purchase.unit.js \
  tests/lotwise-purchase.http.js \
  tests/lotwise-bills.http.js \
  tests/lotwise-dn-planter.http.js \
  tests/proforma-prefix-and-formd.js \
  tests/journal-proforma.js \
  tests/tally-ref-suffix.unit.js \
  tests/lot-payment-format.js \
  tests/sales-journal-proforma.js \
  tests/dn-planter-tally-bos-name.js
do
  printf '\n=== %s\n' "$t"
  if node "$t" 2>&1 | grep -E '  (ok|FAIL) |passed,'; then :; fi
  # grep swallows the exit code, so re-check explicitly
  if ! node "$t" >/dev/null 2>&1; then
    fail=1
    printf '  ^^ FAILED\n'
  fi
done

printf '\n'
if [ "$fail" -eq 0 ]; then echo "lot-wise suite: ALL GREEN"; else echo "lot-wise suite: FAILURES ABOVE"; fi
exit $fail
