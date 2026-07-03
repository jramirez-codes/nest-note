const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withNativeWind } = require('nativewind/metro');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // The `webview-editor/` sub-project has its own node_modules (CodeMirror);
    // keep Metro from crawling it — the app only imports the built HTML string.
    blockList: /\/webview-editor\/.*/,
  },
};

module.exports = withNativeWind(
  mergeConfig(getDefaultConfig(__dirname), config),
  { input: './global.css' },
);
