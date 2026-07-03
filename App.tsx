/**
 * ainotepad — a markdown notepad you flip through page by page.
 *
 * @format
 */

import './global.css';

import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import NotebookScreen from './src/screens/NotebookScreen';
import WebViewSpike from './src/spikes/WebViewSpike';
import { theme } from './src/theme/colors';

// Dev-only: flip to true to preview the CodeMirror-in-WebView editor spike in
// isolation. The editor now lives in the real notebook, so this stays false.
const SHOW_WEBVIEW_SPIKE = false;

// The app ships a single dark theme (Catppuccin Mocha), so the status bar is
// always light content over the dark base.
function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={theme.background} />
      {SHOW_WEBVIEW_SPIKE ? <WebViewSpike /> : <NotebookScreen />}
    </SafeAreaProvider>
  );
}

export default App;
