import React from 'react';
import { View } from 'react-native';
import { useServerStatus } from '../hooks/useServerStatus';

/**
 * A small status bubble showing whether the companion server is reachable:
 * green when connected, red when disconnected, and a dim overlay while an
 * initial/ongoing probe is in flight. Sits next to the page title.
 */
function ServerStatusDot() {
  const status = useServerStatus();

  // Raw Catppuccin palette classes (see tailwind.config.js) — green/red carry
  // the connected/disconnected meaning; overlay0 is the neutral "checking" dim.
  const color =
    status === 'connected'
      ? 'bg-green'
      : status === 'disconnected'
        ? 'bg-red'
        : 'bg-overlay0';

  const label =
    status === 'connected'
      ? 'Connected to server'
      : status === 'disconnected'
        ? 'Not connected to server'
        : 'Checking server connection';

  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={label}
      className={`h-2.5 w-2.5 rounded-full ${color}`}
    />
  );
}

export default React.memo(ServerStatusDot);
