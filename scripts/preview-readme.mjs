import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(root, 'README.md');
const previewDir = resolve(root, 'preview');
const outPath = resolve(previewDir, 'index.html');
const serve = process.argv.includes('--serve');
const portFlag = process.argv.find((arg) => arg.startsWith('--port='));
const port = portFlag ? Number(portFlag.split('=')[1]) : 4173;

function esc(s) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    if (line.startsWith('<p ') || line.startsWith('<img') || line.startsWith('</p>')) {
      const block = [];
      while (i < lines.length && lines[i].trim()) {
        block.push(lines[i]);
        i++;
      }
      out.push(block.join('\n'));
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const block = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        block.push(lines[i]);
        i++;
      }
      i++;
      out.push(`<pre><code class="language-${lang}">${esc(block.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(`<li>${inline(lines[i].slice(2))}</li>`);
        i++;
      }
      out.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith('#') && !lines[i].startsWith('- ') && !lines[i].startsWith('```') && !lines[i].startsWith('<p ') && !lines[i].startsWith('<img') && !lines[i].startsWith('</p>')) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n\n');
}

const mirroredAssetDir = resolve(previewDir, 'assets');
mkdirSync(mirroredAssetDir, { recursive: true });
try {
  const assetSource = resolve(root, 'assets', 'sigil-logo.png');
  const assetTarget = resolve(mirroredAssetDir, 'sigil-logo.png');
  writeFileSync(assetTarget, readFileSync(assetSource));
} catch {}

const readme = readFileSync(readmePath, 'utf8');
const body = render(readme);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sigil README Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: #0d1117;
      --text: #e6edf3;
      --muted: #8b949e;
      --border: #30363d;
      --accent: #f78166;
      --code: #161b22;
      --link: #58a6ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
    }
    .frame {
      max-width: 1240px;
      margin: 0 auto;
      padding: 32px 40px 80px;
    }
    .page {
      border-top: 1px solid var(--border);
      margin-top: 24px;
      padding-top: 40px;
    }
    h1,h2,h3,h4,h5,h6 {
      font-weight: 700;
      line-height: 1.25;
      margin: 24px 0 16px;
      padding-bottom: .3em;
      border-bottom: 1px solid var(--border);
    }
    h1 { font-size: 3rem; margin-top: 0; }
    h2 { font-size: 2.3rem; }
    p, ul, pre { margin: 0 0 16px; }
    ul { padding-left: 2em; }
    code {
      background: rgba(110,118,129,.16);
      border-radius: 6px;
      padding: .2em .4em;
      font: 85% ui-monospace,SFMono-Regular,SF Mono,Menlo,Consolas,monospace;
    }
    pre {
      background: var(--code);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: auto;
      padding: 16px;
    }
    pre code { background: transparent; padding: 0; }
    a { color: var(--link); }
    img { max-width: 100%; height: auto; }
    .toolbar {
      display:flex; align-items:center; gap:16px; color:var(--muted); font-weight:600;
      border-bottom:1px solid var(--border); padding:16px 0;
    }
    .toolbar .active { color: var(--text); border-bottom: 3px solid var(--accent); padding-bottom: 13px; }
  </style>
</head>
<body>
  <div class="frame">
    <div class="toolbar"><span class="active">README</span></div>
    <div class="page markdown-body">${body}</div>
  </div>
</body>
</html>`;

mkdirSync(previewDir, { recursive: true });
writeFileSync(outPath, html, 'utf8');
console.log(`Wrote ${outPath}`);

if (serve) {
  const child = spawn('python3', ['-m', 'http.server', String(port), '--directory', previewDir], {
    cwd: root,
    stdio: 'inherit',
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}
