/**
 * Frontend with ghostty-web terminal connected via WebSocket.
 *
 * Server sends raw text deltas with protocol markers.
 * Client renders markdown to ANSI using marked, incrementally on each delta.
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
  html, body {
    background: #1a1b26;
    color: #a9b1d6;
    font-family: system-ui, -apple-system, sans-serif;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  body { display: flex; flex-direction: column; }
  header {
    padding: 8px 16px;
    background: #16161e;
    border-bottom: 1px solid #292e42;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    height: 36px;
  }
  header h1 { font-size: 13px; font-weight: 600; color: #c0caf5; }
  header .session {
    font-size: 11px; color: #565f89; font-family: monospace;
    background: #1a1b26; padding: 2px 8px; border-radius: 4px;
  }
  header .status {
    margin-left: auto; font-size: 11px;
    display: flex; align-items: center; gap: 6px;
  }
  header .dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: #565f89; transition: background 0.2s;
  }
  header .dot.connected { background: #9ece6a; }
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
import { marked } from 'https://esm.sh/marked@15';
import { createEmphasize, common } from 'https://esm.sh/emphasize@7';

await init();

const emphasize = createEmphasize(common);

const term = new Terminal({
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
  cursorBlink: true, cursorStyle: 'bar', scrollback: 50000, convertEol: false,
  theme: {
    background: '#1a1b26', foreground: '#a9b1d6', cursor: '#c0caf5',
    selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a',
    brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7',
    brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
});

const container = document.getElementById('terminal-container');
term.open(container);

// ---------------------------------------------------------------------------
// Fit
// ---------------------------------------------------------------------------
let cols = 80, rows = 24, ws, charW = 0, charH = 0, streaming = false, streamBuffer = '', streamLineCount = 0;

function calibrate() {
  term.resize(80, 24);
  const canvas = container.querySelector('canvas');
  if (canvas && canvas.offsetWidth > 0) {
    charW = canvas.offsetWidth / 80;
    charH = canvas.offsetHeight / 24;
  } else { charW = 9.0; charH = 18; }
}

function fitTerminal() {
  const rect = container.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  if (!charW) calibrate();
  const nc = Math.floor(rect.width / charW);
  const nr = Math.floor(rect.height / charH);
  if (nc < 10 || nr < 5) return;
  if (nc !== cols || nr !== rows) {
    cols = nc; rows = nr;
    term.resize(cols, rows);
  }
}
fitTerminal();
window.addEventListener('resize', fitTerminal);

// ---------------------------------------------------------------------------
// Markdown to ANSI renderer
// ---------------------------------------------------------------------------
const E = '\\x1b[';
const R = E + '0m';
const ansi = {
  bold: s => E+'1m'+s+R, italic: s => E+'3m'+s+R,
  strike: s => E+'9m'+s+R, underline: s => E+'4m'+s+R,
  blue: s => E+'38;5;75m'+s+R, cyan: s => E+'38;5;117m'+s+R,
  gray: s => E+'38;5;245m'+s+R, green: s => E+'38;5;114m'+s+R,
  yellow: s => E+'38;5;179m'+s+R, red: s => E+'38;5;204m'+s+R,
  codeBg: s => E+'48;5;236m'+E+'38;5;117m '+s+' '+R,
  dim: s => E+'2m'+s+R,
};

function mdToAnsi(text) {
  const tokens = marked.lexer(text);
  return renderTokens(tokens);
}

function renderTokens(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out += '\\r\\n  ' + ansi.bold(ansi.blue(renderInline(t.tokens || []))) + '\\r\\n';
        if (t.depth === 1) out += '  ' + ansi.gray('─'.repeat(Math.min(40, cols - 4))) + '\\r\\n';
        break;
      case 'paragraph':
        out += '  ' + renderInline(t.tokens || []) + '\\r\\n';
        break;
      case 'code':
        out += '  ' + ansi.gray('┌─' + (t.lang ? ' ' + t.lang + ' ' : '') + '─'.repeat(Math.max(0, 30 - (t.lang?.length || 0)))) + '\\r\\n';
        // Syntax highlight with emphasize
        let highlighted;
        try {
          highlighted = (t.lang && emphasize.registered(t.lang))
            ? emphasize.highlight(t.lang, t.text || '').value
            : emphasize.highlightAuto(t.text || '').value;
        } catch { highlighted = t.text || ''; }
        for (const line of highlighted.split('\\n')) {
          out += '  ' + ansi.gray('│') + ' ' + line + R + '\\r\\n';
        }
        out += '  ' + ansi.gray('└' + '─'.repeat(33)) + '\\r\\n';
        break;
      case 'list':
        for (const item of t.items || []) {
          const bullet = t.ordered ? (item.index || '1') + '.' : '•';
          const content = renderInline(item.tokens?.[0]?.tokens || item.tokens || []);
          out += '  ' + ansi.gray(bullet) + ' ' + content + '\\r\\n';
        }
        break;
      case 'blockquote':
        const qText = renderTokens(t.tokens || []).trim();
        for (const line of qText.split('\\r\\n')) {
          out += '  ' + ansi.gray('│ ') + line.replace(/^ {2}/, '') + '\\r\\n';
        }
        break;
      case 'hr':
        out += '  ' + ansi.gray('─'.repeat(Math.min(40, cols - 4))) + '\\r\\n';
        break;
      case 'space':
        out += '\\r\\n';
        break;
      default:
        if (t.tokens) out += '  ' + renderInline(t.tokens) + '\\r\\n';
        else if (t.raw) out += '  ' + t.raw.replace(/\\n/g, '\\r\\n  ') + '\\r\\n';
        break;
    }
  }
  return out;
}

function renderInline(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text': out += t.text; break;
      case 'strong': out += ansi.bold(renderInline(t.tokens || [t.text || ''])); break;
      case 'em': out += ansi.italic(renderInline(t.tokens || [t.text || ''])); break;
      case 'del': out += ansi.strike(renderInline(t.tokens || [t.text || ''])); break;
      case 'codespan': out += ansi.codeBg(t.text); break;
      case 'link': out += ansi.underline(ansi.blue(t.text)); break;
      case 'br': out += '\\r\\n  '; break;
      default: out += t.raw || t.text || ''; break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Streaming state
// ---------------------------------------------------------------------------
let renderRaf = null;

function startStream() {
  streaming = true;
  streamBuffer = '';
  stopSpinner();
  // Save cursor position, then start writing raw text
  term.write('\\r\\n\\x1b7  ');
}

function appendStream(delta) {
  streamBuffer += delta;
  // Show raw text immediately
  term.write(delta.replace(/\\n/g, '\\r\\n  '));
}

function endStream() {
  if (!streaming) return;
  // Restore cursor to saved position, clear everything below
  term.write('\\x1b8\\x1b[J');
  // Write markdown-rendered version
  const rendered = mdToAnsi(streamBuffer);
  term.write(rendered + '\\r\\n');
  streaming = false;
  streamBuffer = '';
}

// Protocol markers
const STREAM_START = '\\x01S\\x01';
const STREAM_END = '\\x01E\\x01';
const HISTORY_START = '\\x01H\\x01';
const HISTORY_END = '\\x01/H\\x01';

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
const spinnerFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
let spinnerInterval = null, spinnerFrame = 0, isThinking = false;

function startSpinner() {
  if (isThinking) return;
  isThinking = true; spinnerFrame = 0;
  term.write('\\x1b[?25l\\x1b[33m' + spinnerFrames[0] + ' thinking...\\x1b[0m');
  spinnerInterval = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % spinnerFrames.length;
    term.write('\\x1b[2K\\x1b[1G\\x1b[33m' + spinnerFrames[spinnerFrame] + ' thinking...\\x1b[0m');
  }, 80);
}

function stopSpinner() {
  if (!isThinking) return;
  isThinking = false;
  if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
  term.write('\\x1b[2K\\x1b[1G\\x1b[?25h');
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------
const dot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
function setConnected(ok) {
  dot.className = 'dot' + (ok ? ' connected' : '');
  statusText.textContent = ok ? 'connected' : 'reconnecting';
}

const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = proto + '//' + location.host + '/ws/${sessionId}';
let reconnectDelay = 1000;

function sendJSON(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// Buffer for processing protocol markers that may span multiple messages
let msgBuffer = '';

function processData(raw) {
  msgBuffer += raw;

  while (msgBuffer.length > 0) {
    // Check for history blocks
    const hStart = msgBuffer.indexOf(HISTORY_START);
    const hEnd = msgBuffer.indexOf(HISTORY_END);
    if (hStart !== -1 && hEnd !== -1 && hEnd > hStart) {
      // Write anything before the history block directly
      if (hStart > 0) term.write(msgBuffer.slice(0, hStart));
      // Render the markdown content
      const mdText = msgBuffer.slice(hStart + HISTORY_START.length, hEnd);
      term.write(mdToAnsi(mdText) + '\\r\\n');
      msgBuffer = msgBuffer.slice(hEnd + HISTORY_END.length);
      continue;
    }

    // Check for stream start
    const sStart = msgBuffer.indexOf(STREAM_START);
    if (sStart !== -1) {
      if (sStart > 0) term.write(msgBuffer.slice(0, sStart));
      startStream();
      msgBuffer = msgBuffer.slice(sStart + STREAM_START.length);
      continue;
    }

    // Check for stream end
    const sEnd = msgBuffer.indexOf(STREAM_END);
    if (sEnd !== -1) {
      if (sEnd > 0 && streaming) appendStream(msgBuffer.slice(0, sEnd));
      else if (sEnd > 0) term.write(msgBuffer.slice(0, sEnd));
      endStream();
      msgBuffer = msgBuffer.slice(sEnd + STREAM_END.length);
      continue;
    }

    // No markers found — flush buffer
    if (streaming) {
      appendStream(msgBuffer);
    } else {
      if (isThinking) stopSpinner();
      term.write(msgBuffer);
    }
    msgBuffer = '';
    break;
  }
}

function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => { setConnected(true); reconnectDelay = 1000; };
  ws.onmessage = (event) => processData(event.data);
  ws.onclose = () => {
    setConnected(false); stopSpinner();
    setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 2, 10000); connect(); }, reconnectDelay);
  };
  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
let inputBuffer = '';
term.onData((data) => {
  if (isThinking || streaming) return;
  if (data === '\\r') {
    term.write('\\r\\n');
    const input = inputBuffer.trim(); inputBuffer = '';
    if (input) { sendJSON({ type: 'prompt', text: input }); startSpinner(); }
  } else if (data === '\\x7f') {
    if (inputBuffer.length > 0) { inputBuffer = inputBuffer.slice(0, -1); term.write('\\b \\b'); }
  } else if (data === '\\x03') { inputBuffer = ''; term.write('^C\\r\\n'); }
  else if (data === '\\x15') { const l = inputBuffer.length; inputBuffer = ''; term.write('\\b \\b'.repeat(l)); }
  else if (data === '\\x17') {
    const t = inputBuffer.trimEnd(), s = t.lastIndexOf(' '), d = inputBuffer.length-(s+1);
    inputBuffer = inputBuffer.slice(0,s+1); term.write('\\b \\b'.repeat(d));
  } else if (data >= ' ' || data === '\\t') { inputBuffer += data; term.write(data); }
});

connect();
</script>
</body>
</html>`;
}
