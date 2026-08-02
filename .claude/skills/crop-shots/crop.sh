#!/usr/bin/env bash
# crop.sh — remove the Android status bar (and optionally the gesture-nav bar)
# from product screenshots (.jpg/.png) and screen recordings (.mp4), in place.
#
# The constants below were measured on the product's capture device
# (1080x2340): every status-bar element — clock, icons, and the screen-record
# chip / mic privacy pill at their lowest — stays above y=84, while app
# content starts no higher than y=95. The band just below the crop line must
# therefore be empty background; the script checks that on EVERY frame and
# refuses to touch the file when the check fails (already-cropped file,
# different device, notification shade open, light theme, ...). See SKILL.md
# for the manual measurement procedure in that case.
set -euo pipefail

REF_W=1080   # width the constants were measured at; crops scale by W/REF_W
TOP=84       # status bar height at REF_W
BOTTOM=80    # gesture-nav bar height at REF_W (only cropped with -b)
BAND=12      # height of the safety band checked below the top crop line
THRESH=60    # max luma allowed in the band (dark app background is ~44)

do_bottom=0
if [[ "${1:-}" == "-b" ]]; then do_bottom=1; shift; fi
[[ $# -ge 1 ]] || { echo "usage: crop.sh [-b] <file.jpg|.png|.mp4> ..." >&2; exit 1; }

for f in "$@"; do
  read -r W H < <(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height -of csv=p=0 "$f" | tr ',' ' ')

  top=$(( (TOP * W / REF_W) & ~1 ))
  bottom=0; (( do_bottom )) && bottom=$(( (BOTTOM * W / REF_W) & ~1 ))
  newh=$(( H - top - bottom ))
  (( newh % 2 )) && { top=$(( top + 1 )); newh=$(( newh - 1 )); }

  band=$(( BAND * W / REF_W )); (( band < 4 )) && band=4
  ymax=$(ffprobe -v error -f lavfi \
    -i "movie=$f,crop=$W:$band:0:$top,signalstats" \
    -show_entries frame_tags=lavfi.signalstats.YMAX -of csv=p=0 \
    | tr -d ',' | sort -n | tail -1)
  if (( ymax > THRESH )); then
    echo "REFUSING $f: luma $ymax > $THRESH in rows $top-$(( top + band ))." >&2
    echo "File is already cropped, or its layout differs from the reference" >&2
    echo "device — measure manually per SKILL.md before cropping." >&2
    exit 2
  fi

  tmp="$(dirname "$f")/.crop-tmp-$$.${f##*.}"
  case "$f" in
    *.mp4)
      ffmpeg -v error -y -i "$f" -vf "crop=$W:$newh:0:$top" \
        -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p \
        -movflags +faststart -c:a copy "$tmp" ;;
    *.jpg|*.jpeg)
      ffmpeg -v error -y -i "$f" -vf "crop=$W:$newh:0:$top" -q:v 2 "$tmp" ;;
    *.png)
      ffmpeg -v error -y -i "$f" -vf "crop=$W:$newh:0:$top" "$tmp" ;;
    *)
      echo "REFUSING $f: unsupported extension" >&2; exit 1 ;;
  esac
  mv "$tmp" "$f"
  echo "cropped $f: ${W}x${H} -> ${W}x${newh} (top -${top}$( (( bottom )) && echo ", bottom -${bottom}" ))"
done
