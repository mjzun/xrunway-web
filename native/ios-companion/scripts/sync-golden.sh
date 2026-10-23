#!/usr/bin/env bash
#
# sync-golden.sh — copy the checked-in golden-vector JSONs (repo root
# test/golden/, the single source of truth emitted by
# scripts/gen-golden-vectors.mjs) into the XRunwayCoreTests bundle so the
# Swift XCTest harness can load them as target resources.
#
# The vectors live OUTSIDE native/ios-companion (repo test/golden/) and are
# stamped/validated web-side; they must never be hand-edited here. This copies
# the current committed vectors into Tests/XRunwayCoreTests/golden/ (a
# committed, reproducible mirror). Re-run whenever the upstream vectors
# regenerate.
#
# SET-MIRROR semantics (not additive): the DST *.json set is cleared before
# the copy, so a renamed or removed upstream family can never leave a stale
# orphan JSON behind. The mirror is therefore an EXACT set-mirror of SRC and
# the script is idempotent across renames, not just a fixed module set.
#
# Usage:
#   native/ios-companion/scripts/sync-golden.sh           # set-mirror SRC -> DST
#   native/ios-companion/scripts/sync-golden.sh --check   # verify SRC == DST,
#     exit nonzero on ANY divergence (differing bytes, or a family present in
#     one but not the other). Wired as a preBuildScripts phase on the
#     XRunwayCoreTests target (project.yml) so the Swift test build REFUSES to
#     compile against a lagging mirror.
#
set -euo pipefail

# Resolve this script's dir, then the ios-companion root and the repo root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${IOS_ROOT}/../.." && pwd)"

SRC="${REPO_ROOT}/test/golden"
DST="${IOS_ROOT}/Tests/XRunwayCoreTests/golden"

MODE="sync"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ $# -gt 0 ]]; then
  echo "sync-golden: unknown argument '${1}' (expected none or --check)" >&2
  exit 2
fi

if [[ ! -d "${SRC}" ]]; then
  echo "sync-golden: source vectors not found at ${SRC}" >&2
  exit 1
fi

if [[ "${MODE}" == "check" ]]; then
  # Freshness gate: SRC and DST must hold the SAME set of *.json files, each
  # byte-identical. This catches BOTH ways the mirror can drift — differing
  # bytes AND a family present in only one dir (rename/removal/orphan). Only
  # *.json is compared, so non-golden bundle chrome (.DS_Store, etc.) is never
  # flagged. `diff -q` prints "Files ... differ" / "Only in ..." on drift and
  # exits nonzero; we aggregate across the union of both file sets so a
  # one-sided family is reported, not silently skipped.
  if [[ ! -d "${DST}" ]]; then
    echo "sync-golden --check: mirror not found at ${DST} — run sync-golden.sh" >&2
    exit 1
  fi
  src_set="$(cd "${SRC}" && ls -1 *.json 2>/dev/null || true)"
  dst_set="$(cd "${DST}" && ls -1 *.json 2>/dev/null || true)"
  union="$(printf '%s\n%s\n' "${src_set}" "${dst_set}" | sort -u | sed '/^$/d')"
  drift=0
  drift_report=""
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    if [[ ! -f "${SRC}/${f}" ]]; then
      drift_report+="  ORPHAN in mirror (not emitted by generator): ${f}"$'\n'
      drift=1
    elif [[ ! -f "${DST}/${f}" ]]; then
      drift_report+="  MISSING from mirror (present in SRC): ${f}"$'\n'
      drift=1
    elif ! cmp -s "${SRC}/${f}" "${DST}/${f}"; then
      drift_report+="  STALE bytes: ${f}"$'\n'
      drift=1
    fi
  done <<< "${union}"
  if [[ "${drift}" -eq 0 ]]; then
    echo "sync-golden --check: mirror is fresh ($(printf '%s\n' "${src_set}" | sed '/^$/d' | wc -l | tr -d ' ') families match)"
    exit 0
  fi
  echo "sync-golden --check: STALE mirror — SRC (${SRC}) and DST (${DST}) diverge:" >&2
  printf '%s' "${drift_report}" >&2
  echo "  -> regenerate at a clean HEAD (node scripts/gen-golden-vectors.mjs) then re-run sync-golden.sh" >&2
  exit 1
fi

mkdir -p "${DST}"
# SET-MIRROR: clear the DST *.json set FIRST so a removed/renamed upstream
# family vanishes from the mirror instead of lingering as a dead bundle
# resource, THEN copy the current SRC set in. Keeps the mirror an exact copy
# of SRC (idempotent across renames). Only *.json is touched.
rm -f "${DST}"/*.json
cp "${SRC}"/*.json "${DST}/"

echo "sync-golden: set-mirrored $(ls -1 "${SRC}"/*.json | wc -l | tr -d ' ') golden files -> ${DST}"
