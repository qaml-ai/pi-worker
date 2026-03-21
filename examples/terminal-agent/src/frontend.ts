/**
 * Frontend with ghostty-web terminal.
 * Browser acts like a dumb terminal: sends input/resize, renders ANSI from server.
 */

export function renderFrontend(sessionId: string): string {
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Terminal Agent</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&display=swap');
  :root {
    --page-bg: #111111;
    --page-fg: #d0d0d0;
    --panel-bg: #161616;
    --panel-border: #2a2a2a;
    --panel-muted: #7a7a7a;
    --panel-accent: #e5e5e5;
    --panel-success: #73c991;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--page-bg); color: var(--page-fg); height: 100%; width: 100%; overflow: hidden; }
  body { display: flex; flex-direction: column; }
  header {
    padding: 8px 16px; background: var(--panel-bg); border-bottom: 1px solid var(--panel-border);
    display: flex; align-items: center; gap: 12px; flex-shrink: 0; height: 36px;
  }
  header h1 { font-size: 13px; font-weight: 600; color: var(--panel-accent); }
  header .session { font-size: 11px; color: var(--panel-muted); font-family: 'JetBrains Mono', monospace; background: #101010; padding: 2px 8px; border-radius: 4px; }
  header .status { margin-left: auto; font-size: 11px; display: flex; align-items: center; gap: 6px; }
  header .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--panel-muted); transition: background 0.2s; }
  header .dot.connected { background: var(--panel-success); }
  #terminal-container { flex: 1; width: 100%; overflow: hidden; }
</style>
</head>
<body>
<header>
  <h1>Terminal Agent</h1>
  <span class="session">${sessionId}</span>
  <div class="status">
    <div class="dot" id="status-dot"></div>
    <span id="status-text">connecting</span>
  </div>
</header>
<div id="terminal-container"></div>

<script type="module">
import { init, Terminal } from 'https://esm.sh/ghostty-web@latest';

await init();

const term = new Terminal({
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', monospace",
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 50000,
  convertEol: false,
  // Match upstream Ghostty defaults rather than ghostty-web's built-in defaults.
  theme: {
    foreground: '#ffffff',
    background: '#282c34',
    cursor: '#ffffff',
    cursorAccent: '#282c34',
    selectionBackground: '#ffffff',
    selectionForeground: '#282c34',
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
  },
});

const container = document.getElementById('terminal-container');
term.open(container);

function findOsc8LinkRange(row, col, hyperlinkId) {
  const buffer = term.buffer.active;
  let startY = row;
  let startX = col;

  while (startX > 0) {
    const line = buffer.getLine(startY);
    if (!line) break;
    const cell = line.getCell(startX - 1);
    if (!cell || cell.getHyperlinkId() !== hyperlinkId) break;
    startX--;
  }

  if (startX === 0 && startY > 0) {
    let y = startY - 1;
    while (y >= 0) {
      const line = buffer.getLine(y);
      if (!line || line.length === 0) break;
      const lastCell = line.getCell(line.length - 1);
      if (!lastCell || lastCell.getHyperlinkId() !== hyperlinkId) break;
      startY = y;
      startX = 0;
      for (let x = line.length - 1; x >= 0; x--) {
        const cell = line.getCell(x);
        if (!cell || cell.getHyperlinkId() !== hyperlinkId) {
          startX = x + 1;
          break;
        }
      }
      if (startX === 0) y--;
      else break;
    }
  }

  let endY = row;
  let endX = col;
  const currentLine = buffer.getLine(endY);
  if (currentLine) {
    while (endX < currentLine.length - 1) {
      const cell = currentLine.getCell(endX + 1);
      if (!cell || cell.getHyperlinkId() !== hyperlinkId) break;
      endX++;
    }

    if (endX === currentLine.length - 1) {
      let y = endY + 1;
      const bufferLength = buffer.length;
      while (y < bufferLength) {
        const line = buffer.getLine(y);
        if (!line || line.length === 0) break;
        const firstCell = line.getCell(0);
        if (!firstCell || firstCell.getHyperlinkId() !== hyperlinkId) break;
        endY = y;
        endX = 0;
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell) break;
          if (cell.getHyperlinkId() !== hyperlinkId) continue;
          endX = x;
        }
        if (endX === 0) y++;
        else break;
      }
    }
  }

  return { start: { x: startX, y: startY }, end: { x: endX, y: endY } };
}

let cols = 80, rows = 24, ws, charW = 0, charH = 0;
let fitRaf = 0;
let fitTimer = 0;
let touchGesture = null;
let suppressTouchClickUntil = 0;

function openOsc8LinkAtClientPoint(clientX, clientY) {
  const canvas = container.querySelector('canvas');
  if (!canvas || !term.wasmTerm || !term.renderer) return false;

  const metrics = term.renderer.getMetrics?.();
  const cellW = term.renderer.charWidth || metrics?.width || charW;
  const cellH = term.renderer.charHeight || metrics?.height || charH;
  if (!cellW || !cellH) return false;

  const rect = canvas.getBoundingClientRect();
  const col = Math.floor((clientX - rect.left) / cellW);
  const row = Math.floor((clientY - rect.top) / cellH);
  if (col < 0 || row < 0) return false;

  const viewportY = Math.max(0, Math.floor(term.getViewportY?.() ?? 0));
  const scrollbackLength = term.wasmTerm.getScrollbackLength();
  const bufferRow = scrollbackLength - viewportY + row;
  const line = term.buffer.active.getLine(bufferRow);
  if (!line || col >= line.length) return false;

  const cell = line.getCell(col);
  const hyperlinkId = cell?.getHyperlinkId?.() ?? 0;
  if (!hyperlinkId) return false;

  const url = term.wasmTerm.getHyperlinkUri(hyperlinkId);
  if (!url) return false;

  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

term.registerLinkProvider({
  provideLinks(row, callback) {
    const line = term.buffer.active.getLine(row);
    if (!line || !term.wasmTerm) {
      callback();
      return;
    }

    const links = [];
    const seen = new Set();
    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell) continue;
      const hyperlinkId = cell.getHyperlinkId();
      if (hyperlinkId === 0 || seen.has(hyperlinkId)) continue;
      seen.add(hyperlinkId);

      const url = term.wasmTerm.getHyperlinkUri(hyperlinkId);
      if (!url) continue;

      links.push({
        text: url,
        range: findOsc8LinkRange(row, col, hyperlinkId),
        activate: () => {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
      });
    }

    callback(links.length > 0 ? links : void 0);
  },
});

let cols = 80, rows = 24, ws, charW = 0, charH = 0;
let fitRaf = 0;
let fitTimer = 0;
let touchGesture = null;
let suppressTouchClickUntil = 0;

function updateCellMetrics(force = false) {
  const canvas = container.querySelector('canvas');
  if (canvas && canvas.offsetWidth > 0 && canvas.offsetHeight > 0 && cols > 0 && rows > 0) {
    const nextW = canvas.offsetWidth / cols;
    const nextH = canvas.offsetHeight / rows;
    if (force || !charW || !charH) {
      charW = nextW;
      charH = nextH;
    }
  }
  if (!charW || !charH) {
    charW = 9.0;
    charH = 18;
  }
}

function getTerminalViewportRect() {
  const rect = container.getBoundingClientRect();
  const vv = window.visualViewport;
  if (!vv) return rect;
  return {
    width: Math.min(rect.width, vv.width),
    height: Math.max(0, Math.min(rect.height, vv.height - Math.max(0, rect.top))),
  };
}

function fitTerminal(force = false) {
  const rect = getTerminalViewportRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  updateCellMetrics(force && (!charW || !charH));

  const nc = Math.floor(rect.width / charW);
  const nr = Math.floor(rect.height / charH);
  if (nc < 10 || nr < 5) return;

  if (force || nc !== cols || nr !== rows) {
    cols = nc;
    rows = nr;
    term.resize(cols, rows);
    sendJSON({ type: 'resize', cols, rows });
  }
}

function scheduleFit(force = false) {
  if (fitRaf) cancelAnimationFrame(fitRaf);
  clearTimeout(fitTimer);
  fitTerminal(force);
  fitRaf = requestAnimationFrame(() => {
    fitRaf = 0;
    fitTerminal(force);
  });
  fitTimer = setTimeout(() => fitTerminal(force), 120);
}

scheduleFit(true);
window.addEventListener('resize', () => scheduleFit(true));
window.visualViewport?.addEventListener('resize', () => scheduleFit(true));
window.visualViewport?.addEventListener('scroll', () => scheduleFit(true));
new ResizeObserver(() => scheduleFit(true)).observe(container);

if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    scheduleFit(true);
    setTimeout(() => scheduleFit(true), 50);
    setTimeout(() => scheduleFit(true), 200);
  });
}

container.addEventListener('focusin', () => {
  scheduleKeyboardFit();
}, true);

const dot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
function setConnected(ok) {
  dot.className = 'dot' + (ok ? ' connected' : '');
  statusText.textContent = ok ? 'connected' : 'reconnecting';
}

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = proto + '//' + location.host + '/ws/${sessionId}';
let reconnectDelay = 1000;
const isSafari = /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(navigator.userAgent);
const isCoarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function sendJSON(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    try { term.reset(); } catch {}
    setConnected(true);
    reconnectDelay = 1000;
    sendJSON({ type: 'resize', cols, rows });
  };
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') term.write(event.data);
  };
  ws.onclose = () => {
    setConnected(false);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      connect();
    }, reconnectDelay);
  };
  ws.onerror = () => ws.close();
}

term.onData((data) => {
  sendJSON({ type: 'input', data });
});

document.addEventListener('keydown', (event) => {
  if (!isSafari || event.key !== 'Escape') return;
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;

  const active = document.activeElement;
  const terminalFocused = active === container || active === term.textarea || container.contains(active);
  if (!terminalFocused) return;

  event.preventDefault();
  event.stopPropagation();
  sendJSON({ type: 'input', data: '\x1b' });
}, true);

function dispatchTerminalWheel(deltaY, clientX, clientY) {
  const target = container.querySelector('canvas') || container;
  target.dispatchEvent(new WheelEvent('wheel', {
    deltaY,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
    clientX,
    clientY,
    bubbles: true,
    cancelable: true,
  }));
}

function scheduleKeyboardFit() {
  scheduleFit(true);
  setTimeout(() => scheduleFit(true), 50);
  setTimeout(() => scheduleFit(true), 150);
  setTimeout(() => scheduleFit(true), 300);
}

function focusTerminal() {
  const active = term.textarea || container.querySelector('textarea') || container;
  active?.focus?.();
  scheduleKeyboardFit();
}

container.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 1) {
    touchGesture = null;
    return;
  }
  const touch = event.touches[0];
  touchGesture = {
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    scrolling: false,
  };
  event.stopPropagation();
}, { passive: true, capture: true });

container.addEventListener('touchmove', (event) => {
  if (!touchGesture || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const totalDx = touch.clientX - touchGesture.startX;
  const totalDy = touch.clientY - touchGesture.startY;

  if (!touchGesture.scrolling) {
    if (Math.abs(totalDy) < 8 || Math.abs(totalDy) < Math.abs(totalDx)) return;
    touchGesture.scrolling = true;
    suppressTouchClickUntil = Date.now() + 500;
  }

  event.preventDefault();
  event.stopPropagation();
  dispatchTerminalWheel(-(touch.clientY - touchGesture.lastY), touch.clientX, touch.clientY);
  touchGesture.lastX = touch.clientX;
  touchGesture.lastY = touch.clientY;
}, { passive: false, capture: true });

container.addEventListener('touchend', (event) => {
  if (!touchGesture) return;
  const wasScrolling = touchGesture.scrolling;
  touchGesture = null;
  event.stopPropagation();
  if (!wasScrolling) {
    focusTerminal();
  } else {
    suppressTouchClickUntil = Date.now() + 500;
    event.preventDefault();
  }
}, { passive: false, capture: true });

container.addEventListener('touchcancel', (event) => {
  touchGesture = null;
  event.stopPropagation();
}, { passive: true, capture: true });

container.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (openOsc8LinkAtClientPoint(event.clientX, event.clientY)) {
    suppressTouchClickUntil = Date.now() + 500;
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

container.addEventListener('click', (event) => {
  if (Date.now() < suppressTouchClickUntil) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  if (openOsc8LinkAtClientPoint(event.clientX, event.clientY)) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

container.addEventListener('pointerup', (event) => {
  if (event.pointerType === 'touch' && Date.now() < suppressTouchClickUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

connect();
</script>
</body>
</html>`;
}
