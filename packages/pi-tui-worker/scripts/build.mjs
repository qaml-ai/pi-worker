import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
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

const upstreamPkg = require.resolve('@mariozechner/pi-tui/package.json');
const upstreamRoot = path.dirname(upstreamPkg);
const upstreamDist = path.join(upstreamRoot, 'dist');

rmrf(outDir);
fs.mkdirSync(here, { recursive: true });
fs.cpSync(upstreamDist, outDir, { recursive: true });
console.log(`copied ${upstreamDist} -> ${outDir}`);

patchFile(path.join(outDir, 'terminal.js'), [
  {
    label: 'guard createRequire',
    oldText: `const cjsRequire = createRequire(import.meta.url);`,
    newText: `const cjsRequire = (() => {\n    try {\n        return createRequire(typeof import.meta.url === "string" ? import.meta.url : "/virtual/pi-tui/terminal.js");\n    }\n    catch {\n        return undefined;\n    }\n})();`,
  },
]);

console.log('pi-tui-worker build complete');
