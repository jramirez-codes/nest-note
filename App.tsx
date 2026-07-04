/**
 * ainotepad — a markdown notepad you flip through page by page.
 *
 * @format
 */

import './global.css';

import { useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import NotebookScreen from './src/screens/NotebookScreen';
import WebViewSpike from './src/spikes/WebViewSpike';
import { initStorage } from './src/storage';
import { theme } from './src/theme/colors';

// Dev-only: flip to true to preview the CodeMirror-in-WebView editor spike in
// isolation. The editor now lives in the real notebook, so this stays false.
const SHOW_WEBVIEW_SPIKE = false;

// The app ships a single dark theme (Catppuccin Mocha), so the status bar is
// always light content over the dark base.
function App() {
  // Open + migrate the database (and run the one-time MMKV import) before any
  // screen reads notes, so the first render already sees SQLite as the source
  // of truth. Rendering is gated on this so the UI never queries an unready DB.
  const [storageReady, setStorageReady] = useState(false);

  useEffect(() => {
    let active = true;
    initStorage()
      .then(() => {
        if (active) {
          setStorageReady(true);
        }
      })
      .catch(error => {
        // A failed migration leaves the DB untouched and retries next launch;
        // surface it rather than rendering against half-ready storage.
        console.error('[storage] initialization failed', error);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    // GestureHandlerRootView must wrap the whole app so the dashboard's
    // long-press-drag gestures are recognized (a no-op cost elsewhere).
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" backgroundColor={theme.background} />
        {!storageReady ? (
          <View className="flex-1 items-center justify-center bg-background">
            <ActivityIndicator />
          </View>
        ) : SHOW_WEBVIEW_SPIKE ? (
          <WebViewSpike />
        ) : (
          <NotebookScreen />
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default App;
