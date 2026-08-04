#!/usr/bin/env bash
# Spike A / Step 4 validation helper: compares our remux output against an
# ffmpeg -c copy reference for the same source + time range. See
# prompts/m0.5-spike-prompts.md Step 4 -- "produce a reference with ffmpeg
# -ss X -to Y -i input -c copy ref.mp4 and compare frame counts, durations,
# and per-track timescales against yours. They will not be byte-identical;
# I care that they agree structurally."
#
# Usage: scripts/compare-remux.sh <source.mp4> <ours.mp4> <inSec> <outSec>

set -euo pipefail

SRC="${1:?usage: compare-remux.sh <source.mp4> <ours.mp4> <inSec> <outSec>}"
OURS="${2:?usage: compare-remux.sh <source.mp4> <ours.mp4> <inSec> <outSec>}"
IN_SEC="${3:?usage: compare-remux.sh <source.mp4> <ours.mp4> <inSec> <outSec>}"
OUT_SEC="${4:?usage: compare-remux.sh <source.mp4> <ours.mp4> <inSec> <outSec>}"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found on PATH" >&2; exit 1; }

REF="$(mktemp -t remux-ref-XXXXXX).mp4"
trap 'rm -f "$REF"' EXIT

echo "generating reference: ffmpeg -ss $IN_SEC -to $OUT_SEC -i $SRC -map 0 -c copy $REF"
ffmpeg -y -v error -ss "$IN_SEC" -to "$OUT_SEC" -i "$SRC" -map 0 -c copy "$REF"

report() {
  local label="$1" file="$2"
  echo "--- $label ($file) ---"
  ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$file"
  ffprobe -v error -show_entries stream=index,codec_type,codec_name,time_base,start_time,duration -of default "$file"
  echo -n "video frame count: "
  ffprobe -v error -select_streams v:0 -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$file"
  echo
}

report "reference" "$REF"
report "ours" "$OURS"

echo "--- decode check (ours) ---"
ffmpeg -v error -i "$OURS" -f null - && echo "ours decodes with zero errors"
