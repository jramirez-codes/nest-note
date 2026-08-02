---
name: crop-shots
description: Crop the Android status bar (clock/wifi/battery) off new product screenshots, screen recordings, and poster frames before they go into the docs site. Use whenever screenshots or demo videos are added or updated under site/src/assets/shots/ or site/public/, or the user asks to clean/crop app captures.
---

# Crop status bar from product captures

All landing/docs media is captured on a 1080x2340 Android phone whose system
status bar (clock, wifi, battery, recording chip, mic privacy pill) occupies
the top **84px**. Published assets must not show it. The optional bottom
gesture-nav bar is **80px** (currently kept; crop only if asked).

## Asset locations

- Screenshots: `site/src/assets/shots/*.jpg` (Astro image pipeline — no
  hardcoded dimensions anywhere, new sizes flow through automatically).
- Demo videos + poster frames: `site/public/*.mp4`, `site/public/*-poster.jpg`
  (referenced with `withBase()`; components set only a display width).

## Workflow

1. Run the bundled script on each new file (crops in place, so make sure the
   pre-crop file is committed or otherwise recoverable first):

   ```bash
   .claude/skills/crop-shots/crop.sh site/src/assets/shots/new-shot.jpg site/public/new-demo.mp4
   ```

   It scales the 84px crop by width (e.g. 56px for a 720-wide poster), keeps
   even dimensions for yuv420p, re-encodes video as x264 crf 21 + faststart
   with audio copied, and jpg at `-q:v 2`. Before touching a file it verifies
   the 12px band *below* the crop line is empty background on **every frame**;
   if not, it refuses (exit 2) — the file is already cropped or the layout
   changed. Never bypass the refusal by editing the constants blindly:
   measure first.

2. **Manual measurement** (only when the script refuses on a genuinely
   uncropped file — new device, changed bar height):

   ```bash
   # zoomed top strip with a gridline every 25 source px:
   ffmpeg -y -i IN -vf "crop=iw:150:0:0,scale=iw:600:flags=neighbor,drawgrid=w=iw:h=100:t=2:c=red@0.8" -frames:v 1 top.png
   # max luma in a candidate band (rows Y..Y+16) across ALL frames — must stay
   # near background (~44) at every timestamp before Y is a safe crop line:
   ffprobe -v error -f lavfi -i "movie=IN,crop=iw:16:0:Y,signalstats" \
     -show_entries frame_tags=lavfi.signalstats.YMAX -of csv=p=0 | sort -n | tail -3
   ```

   Beware transient system UI that dips below the static icons: the red
   screen-recording chip (~y=75) and the green mic privacy pill (~y=84) both
   reach lower than the clock/battery. Sweep the whole video, not one frame.
   Then update `TOP`/`REF_W` in `crop.sh` and re-run.

3. **Verify visually**: extract the top ~200px of each output and Read it —
   no system UI remnants, app header starts with a natural margin:

   ```bash
   ffmpeg -y -i OUT -vf "crop=iw:200:0:0" -frames:v 1 check.png
   ```

4. **Posters must match their video.** Either crop the poster with the same
   script (it scales by width) or regenerate it from the cropped video:
   `ffmpeg -i demo.mp4 -frames:v 1 -q:v 3 -vf scale=720:-2 demo-poster.jpg`
   (hero poster is 720 wide; dictation poster is full-width).

5. `cd site && npm run build` must pass. Asset-only changes have no docs
   impact — say so in the summary per CLAUDE.md.
