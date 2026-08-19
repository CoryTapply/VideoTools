#!/usr/bin/env bash
# Generates the local test fixtures for the video-trimmer spikes.
#
# Strategy: never encode multi-hour 2160p directly (it takes forever).
# Instead encode a realistic 60s segment once per profile, then multiply
# it to the target size with the concat demuxer + `-c copy`. This
# preserves real GOP structure and produces a genuinely large moov atom
# on the big fixtures -- exactly what the parsing spike needs to stress.
#
# Usage: scripts/make-fixtures.sh [output-dir]

set -euo pipefail

OUT_DIR="${1:-fixtures}"
mkdir -p "$OUT_DIR"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found on PATH" >&2; exit 1; }

# --- helpers ----------------------------------------------------------

# encode_seed <path> <width> <height> <fps> <gop_seconds> <vbitrate_kbps>
encode_seed() {
  local path="$1" w="$2" h="$3" fps="$4" gop_sec="$5" vkbps="$6"
  local gop=$(( fps * gop_sec ))
  echo "encoding seed: $path (${w}x${h}@${fps}, ${gop_sec}s GOP, ${vkbps}kbps)"
  ffmpeg -y -loglevel error \
    -f lavfi -i "mandelbrot=size=${w}x${h}:rate=${fps}" \
    -f lavfi -i "sine=frequency=440:sample_rate=48000" \
    -t 60 \
    -c:v libx264 -profile:v high -pix_fmt yuv420p \
    -g "$gop" -keyint_min "$gop" -sc_threshold 0 \
    -b:v "${vkbps}k" -minrate "${vkbps}k" -maxrate "${vkbps}k" -bufsize "$((vkbps * 2))k" \
    -c:a aac -b:a 192k \
    "$path"
}

# multiply_to_size <seed_path> <target_bytes> <out_path>
# Repeats the seed via concat -c copy until it meets-or-exceeds target_bytes.
multiply_to_size() {
  local seed="$1" target_bytes="$2" out="$3"
  local seed_bytes repeats list
  seed_bytes=$(stat -f%z "$seed" 2>/dev/null || stat -c%s "$seed")
  repeats=$(( (target_bytes + seed_bytes - 1) / seed_bytes ))
  echo "multiplying $seed x${repeats} -> $out (~$(( target_bytes / 1000 / 1000 / 1000 ))GB target)"

  list=$(mktemp)
  for ((i = 0; i < repeats; i++)); do
    printf "file '%s'\n" "$(readlink -f "$seed")" >> "$list"
  done
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$list" -c copy "$out"
  rm -f "$list"
}

report_fixture() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size_bytes duration frame_count keyframe_count
  size_bytes=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  duration=$(ffprobe -v error -select_streams v:0 -show_entries format=duration -of csv=p=0 "$f")
  frame_count=$(ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "$f")
  keyframe_count=$(ffprobe -v error -select_streams v:0 -skip_frame nokey -count_frames -show_entries stream=nb_read_frames -of csv=p=0 "$f")
  printf '\n== %s ==\nsize:      %s bytes (%.2f GB)\nduration:  %ss\nframes:    %s\nkeyframes: %s\n' \
    "$f" "$size_bytes" "$(awk "BEGIN{print $size_bytes/1e9}")" "$duration" "$frame_count" "$keyframe_count"
}

GB=$((1000 * 1000 * 1000))

# --- large-2160p.mp4 / large-noqs.mp4 (shared 2160p59.94 seed) --------
# 20GB target: at ~11Mbps that's roughly a 4-hour asset.
# SKIPPED for now (too slow/large) -- uncomment to regenerate.
# seed_2160p="$OUT_DIR/.seed-2160p.mp4"
# encode_seed "$seed_2160p" 3840 2160 60 2 11000
# raw_2160p="$OUT_DIR/.raw-2160p.mp4"
# multiply_to_size "$seed_2160p" $((20 * GB)) "$raw_2160p"
#
# echo "remuxing large-2160p.mp4 with faststart"
# ffmpeg -y -loglevel error -i "$raw_2160p" -c copy -movflags +faststart "$OUT_DIR/large-2160p.mp4"
#
# echo "remuxing large-noqs.mp4 without faststart (moov at end)"
# ffmpeg -y -loglevel error -i "$raw_2160p" -c copy -movflags -faststart "$OUT_DIR/large-noqs.mp4"
#
# rm -f "$seed_2160p" "$raw_2160p"

# --- mid-1080p.mp4 (fast iteration fixture) ---------------------------
seed_mid="$OUT_DIR/.seed-mid.mp4"
encode_seed "$seed_mid" 1920 1080 30 2 8500
multiply_to_size "$seed_mid" $((2 * GB)) "$OUT_DIR/.raw-mid.mp4"
ffmpeg -y -loglevel error -i "$OUT_DIR/.raw-mid.mp4" -c copy -movflags +faststart "$OUT_DIR/mid-1080p.mp4"
rm -f "$seed_mid" "$OUT_DIR/.raw-mid.mp4"

# --- longgop.mp4 (10s GOP -- worst case for keyframe snapping) --------
seed_longgop="$OUT_DIR/.seed-longgop.mp4"
encode_seed "$seed_longgop" 1920 1080 30 10 8500
multiply_to_size "$seed_longgop" $((2 * GB)) "$OUT_DIR/.raw-longgop.mp4"
ffmpeg -y -loglevel error -i "$OUT_DIR/.raw-longgop.mp4" -c copy -movflags +faststart "$OUT_DIR/longgop.mp4"
rm -f "$seed_longgop" "$OUT_DIR/.raw-longgop.mp4"

# --- vfr-screen.mp4 (variable frame rate, screen-recorder-like) -------
# Mostly-static frame with one moving element: select on scene-change
# score drops the near-duplicate frames and -fps_mode vfr keeps only the
# genuinely unique ones with correct timestamps, producing real (not
# simulated) VFR. No target size given for this one -- it's a behavioral
# fixture, not a size-stress fixture, so it's generated directly without
# multiplying.
#
# NOTE: this used to use `mpdecimate` + the (now-deprecated) `-vsync vfr`,
# but on this ffmpeg build (8.1.2) that combination hangs indefinitely on
# a flat `color=` source: mpdecimate/scene-diff both compare frames via a
# buffer that `color` appears to reuse unchanged across calls, so every
# frame reads as an exact duplicate and gets dropped -- forever, since
# the -t output-duration limit never advances when no frames are ever
# emitted. Piping the color source through a subtle temporal `noise`
# filter forces each frame's buffer to actually differ, which fixes scene
# scoring (verified non-zero/varying); `select` on scene score is used
# instead of `mpdecimate`, which still drops ~everything on this build
# even at its most sensitive thresholds.
echo "encoding vfr-screen.mp4"
ffmpeg -y -loglevel error \
  -f lavfi -t 300 -i "color=size=1920x1080:rate=30:color=0x202020,noise=alls=2:allf=t" \
  -f lavfi -t 300 -i "sine=frequency=220:sample_rate=48000" \
  -filter_complex "[0:v]drawbox=x='40+1400*abs(sin(t/3))':y=40:w=200:h=200:color=white@1:t=fill,select='gt(scene\,0.000003)'[v]" \
  -map "[v]" -map 1:a \
  -fps_mode vfr \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 60 \
  -b:v 1500k -c:a aac -b:a 128k -movflags +faststart \
  "$OUT_DIR/vfr-screen.mp4"

# --- test.mkv (Matroska container, same codec) ------------------------
echo "encoding test.mkv"
ffmpeg -y -loglevel error \
  -f lavfi -i "mandelbrot=size=1920x1080:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 300 \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 \
  -b:v 8500k -c:a aac -b:a 192k \
  "$OUT_DIR/test.mkv"

# --- tiny-2audio.mp4 (2 distinguishable audio tracks, for the audio-mix ----
# harness -- src/media/audio-mix/README.md / plan doc) -- 5s of mid-1080p's
# picture plus two synthesized tones an octave apart (440Hz vs 880Hz), so a
# human can tell by ear alone which track is actually playing.
echo "encoding tiny-2audio.mp4"
ffmpeg -y -loglevel error -i "$OUT_DIR/mid-1080p.mp4" \
  -f lavfi -i "sine=frequency=440:duration=5" \
  -f lavfi -i "sine=frequency=880:duration=5" \
  -map 0:v:0 -map 1:a -map 2:a -t 5 -c:v copy -c:a aac -shortest \
  "$OUT_DIR/tiny-2audio.mp4"

# --- report -------------------------------------------------------------
for f in large-2160p.mp4 large-noqs.mp4 mid-1080p.mp4 longgop.mp4 vfr-screen.mp4 test.mkv tiny-2audio.mp4; do
  report_fixture "$OUT_DIR/$f"
done
