module.exports = {
  presets: [
    'module:@react-native/babel-preset',
    'nativewind/babel',
  ],
  // Must be the last plugin. Powers Reanimated 4 worklets.
  plugins: ['react-native-worklets/plugin'],
};
