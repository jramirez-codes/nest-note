/**
 * ainotepad — a markdown notepad you flip through page by page.
 *
 * @format
 */

import './global.css';

import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import NotebookScreen from './src/screens/NotebookScreen';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <NotebookScreen />
    </SafeAreaProvider>
  );
}

export default App;
