#!/usr/bin/env bash
# Extract visit-able panorama frames from a (360°) video.
#   tools/extract-panoramas.sh <video-or-youtube-url> <landmark-slug> [keep]
# Downloads with yt-dlp if given a URL, scene-detects distinct views with
# ffmpeg, keeps the sharpest N frames (largest JPEGs) as
# photos/panoramas/<slug>-1.jpg … Then register them in PANORAMA_SPOTS
# (app.js) — set mode:'flat' if the source turns out not to be equirect.
set -euo pipefail
SRC="${1:?usage: extract-panoramas.sh <video-or-url> <slug> [keep]}"
SLUG="${2:?missing slug}"
KEEP="${3:-3}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
VID="$DIR/photos/videos/$SLUG-source.mp4"
OUT="$DIR/photos/panoramas"
mkdir -p "$DIR/photos/videos" "$OUT"

if [[ "$SRC" == http* ]]; then
  yt-dlp -f "bv*[height<=1920]+ba/b" -o "$VID" "$SRC"
else
  VID="$SRC"
fi

TMP=$(mktemp -d)
ffmpeg -y -v warning -i "$VID" -vf "select='gt(scene,0.22)'" -fps_mode vfr "$TMP/scene-%03d.jpg" || true
SCENES=$(ls "$TMP"/scene-*.jpg 2>/dev/null | wc -l | tr -d ' ')
if (( SCENES < KEEP )); then
  ffmpeg -y -v warning -i "$VID" -vf fps=1/45 "$TMP/even-%03d.jpg"
fi
ls -S "$TMP"/*.jpg | head -n "$KEEP" | sort | awk -v out="$OUT" -v slug="$SLUG" \
  '{n++; print $0 " " out "/" slug "-" n ".jpg"}' | while read -r src dst; do
  [[ -e "$dst" ]] || mv "$src" "$dst"
done
rm -rf "$TMP"
echo "kept:"; ls -l "$OUT/$SLUG"-*.jpg
