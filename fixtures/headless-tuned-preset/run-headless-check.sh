#!/usr/bin/env bash
# Clean-system headless drill: tune compaction on the profile plane, then run a session.
#
#   run-headless-check.sh --dsh <path-to-dsh> [--home <dir>] [--mock-port 8902] [--ratio 0.75]
#
# Creates a FRESH DSH_HOME by default, starts the repository's mock model on 127.0.0.1, generates the
# host-plane overlay, asserts --dump-config carries the tuned compaction-basic config, and runs one
# headless session. Never touches ~/.dsh or the production service.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
DSH=''; HOME_DIR=''; PORT=8902; RATIO=0.75
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh) DSH="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    --mock-port) PORT="$2"; shift 2 ;;
    --ratio) RATIO="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$DSH" ]] || { echo "run-headless-check.sh: --dsh <path-to-dsh> is required" >&2; exit 2; }
[[ -n "$HOME_DIR" ]] || HOME_DIR=$(mktemp -d)
mkdir -p "$HOME_DIR"
python3 "$REPO/test/compat/mock-llm.py" "$PORT" >"$HOME_DIR/mock.log" 2>&1 &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT
for _ in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT" && break; sleep 0.3; done

sed "s/8901/$PORT/" "$HERE/provider.patch.yml" >"$HOME_DIR/provider.yml"
node "$REPO/scripts/make-preset-patch.mjs" --mode host --ratio "$RATIO" \
  --routes "$HERE/routes.json" --route mock:mock-model --out "$HOME_DIR/host.yml" 2>/dev/null || exit 1

dump=$(DSH_HOME="$HOME_DIR" MOCK_API_KEY=mock "$DSH" --profile headless --patch "$HOME_DIR/provider.yml" --patch "$HOME_DIR/host.yml" --dump-config 2>"$HOME_DIR/dump.err")
grep -A6 '^- id: compaction-basic' <<<"$dump" | grep -q "thresholdRatio: $RATIO" || {
  echo "FAIL: the composed compaction-basic row does not carry thresholdRatio $RATIO" >&2
  grep -A6 '^- id: compaction-basic' <<<"$dump" >&2; exit 1; }

DSH_HOME="$HOME_DIR" MOCK_API_KEY=mock "$DSH" --profile headless \
  --patch "$HOME_DIR/provider.yml" --patch "$HOME_DIR/host.yml" "Reply with the single word: ok" >"$HOME_DIR/run.log" 2>&1
status=$?
echo "dsh home: $HOME_DIR"
echo "session output: $(tail -1 "$HOME_DIR/run.log")"
[[ $status -eq 0 ]] || { echo "FAIL: the headless session exited $status" >&2; tail -5 "$HOME_DIR/run.log" >&2; exit 1; }
echo "OK: compaction tuned on the profile plane and a headless session ran under it"
