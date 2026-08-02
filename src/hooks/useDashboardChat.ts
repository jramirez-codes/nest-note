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
