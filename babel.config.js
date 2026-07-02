module.exports = {
  presets: [
    'module:@react-native/babel-preset',
    'nativewind/babel',
  ],
  // Must be the last plugin. Powers Reanimated 4 and react-native-live-markdown.
  plugins: ['react-native-worklets/plugin'],
};
