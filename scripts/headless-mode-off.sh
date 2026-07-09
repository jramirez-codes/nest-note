#!/usr/bin/env bash
# Reverse of headless-mode-on.sh: reset the HDMI connector back to normal
# auto-detect behavior at the kernel/DRM level, then re-probe with xrandr.
# Run this when you want the machine to behave normally again with a
# physically attached monitor (e.g. you're sitting down at it for maintenance).
#
# If your X session isn't DISPLAY :0, edit DISPLAY_NUM below (check with `who`).

set -euo pipefail

DISPLAY_NUM=":0"

if [[ $EUID -ne 0 ]]; then
  exec sudo "$0" "$@"
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

echo "Resetting $DRM_CONNECTOR to auto-detect..."
echo detect > "$DRM_CONNECTOR/status"
sleep 1

if XAUTH=$(find_xauth); then
  XR_OUTPUT=$(sudo -u "$TARGET_USER" DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTH" xrandr --query 2>/dev/null | awk '$1 ~ /^HDMI/{print $1; exit}')
  if [[ -n "$XR_OUTPUT" ]]; then
    sudo -u "$TARGET_USER" DISPLAY="$DISPLAY_NUM" XAUTHORITY="$XAUTH" xrandr --output "$XR_OUTPUT" --auto || true
    echo "xrandr re-detected $XR_OUTPUT."
  else
    echo "Warning: could not find a matching xrandr HDMI output; run 'xrandr --query' manually if needed." >&2
  fi
else
  echo "Warning: could not locate Xauthority for $TARGET_USER; skipping xrandr step." >&2
fi

echo "Headless mode OFF. Monitor should be live if physically connected."
