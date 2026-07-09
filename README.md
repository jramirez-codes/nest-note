# ainotepad

A markdown notepad you flip through **page by page**, like a physical pad. Each
note is a full-screen page; swipe left/right to move between them, and tap the
blank sheet at the end to start a new note. Text is edited as live-preview
markdown via **CodeMirror 6** running in a WebView (see the editor section below).

## The three pieces

The project is three cooperating parts, each independently buildable:

```
src/            React Native app (this repo's main deliverable)
webview-editor/  CodeMirror 6 editor, bundled into the app as one HTML string
server/          Optional Go companion server for the AI features
```

You can run the app with just the first two. `server/` only comes into play for
the in-note AI commands (below); without a paired server the notepad is a fully
functional offline markdown pad.

## App architecture (`src/`)

The code is organized into small, single-responsibility layers so features can
be added without churn:

```
src/
  types/       Domain model (Note) and pure helpers (deriveTitle)
  storage/     SQLite persistence — the single source of truth (see below)
  hooks/       useNotes / useNotebookPages / useServerStatus — state + actions
  theme/       Semantic color tokens (Catppuccin Mocha)
  components/  UI pieces: NoteEditorWebView, PaperPager, DashboardPage, headers…
  screens/     NotebookScreen — composes the paged pad
  server/      Client for the companion server's pinned-TLS protocol (below)
  webview/     editorHtml.ts — the generated editor bundle (do not edit by hand)
  utils/       Framework-agnostic helpers (id, date, async)
```

Key design choices that keep it scalable:

- **SQLite is the single source of truth.** Notes, notebooks, full-text search
  and a key/value store all live in one `ainotepad.sqlite` file via
  [op-sqlite](https://github.com/OP-Engineering/op-sqlite). The app only imports
  from `src/storage/` and never touches SQL directly; `initStorage()` (called
  once in `App.tsx`) opens and migrates the DB before any screen renders. See
  the storage-layer breakdown in `docs/storage-migration.md`.
- **Derived data isn't stored.** Previews come from `deriveTitle(content)`, so
  there's nothing to keep in sync. (Page titles are a separate AI-generated
  field, set by `/clean` and deliberately left untouched by content edits.)
- **Pages are memoized and self-scoped.** Editing one page doesn't re-render its
  neighbors, and each editor owns its text so the caret never jumps.

## Editor: CodeMirror 6 in a WebView (`webview-editor/`)

Notes are edited with **CodeMirror 6** running inside a `react-native-webview`,
giving Obsidian-style live preview — markdown syntax marks hide to render clean
text and reveal again on the line you're editing — while keeping **markdown as
the stored format**. Because the editor reads and writes plain markdown, existing
notes just work and there is no data migration.

The editor is a small isolated web app under `webview-editor/` that bundles CM6
into a single self-contained HTML string via esbuild. Rebuild it after any change
under `webview-editor/src/`:

    cd webview-editor && npm run build

That regenerates `src/webview/editorHtml.ts`, which `NoteEditorWebView` loads into
the WebView. The RN↔web bridge is JSON messages: markdown is injected in once the
editor is ready, and edits post markdown back out. Metro is configured to ignore
`webview-editor/` (it carries its own `node_modules`).

The editor source is split by concern under `webview-editor/src/`: `markdown/`
(live-preview decorations and custom widgets), `ai/` (the inline command cards),
`theme/`, `ui/`, and `bridge.js` / `index.js` for the RN handshake.

## Companion server & AI commands (`server/`)

Typing a slash command on a page turns it into a live **card** backed by the Go
companion server under `server/`, which streams the Claude Code CLI (and a few
laptop capabilities) to the phone. Commands include:

- `/ask` — ask Claude a question; `/clean` — tidy a note and title it.
- `/code <name>` — a persistent multi-turn Claude Code agent in `projects/<name>`.
- `/run <cmd>` — stream a live laptop shell command into the card.
- `/view <port>` — mirror a laptop `localhost` dev server into an iframe card.
- `/record` — record the device microphone in the background.

The connection is **pinned TLS over a token-authenticated tunnel**: you pair once
by scanning a QR (transferring the SPKI pin + a one-time code), and the app
reconnects silently afterward. The client core lives in `src/server/` and is
deliberately platform-agnostic — the same code is exercised by a Node harness and
by the app, with only the pinned-socket transport (`nativeTransport.ts`) being
native. Runs are hoisted into a long-lived `runRegistry` so they survive swiping
between pages or swapping notebooks. See `docs/companion-server-setup.md` for the
native setup, and `server/main.go`'s flags for the `-allow-exec/-code/-view`
capability gates (all off by default — each runs code as you over the tunnel).

## Roadmap hooks

Natural next features slot into the existing seams: search/sort in `useNotes`,
tags/folders on the `Note` type (the columns already exist), and multiple
notebooks (the schema is notebook-scoped from day one — today there is a single
`DEFAULT_NOTEBOOK_ID`).

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
