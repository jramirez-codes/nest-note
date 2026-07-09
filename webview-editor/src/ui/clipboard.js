// Copy `text` to the clipboard from within a tap. An html-source WebView is not
// a secure context, so navigator.clipboard is usually unavailable; the
// execCommand path works because it runs inside a user gesture.
export function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return;
    }
  } catch (e) {}
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
  } catch (e) {}
  document.body.removeChild(ta);
}
