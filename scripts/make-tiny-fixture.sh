#!/usr/bin/env bash
# Generates the small, COMMITTED fixture used by src/media/index/'s golden snapshot test and its
# two differential tests (vs mediabunny, vs the spike parser). Unlike fixtures/ (entirely
# gitignored -- see .gitignore), this file must survive a fresh clone, so it stays tiny: ~2
# seconds, 1 video + 1 audio track, real H.264 B-frames (so the presentation/decode-order
# distinction in query.ts is exercised against a real file, not just synthetic bytes).
#
# Usage: scripts/make-tiny-fixture.sh [output-path]

set -euo pipefail

OUT="${1:-src/media/index/__fixtures__/tiny.mp4}"
mkdir -p "$(dirname "$OUT")"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 1; }

ffmpeg -y -loglevel error \
  -f lavfi -i "mandelbrot=size=320x240:rate=24" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 2 \
  -c:v libx264 -profile:v high -pix_fmt yuv420p \
  -g 12 -bf 2 -sc_threshold 0 \
  -b:v 200k \
  -c:a aac -b:a 96k \
  -movflags +faststart \
  "$OUT"

echo "wrote $OUT ($(stat -f%z "$OUT" 2>/dev/null || stat -c%s "$OUT") bytes)"
