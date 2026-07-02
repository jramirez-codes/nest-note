const { mocha, semantic } = require('./src/theme/catppuccin');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './App.tsx',
    './src/**/*.{js,jsx,ts,tsx}',
    './components/**/*.{js,jsx,ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    extend: {
      // Semantic roles (bg-background, text-muted, …) plus the raw Catppuccin
      // Mocha palette (bg-mauve, text-red, …) for the rare one-off. Prefer the
      // semantic names. Single source of truth: src/theme/catppuccin.js.
      colors: {
        ...mocha,
        ...semantic,
      },
    },
  },
  plugins: [],
};
