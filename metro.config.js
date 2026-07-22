const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withNativeWind } = require('nativewind/metro');

/** Escape a literal string for safe interpolation into a RegExp. */
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Anchor a sub-project path to this repo, so we only block *our* copy. */
const subProject = name =>
  new RegExp(`^${esc(__dirname)}${esc(path.sep)}${name}${esc(path.sep)}.*`);

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // `webview-editor/` (CodeMirror) and `site/` (Astro docs) are independent
    // sub-projects carrying their own node_modules. Metro must not crawl them
    // or it hits duplicate-package haste collisions — the app imports neither,
    // only the generated `src/webview/editorHtml.ts`.
    blockList: [subProject('webview-editor'), subProject('site')],
  },
};

module.exports = withNativeWind(
  mergeConfig(getDefaultConfig(__dirname), config),
  { input: './global.css' },
);
