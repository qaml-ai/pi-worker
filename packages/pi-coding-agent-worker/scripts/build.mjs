import fs from 'node:fs';
import path from 'node:path';
const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = path.join(here, 'dist');

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function replaceOrThrow(text, oldText, newText, label) {
  if (text.includes(newText)) return text;
  if (!text.includes(oldText)) throw new Error(`Patch failed for ${label}: old text not found`);
  return text.replace(oldText, newText);
}

function patchFile(file, patches) {
  let text = fs.readFileSync(file, 'utf8');
  for (const patch of patches) {
    text = replaceOrThrow(text, patch.oldText, patch.newText, `${path.basename(file)} :: ${patch.label}`);
  }
  fs.writeFileSync(file, text, 'utf8');
  console.log(`patched ${path.relative(here, file)}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function replaceInTree(root, exts, from, to) {
  for (const file of walk(root)) {
    if (!exts.some((ext) => file.endsWith(ext))) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(from)) continue;
    fs.writeFileSync(file, text.split(from).join(to), 'utf8');
    console.log(`rewrote imports in ${path.relative(here, file)}`);
  }
}

function findFirstExisting(candidates) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`None of the candidate paths exist:\n${candidates.join('\n')}`);
}

const upstreamDist = findFirstExisting([
  path.resolve(here, '../../node_modules/@mariozechner/pi-coding-agent/dist'),
  path.resolve(here, '../../node_modules/.bun/@mariozechner+pi-coding-agent@0.61.1+830a9963c55343ec/node_modules/@mariozechner/pi-coding-agent/dist'),
]);

rmrf(outDir);
fs.cpSync(upstreamDist, outDir, { recursive: true });
console.log(`copied ${upstreamDist} -> ${outDir}`);

replaceInTree(outDir, ['.js', '.d.ts'], '@mariozechner/pi-tui', 'pi-tui-worker');

patchFile(path.join(outDir, 'modes/interactive/interactive-mode.js'), [
  {
    label: 'inject terminal',
    oldText: `        this.version = VERSION;\n        this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());\n        this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());`,
    newText: `        this.version = VERSION;\n        this.ui = new TUI(options.terminal ?? new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());\n        this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());`,
  },
  {
    label: 'skip fd rg bootstrap',
    oldText: `        // Load changelog (only show new entries, skip for resumed sessions)\n        this.changelogMarkdown = this.getChangelogForDisplay();\n        // Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)\n        // Both are needed: fd for autocomplete, rg for grep tool and bash commands\n        const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);\n        this.fdPath = fdPath;`,
    newText: `        // Load changelog (only show new entries, skip for resumed sessions)\n        this.changelogMarkdown = this.getChangelogForDisplay();\n        // Worker fork: skip fd/rg bootstrap and autocomplete tool discovery.\n        this.fdPath = "fd";`,
  },
  {
    label: 'worker slash autocomplete only',
    oldText: `        this.autocompleteProvider = new CombinedAutocompleteProvider([...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList], process.cwd(), fdPath);`,
    newText: `        // Worker fork: keep slash command autocomplete, but don't enable file scanning.\n        this.autocompleteProvider = new CombinedAutocompleteProvider([...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList], "/", fdPath ?? null);`,
  },
]);

patchFile(path.join(outDir, 'config.js'), [
  {
    label: 'guard fileURLToPath',
    oldText: `import { fileURLToPath } from "url";\n// =============================================================================\n// Package Detection\n// =============================================================================\nconst __filename = fileURLToPath(import.meta.url);\nconst __dirname = dirname(__filename);`,
    newText: `import { fileURLToPath } from "url";\n// =============================================================================\n// Package Detection\n// =============================================================================\nconst __filename = (() => {\n    try {\n        if (typeof import.meta.url === "string") {\n            return fileURLToPath(import.meta.url);\n        }\n    }\n    catch {\n        // Workers/bundlers may not provide a file: URL here.\n    }\n    return "/virtual/pi-coding-agent/config.js";\n})();\nconst __dirname = dirname(__filename);`,
  },
  {
    label: 'guard isBunBinary',
    oldText: `export const isBunBinary = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");`,
    newText: `const __importMetaUrl = typeof import.meta.url === "string" ? import.meta.url : "";\nexport const isBunBinary = __importMetaUrl.includes("$bunfs") || __importMetaUrl.includes("~BUN") || __importMetaUrl.includes("%7EBUN");`,
  },
  {
    label: 'fallback package metadata',
    oldText: `const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));\nexport const APP_NAME = pkg.piConfig?.name || "pi";\nexport const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";\nexport const VERSION = pkg.version;`,
    newText: `const pkg = (() => {\n    try {\n        return JSON.parse(readFileSync(getPackageJsonPath(), "utf-8"));\n    }\n    catch {\n        return { piConfig: { name: "pi", configDir: ".pi" }, version: "0.61.1" };\n    }\n})();\nexport const APP_NAME = pkg.piConfig?.name || "pi";\nexport const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";\nexport const VERSION = pkg.version;`,
  },
]);

patchFile(path.join(outDir, 'core/extensions/loader.js'), [
  {
    label: 'guard createRequire',
    oldText: `const require = createRequire(import.meta.url);`,
    newText: `const require = (() => {\n    try {\n        return createRequire(typeof import.meta.url === "string" ? import.meta.url : "/virtual/pi-coding-agent/extensions-loader.js");\n    }\n    catch {\n        return { resolve: (s) => s };\n    }\n})();`,
  },
]);

patchFile(path.join(outDir, 'utils/clipboard-native.js'), [
  {
    label: 'guard createRequire',
    oldText: `const require = createRequire(import.meta.url);`,
    newText: `const require = (() => {\n    try {\n        return createRequire(typeof import.meta.url === "string" ? import.meta.url : "/virtual/pi-coding-agent/clipboard-native.js");\n    }\n    catch {\n        return () => null;\n    }\n})();`,
  },
]);

fs.writeFileSync(path.join(outDir, 'utils/photon.js'), `/** Worker stub for photon image support. */\nexport async function loadPhoton() {\n    return null;\n}\n`);
console.log('patched dist/utils/photon.js');

patchFile(path.join(outDir, 'modes/interactive/theme/theme.js'), [
  {
    label: 'force truecolor in worker',
    oldText: `function detectColorMode() {\n    const colorterm = process.env.COLORTERM;\n    if (colorterm === "truecolor" || colorterm === "24bit") {\n        return "truecolor";\n    }\n    // Windows Terminal supports truecolor\n    if (process.env.WT_SESSION) {\n        return "truecolor";\n    }\n    const term = process.env.TERM || "";\n    // Fall back to 256color for truly limited terminals\n    if (term === "dumb" || term === "" || term === "linux") {\n        return "256color";\n    }\n    // Terminal.app also doesn't support truecolor\n    if (process.env.TERM_PROGRAM === "Apple_Terminal") {\n        return "256color";\n    }\n    // GNU screen doesn't support truecolor unless explicitly opted in via COLORTERM=truecolor.\n    // TERM under screen is typically "screen", "screen-256color", or "screen.xterm-256color".\n    if (term === "screen" || term.startsWith("screen-") || term.startsWith("screen.")) {\n        return "256color";\n    }\n    // Assume truecolor for everything else - virtually all modern terminals support it\n    return "truecolor";\n}`,
    newText: `function detectColorMode() {\n    // Worker/browser transport always targets ghostty-web, which supports truecolor.\n    return "truecolor";\n}`,
  },
  {
    label: 'inline builtin themes',
    oldText: `let BUILTIN_THEMES;\nfunction getBuiltinThemes() {\n    if (!BUILTIN_THEMES) {\n        const themesDir = getThemesDir();\n        const darkPath = path.join(themesDir, "dark.json");\n        const lightPath = path.join(themesDir, "light.json");\n        BUILTIN_THEMES = {\n            dark: JSON.parse(fs.readFileSync(darkPath, "utf-8")),\n            light: JSON.parse(fs.readFileSync(lightPath, "utf-8")),\n        };\n    }\n    return BUILTIN_THEMES;\n}`,
    newText: `let BUILTIN_THEMES;\nfunction getBuiltinThemes() {\n    if (!BUILTIN_THEMES) {\n        BUILTIN_THEMES = {\n            dark: {"$schema":"https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json","name":"dark","vars":{"cyan":"#00d7ff","blue":"#5f87ff","green":"#b5bd68","red":"#cc6666","yellow":"#ffff00","gray":"#808080","dimGray":"#666666","darkGray":"#505050","accent":"#8abeb7","selectedBg":"#3a3a4a","userMsgBg":"#343541","toolPendingBg":"#282832","toolSuccessBg":"#283228","toolErrorBg":"#3c2828","customMsgBg":"#2d2838"},"colors":{"accent":"accent","border":"blue","borderAccent":"cyan","borderMuted":"darkGray","success":"green","error":"red","warning":"yellow","muted":"gray","dim":"dimGray","text":"","thinkingText":"gray","selectedBg":"selectedBg","userMessageBg":"userMsgBg","userMessageText":"","customMessageBg":"customMsgBg","customMessageText":"","customMessageLabel":"#9575cd","toolPendingBg":"toolPendingBg","toolSuccessBg":"toolSuccessBg","toolErrorBg":"toolErrorBg","toolTitle":"","toolOutput":"gray","mdHeading":"#f0c674","mdLink":"#81a2be","mdLinkUrl":"dimGray","mdCode":"accent","mdCodeBlock":"green","mdCodeBlockBorder":"gray","mdQuote":"gray","mdQuoteBorder":"gray","mdHr":"gray","mdListBullet":"accent","toolDiffAdded":"green","toolDiffRemoved":"red","toolDiffContext":"gray","syntaxComment":"#6A9955","syntaxKeyword":"#569CD6","syntaxFunction":"#DCDCAA","syntaxVariable":"#9CDCFE","syntaxString":"#CE9178","syntaxNumber":"#B5CEA8","syntaxType":"#4EC9B0","syntaxOperator":"#D4D4D4","syntaxPunctuation":"#D4D4D4","thinkingOff":"darkGray","thinkingMinimal":"#6e6e6e","thinkingLow":"#5f87af","thinkingMedium":"#81a2be","thinkingHigh":"#b294bb","thinkingXhigh":"#d183e8","bashMode":"green"},"export":{"pageBg":"#18181e","cardBg":"#1e1e24","infoBg":"#3c3728"}},\n            light: {"$schema":"https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json","name":"light","vars":{"teal":"#5a8080","blue":"#547da7","green":"#588458","red":"#aa5555","yellow":"#9a7326","mediumGray":"#6c6c6c","dimGray":"#767676","lightGray":"#b0b0b0","selectedBg":"#d0d0e0","userMsgBg":"#e8e8e8","toolPendingBg":"#e8e8f0","toolSuccessBg":"#e8f0e8","toolErrorBg":"#f0e8e8","customMsgBg":"#ede7f6"},"colors":{"accent":"teal","border":"blue","borderAccent":"teal","borderMuted":"lightGray","success":"green","error":"red","warning":"yellow","muted":"mediumGray","dim":"dimGray","text":"","thinkingText":"mediumGray","selectedBg":"selectedBg","userMessageBg":"userMsgBg","userMessageText":"","customMessageBg":"customMsgBg","customMessageText":"","customMessageLabel":"#7e57c2","toolPendingBg":"toolPendingBg","toolSuccessBg":"toolSuccessBg","toolErrorBg":"toolErrorBg","toolTitle":"","toolOutput":"mediumGray","mdHeading":"yellow","mdLink":"blue","mdLinkUrl":"dimGray","mdCode":"teal","mdCodeBlock":"green","mdCodeBlockBorder":"mediumGray","mdQuote":"mediumGray","mdQuoteBorder":"mediumGray","mdHr":"mediumGray","mdListBullet":"green","toolDiffAdded":"green","toolDiffRemoved":"red","toolDiffContext":"mediumGray","syntaxComment":"#008000","syntaxKeyword":"#0000FF","syntaxFunction":"#795E26","syntaxVariable":"#001080","syntaxString":"#A31515","syntaxNumber":"#098658","syntaxType":"#267F99","syntaxOperator":"#000000","syntaxPunctuation":"#000000","thinkingOff":"lightGray","thinkingMinimal":"#767676","thinkingLow":"blue","thinkingMedium":"teal","thinkingHigh":"#875f87","thinkingXhigh":"#8b008b","bashMode":"green"},"export":{"pageBg":"#f8f8f8","cardBg":"#ffffff","infoBg":"#fffae6"}},\n        };\n    }\n    return BUILTIN_THEMES;\n}`,
  },
]);

console.log('pi-coding-agent-worker build complete');
