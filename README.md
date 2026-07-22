# NestNote

A markdown notepad you flip through **page by page**, like a physical pad. Each
note is a full-screen page; swipe left/right to move between them, and tap the
blank sheet at the end to start a new note. Text is edited as live-preview
markdown via **CodeMirror 6** running in a WebView.

Typing a slash command on a page turns it into a live **card** backed by a Go
companion server on your own laptop — `/ask` a question, `/code` in a project,
`/run` a command, `/view` a dev server. There is no hosted service in that path.

Without a paired server, it's a fully functional **offline markdown pad**.

📖 **[Documentation →](https://jramirez-codes.github.io/nest-note/)**

> This README is a pitch and a repo map. Everything operational — install,
> pairing, the security model, all 15 slash commands, architecture — lives in
> the docs site, whose source is in [`site/`](site/).

## The three pieces

The project is three cooperating parts, each independently buildable:

```
src/             React Native app (this repo's main deliverable)
webview-editor/  CodeMirror 6 editor, bundled into the app as one HTML string
server/          Optional Go companion server for the AI features
```

Plus [`site/`](site/) — the Astro + Starlight landing page and documentation.

You can run the app with just the first two. `server/` only comes into play for
the in-note AI commands.

## Quick start

```bash
yarn install
yarn start          # Metro
yarn android        # or: yarn ios
```

For the AI commands, run the companion server on your laptop and pair once by
scanning the QR it prints:

```bash
cd server && go run . -root ~/nestnote-data
```

Full instructions: **[Install & run](https://jramirez-codes.github.io/nest-note/start/install/)**
and **[Server setup](https://jramirez-codes.github.io/nest-note/server/setup/)**.

> ⚠️ The server's `-allow-exec`, `-allow-code` and `-allow-view` flags are **off
> by default**, and each one runs code as your user account over the tunnel.
> Read the
> **[security model](https://jramirez-codes.github.io/nest-note/server/security/)**
> before enabling any of them. Note that the `yarn server:start` convenience
> script enables all three.

## Layout

```
src/
  types/       Domain model (Note) and pure helpers (deriveTitle)
  storage/     SQLite persistence — the single source of truth
  hooks/       useNotes / useNotebookPages / useServerStatus — state + actions
  theme/       Semantic color tokens (Catppuccin Mocha + Latte)
  components/  UI pieces: NoteEditorWebView, PaperPager, DashboardPage, headers…
  screens/     NotebookScreen — composes the paged pad
  server/      Client for the companion server's pinned-TLS protocol
  webview/     editorHtml.ts — the generated editor bundle (do not edit by hand)
  utils/       Framework-agnostic helpers (id, date, async)
```

Three design choices carry most of the weight:

- **SQLite is the single source of truth.** Notes, notebooks, full-text search
  and a key/value store all live in one `nestnote.sqlite` file via
  [op-sqlite](https://github.com/OP-Engineering/op-sqlite). `initStorage()` runs
  once in `App.tsx` before any screen renders.
- **Derived data isn't stored.** Previews come from `deriveTitle(content)`, so
  there's nothing to keep in sync.
- **Runs outlive their pages.** In-flight AI runs are hoisted into a long-lived
  `runRegistry`, so swiping between pages doesn't kill them.

Details: **[Architecture](https://jramirez-codes.github.io/nest-note/architecture/overview/)**.

## Generated files

Two build outputs are committed on purpose, so downstream builds don't need the
producing sub-project installed:

| File                                       | Produced by                          |
| ------------------------------------------ | ------------------------------------ |
| `src/webview/editorHtml.ts`                | `cd webview-editor && npm run build` |
| `site/src/styles/catppuccin.generated.css` | `cd site && npm run gen:theme`       |

Neither should be hand-edited.

## Contributing

```bash
yarn lint
yarn test
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


