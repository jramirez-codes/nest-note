#!/usr/bin/env bash
# Bracket a physical HDMI unplug/replug so the amdgpu driver doesn't freeze
# the machine on cable removal.
#
# Usage:
#   hdmi-safe-unplug.sh pre    # run BEFORE physically pulling the cable
#   hdmi-safe-unplug.sh post   # run AFTER physically plugging it back in
#
# 'pre' forces the connector to stay "on" at the kernel level, so amdgpu
# ignores the hotplug-remove signal instead of trying (and failing) to tear
# the display down while you're mid-session.
# 'post' resets the connector to auto-detect so the kernel re-probes the
# reconnected monitor and the picture comes back.
#
# If your X session isn't DISPLAY :0, edit DISPLAY_NUM below (check with `who`).

set -euo pipefail

DISPLAY_NUM=":0"

MODE="${1:-}"
if [[ "$MODE" != "pre" && "$MODE" != "post" ]]; then
  echo "Usage: $0 pre|post"
  echo "  pre  - run before physically unplugging the HDMI cable"
  echo "  post - run after physically plugging the HDMI cable back in"
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  exec sudo "$0" "$MODE"
fi

TARGET_USER="${SUDO_USER:-$(logname)}"

find_xauth() {
  local uid
  uid=$(id -u "$TARGET_USER")
  for candidate in "/run/user/$uid"/.mutter-Xwaylandauth.* "/run/user/$uid/gdm/Xauthority" "/home/$TARGET_USER/.Xauthority"; do
    [[ -f "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  return 1
}

DRM_CONNECTOR=""
for f in /sys/class/drm/card*-HDMI-*; do
  st=$(cat "$f/status" 2>/dev/null)
  if [[ "$st" == "connected" || "$st" == "on" ]]; then
    DRM_CONNECTOR="$f"
    break
  fi
done
if [[ -z "$DRM_CONNECTOR" ]]; then
  DRM_CONNECTOR=$(find /sys/class/drm -maxdepth 1 -name "card*-HDMI-*" 2>/dev/null | head -n1)
fi
if [[ -z "$DRM_CONNECTOR" ]]; then
  echo "Error: no HDMI connector found under /sys/class/drm/" >&2
  exit 1
fi

run_xrandr() {
  local xauth
  if xauth=$(find_xauth); then
    sudo -u "$TARGET_USER" DISPLAY="$DISPLAY_NUM" XAUTHORITY="$xauth" xrandr "$@" 2>/dev/null || true
  fi
}

XR_OUTPUT=$(run_xrandr --query | awk '$1 ~ /^HDMI/{print $1; exit}')

if [[ "$MODE" == "pre" ]]; then
  echo "Forcing $DRM_CONNECTOR to stay 'on'..."
  echo on > "$DRM_CONNECTOR/status"
  sleep 1
  [[ -n "$XR_OUTPUT" ]] && run_xrandr --output "$XR_OUTPUT" --auto
  echo "Safe to unplug the HDMI cable now."
else
  echo "Resetting $DRM_CONNECTOR to auto-detect..."
  echo detect > "$DRM_CONNECTOR/status"
  sleep 1
  [[ -n "$XR_OUTPUT" ]] && run_xrandr --output "$XR_OUTPUT" --auto
  echo "Monitor should be live now."
fi
