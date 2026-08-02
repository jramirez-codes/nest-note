import { useSyncExternalStore } from 'react';
import {
  getState,
  subscribe,
  type DashboardChatState,
} from '../server/dashboardChat';

/**
 * Subscribe to the dashboard's voice chat (../server/dashboardChat).
 *
 * Two places read it and neither owns it: the card floating over the dashboard,
 * which shows the conversation, and the screen, whose footer button sends the
 * pending message or stops the reply. The store stays React-free, as the app's
 * other stores do; this is the one adapter onto it.
 */
export function useDashboardChat(): DashboardChatState {
  return useSyncExternalStore(subscribe, getState);
}

/**
 * Just how much room the card is taking on screen — for the dashboard *under*
 * it, which pads its scroll by that much so its last cards can still be brought
 * out from behind the card.
 *
 * Deliberately a number and not the whole state: the dashboard would otherwise
 * re-render on every chunk of speech landing in the draft, which is several
 * times a second for as long as the mic is live.
 */
export function useDashboardChatOverlayHeight(): number {
  return useSyncExternalStore(subscribe, () => getState().overlayHeight);
}
