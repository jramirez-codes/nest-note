// JSON message bridge to the React Native host. Web → RN messages ride over
// window.ReactNativeWebView; RN → web calls go through the window.__* functions
// defined in editor.js. A no-op when running outside the WebView (e.g. tests).
export function post(msg) {
  if (window.ReactNativeWebView) {
    window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
}
