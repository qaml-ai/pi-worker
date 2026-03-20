/**
 * Inline HTML frontend with ghostty-web terminal connected via WebSocket.
 *
 * ghostty-web is loaded from esm.sh CDN — no build step needed.
 * The terminal connects to /ws/:sessionId on the same host.
 */

export function renderFrontend(sessionId: string): string {
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Terminal Agent</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #1a1b26;
    color: #a9b1d6;
    font-family: system-ui, -apple-system, sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 12px 20px;
    background: #16161e;
    border-bottom: 1px solid #292e42;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  header h1 { font-size: 14px; font-weight: 600; color: #c0caf5; }
  header .session {
    font-size: 11px;
    color: #565f89;
    font-family: monospace;
    background: #1a1b26;
    padding: 2px 8px;
    border-radius: 4px;
  }
  header .status {
    margin-left: auto;
    font-size: 11px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  header .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: #565f89;
  }
  header .dot.connected { background: #9ece6a; }
  header .dot.thinking { background: #e0af68; animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: 0.4; } }
  #terminal-container {
    flex: 1;
    padding: 4px;
    overflow: hidden;
  }
</style>
</head>
<body>
<header>
  <h1>Terminal Agent</h1>
  <span class="session">${sessionId}</span>
  <div class="status">
    <div class="dot" id="status-dot"></div>
    <span id="status-text">connecting...</span>
  </div>
</header>
<div id="terminal-container"></div>

<script type="module">
import { init, Terminal } from 'https://esm.sh/ghostty-web@latest';

await init();

const term = new Terminal({
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  cursorBlink: true,
  cursorStyle: 'bar',
  scrollback: 50000,
  convertEol: true,
  theme: {
    background: '#1a1b26',
    foreground: '#a9b1d6',
    cursor: '#c0caf5',
    selectionBackground: '#33467c',
    black: '#15161e',
    red: '#f7768e',
    green: '#9ece6a',
    yellow: '#e0af68',
    blue: '#7aa2f7',
    magenta: '#bb9af7',
    cyan: '#7dcfff',
    white: '#a9b1d6',
    brightBlack: '#414868',
    brightRed: '#f7768e',
    brightGreen: '#9ece6a',
    brightYellow: '#e0af68',
    brightBlue: '#7aa2f7',
    brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff',
    brightWhite: '#c0caf5',
  },
});

const container = document.getElementById('terminal-container');
term.open(container);

// Fit terminal to container
function fitTerminal() {
  const dims = container.getBoundingClientRect();
  // Approximate character size for calculation
  const charWidth = 8.4;
  const charHeight = 18;
  const cols = Math.floor((dims.width - 8) / charWidth);
  const rows = Math.floor((dims.height - 8) / charHeight);
  if (cols > 0 && rows > 0) term.resize(cols, rows);
}
fitTerminal();
window.addEventListener('resize', fitTerminal);

const dot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
let inputBuffer = '';

function setStatus(state) {
  dot.className = 'dot ' + (state === 'connected' ? 'connected' : state === 'thinking' ? 'thinking' : '');
  statusText.textContent = state;
}

// WebSocket connection
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = proto + '//' + location.host + '/ws/${sessionId}';
let ws;
let reconnectDelay = 1000;

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    setStatus('connected');
    reconnectDelay = 1000;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch {
      // raw text fallback
      term.write(event.data);
    }
  };

  ws.onclose = () => {
    setStatus('disconnected');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
      connect();
    }, reconnectDelay);
  };

  ws.onerror = () => ws.close();
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'history':
      // Replay session history on connect
      term.write('\\x1b[2J\\x1b[H'); // clear screen
      term.write('\\x1b[1;34m--- Session restored ---\\x1b[0m\\r\\n\\r\\n');
      for (const entry of msg.entries) {
        renderEntry(entry);
      }
      showPrompt();
      break;
    case 'assistant_text':
      term.write(formatAssistant(msg.text));
      showPrompt();
      setStatus('connected');
      break;
    case 'tool_call':
      setStatus('thinking');
      term.write('\\x1b[33m  [tool] ' + msg.tool + '\\x1b[0m\\r\\n');
      break;
    case 'tool_result':
      const preview = (msg.result || '').slice(0, 200).replace(/\\n/g, '\\r\\n         ');
      term.write('\\x1b[90m         ' + preview + '\\x1b[0m\\r\\n');
      break;
    case 'error':
      term.write('\\x1b[31m  Error: ' + msg.message + '\\x1b[0m\\r\\n');
      showPrompt();
      setStatus('connected');
      break;
    case 'thinking':
      setStatus('thinking');
      break;
  }
}

function renderEntry(entry) {
  if (entry.role === 'user') {
    term.write('\\x1b[1;32m> \\x1b[0m' + entry.text + '\\r\\n');
  } else if (entry.role === 'assistant') {
    term.write(formatAssistant(entry.text));
  }
}

function formatAssistant(text) {
  const lines = text.split('\\n');
  return '\\r\\n' + lines.map(l => '\\x1b[37m  ' + l + '\\x1b[0m').join('\\r\\n') + '\\r\\n\\r\\n';
}

function showPrompt() {
  term.write('\\x1b[1;32m> \\x1b[0m');
}

// Handle user input
term.onData((data) => {
  if (data === '\\r') {
    // Enter pressed — send the input
    term.write('\\r\\n');
    const input = inputBuffer.trim();
    inputBuffer = '';
    if (input && ws.readyState === WebSocket.OPEN) {
      setStatus('thinking');
      ws.send(JSON.stringify({ type: 'prompt', text: input }));
    } else if (input) {
      term.write('\\x1b[31m  Not connected\\x1b[0m\\r\\n');
      showPrompt();
    } else {
      showPrompt();
    }
  } else if (data === '\\x7f') {
    // Backspace
    if (inputBuffer.length > 0) {
      inputBuffer = inputBuffer.slice(0, -1);
      term.write('\\b \\b');
    }
  } else if (data === '\\x03') {
    // Ctrl+C
    inputBuffer = '';
    term.write('^C\\r\\n');
    showPrompt();
  } else if (data >= ' ' || data === '\\t') {
    inputBuffer += data;
    term.write(data);
  }
});

// Boot
term.write('\\x1b[1;34mTerminal Agent\\x1b[0m — AI coding assistant with persistent sessions\\r\\n');
term.write('\\x1b[90mPowered by ghostty-web + Cloudflare Durable Objects\\x1b[0m\\r\\n\\r\\n');
showPrompt();

connect();
</script>
</body>
</html>`;
}
