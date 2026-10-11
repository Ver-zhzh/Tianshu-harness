#!/usr/bin/env bash
# Pack better-sqlite3 native binary into dist/native/
# Called after `npm run build` and before `tauri:build`.
#
# Idempotent: safe to run multiple times. Skips silently (exit 0) if
# better-sqlite3 is not installed — the nullDb fallback handles it.

set -euo pipefail
cd "$(dirname "$0")/.."

exec node scripts/pack-native.js
