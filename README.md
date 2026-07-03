# ainotepad

A markdown notepad you flip through **page by page**, like a physical pad. Each
note is a full-screen page; swipe left/right to move between them, and tap the
blank sheet at the end to start a new note. Text is edited as live-preview
markdown via **CodeMirror 6** running in a WebView (see the editor section below).

## Architecture

The code is organized into small, single-responsibility layers so features can
be added without churn. Everything app-specific lives under `src/`:

```
src/
  types/       Domain models (Note) and pure helpers (deriveTitle)
  data/        NotesRepository interface + swappable implementations
  hooks/       useNotes — state + actions, mediated through the repository
  theme/       Semantic color tokens
  components/  Presentational pieces (NoteEditorWebView, NotePage, NewNotePage, PageIndicator)
  screens/     NotebookScreen — composes the paged pad
  utils/       Framework-agnostic helpers (id, date, async)
```

Key design choices that keep it scalable:

- **Persistence is behind an interface.** The UI only knows `NotesRepository`.
  It's backed by `MmkvNotesRepository` (on-device [MMKV](https://github.com/mrousavy/react-native-mmkv)),
  with each note stored under its own `note.<id>` key so a single edit is one
  small write. `InMemoryNotesRepository` remains as a reference/test double. To
  change storage, drop in a new implementation and edit the single wiring line
  in `src/data/index.ts` — nothing else changes. The seed note is applied only
  when the store is empty, so it appears once and never clobbers real notes.
- **Derived data isn't stored.** Titles/previews come from `deriveTitle(content)`,
  so there's nothing to keep in sync.
- **Pages are memoized and self-scoped.** Editing one page doesn't re-render its
  neighbors, and each editor owns its text so the caret never jumps.

## Roadmap hooks

Natural next features slot into the existing seams: search/sort in `useNotes`,
tags/folders on the `Note` type, and sync by adding a repository implementation.

## Native dependency note

MMKV 4 is a [Nitro module](https://nitro.margelo.com/), so after pulling deps
you must rebuild the native app (JS-only fast refresh isn't enough):

```sh
# iOS
bundle exec pod install
yarn ios

# Android
yarn android
```

## Editor: CodeMirror 6 in a WebView

Notes are edited with **CodeMirror 6** running inside a `react-native-webview`,
giving Obsidian-style live preview — markdown syntax marks hide to render clean
text and reveal again on the line you're editing — while keeping **markdown as
the stored format**. Because the editor reads and writes plain markdown, existing
notes just work and there is no data migration.

The editor is a small isolated web app under `webview-editor/` that bundles CM6
into a single self-contained HTML string via esbuild. Rebuild it with:

    cd webview-editor && npm run build

That writes `src/webview/editorHtml.ts`, which `NoteEditorWebView` loads into the
WebView. The RN↔web bridge is JSON messages: markdown is injected in once the
editor is ready, and edits post markdown back out. Metro is configured to ignore
`webview-editor/` (it carries its own `node_modules`).

Live-preview decorations, custom widgets, and section-highlight toggles all live
as CM6 extensions in `webview-editor/src/editor.js`.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
