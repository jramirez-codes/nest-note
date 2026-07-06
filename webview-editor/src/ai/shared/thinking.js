// The pulsing "Thinking…" dots shown while an answer/clean/ingest is streaming
// before its first token lands. Three blinking dots (staggered by CSS) plus an
// optional label. Used by /ask, /chat, /clean and /ingest.
export function thinkingDots({ tag = 'div', className = 'cm-ask-thinking', label } = {}) {
  const el = document.createElement(tag);
  el.className = className;
  for (let i = 0; i < 3; i++) {
    const dot = document.createElement('span');
    dot.className = 'cm-ask-dot';
    el.appendChild(dot);
  }
  if (label) {
    const l = document.createElement('span');
    l.textContent = label;
    el.appendChild(l);
  }
  return el;
}
