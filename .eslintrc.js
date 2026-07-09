module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      // The editor under webview-editor/ is plain browser JavaScript (it runs
      // inside the WebView, not React Native), so it uses DOM globals like
      // `atob`, `TextDecoder`, and `getComputedStyle`. Lint it with the browser
      // environment rather than the React Native one.
      files: ['webview-editor/**/*.js'],
      env: { browser: true },
    },
  ],
};
