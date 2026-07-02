/**
 * ainotepad — a markdown notepad you flip through page by page.
 *
 * @format
 */

import './global.css';

import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import NotebookScreen from './src/screens/NotebookScreen';
import { theme } from './src/theme/colors';

// The app ships a single dark theme (Catppuccin Mocha), so the status bar is
// always light content over the dark base.
function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor={theme.background} />
      <NotebookScreen />
    </SafeAreaProvider>
  );
}

export default App;
