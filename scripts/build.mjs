#!/usr/bin/env node
// Build every deck under decks/ into a static site:
//   site/index.html            a list of the decks
//   site/engine/               the engine and its two vendored libraries
//   site/<deck>/index.html     the deck page, with the deck's Markdown embedded
//   site/<deck>/...            the deck's drawings, styles and assets
// Usage: node scripts/build.mjs [--decks decks] [--out site]
//          [--repo owner/name] [--ref branch] [--sha commit] [--pr number]
// The repository fields tell the editor where to save; they default to the
// SEAL_SLIDES_* environment variables, then to the local git checkout. --pr
// builds a read-only preview of that pull request: no editing, its comments shown.

import { readFile, writeFile, mkdir, readdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadDeck, sortSlideFiles } from '../engine/loader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = p => p.split(path.sep).join('/');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
    if (v == null) throw new Error(`--${k} needs a value`);
    out[k] = v;
  }
  return out;
}

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return ''; }
}

export function repoInfo(args = {}, env = process.env) {
  let full = args.repo || env.SEAL_SLIDES_REPO || '';
  if (!full) {
    const url = git('config', '--get', 'remote.origin.url');
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    if (m) full = `${m[1]}/${m[2]}`;
  }
  if (!full) return null;
  const [owner, name] = full.split('/');
  if (!owner || !name) throw new Error(`--repo must be owner/name, not ${full}`);
  const ref = args.ref || env.SEAL_SLIDES_REF || git('rev-parse', '--abbrev-ref', 'HEAD') || null;
  const sha = args.sha || env.SEAL_SLIDES_SHA || git('rev-parse', 'HEAD') || null;
  const prRaw = args.pr || env.SEAL_SLIDES_PR || '';
  const pr = prRaw ? Number(prRaw) : null;
  if (prRaw && !Number.isInteger(pr)) throw new Error(`--pr must be a number, not ${prRaw}`);
  return { owner, name, ref: ref === 'HEAD' ? null : ref, sha, pr };
}

async function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name);
}

async function walk(dir, base = dir) {
  const out = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await walk(p, base));
    else if (d.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

// Read a deck folder into the loader's input: repository-relative paths and file contents.
export async function readDeckFolder(abs) {
  const rel = posix(path.relative(ROOT, abs));
  const slideNames = sortSlideFiles((await listFiles(path.join(abs, 'slides'))).filter(n => n.endsWith('.md')));
  const commentNames = (await listFiles(path.join(abs, 'comments'))).filter(n => n.endsWith('.md')).sort();
  return {
    deck: { slug: path.basename(abs), dir: rel, file: `${rel}/deck.md`, raw: await readFile(path.join(abs, 'deck.md'), 'utf8') },
    slides: await Promise.all(slideNames.map(async n => ({ file: `${rel}/slides/${n}`, raw: await readFile(path.join(abs, 'slides', n), 'utf8') }))),
    comments: await Promise.all(commentNames.map(async n => ({ file: `${rel}/comments/${n}`, raw: await readFile(path.join(abs, 'comments', n), 'utf8') }))),
  };
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sha256 = s => createHash('sha256').update(s).digest('base64');

function packageRoot(file) {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`no package.json above ${file}`);
}

async function vendor(outEngine) {
  const dir = path.join(outEngine, 'vendor');
  await mkdir(dir, { recursive: true });
  const libs = [['marked', 'marked'], ['js-yaml/browser', 'js-yaml']];
  for (const [spec, name] of libs) {
    const file = fileURLToPath(import.meta.resolve(spec));
    const code = (await readFile(file, 'utf8')).replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n');
    await writeFile(path.join(dir, `${name}.js`), code);
    const pkgDir = packageRoot(file);
    const lic = (await readdir(pkgDir)).find(n => /^licen[sc]e/i.test(n));
    if (lic) await copyFile(path.join(pkgDir, lic), path.join(dir, `${name}.LICENSE.txt`));
  }
}

function deckPage({ data, model, hasCss }) {
  const importmap = JSON.stringify({ imports: { marked: '../engine/vendor/marked.js', 'js-yaml': '../engine/vendor/js-yaml.js' } });
  const csp = [
    "default-src 'self'",
    `script-src 'self' blob: 'sha256-${sha256(importmap)}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.github.com",
    'frame-src https:',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const title = model.deck.title || data.deck.slug;
  const outline = model.slides.map(s => `<li>${esc(s.title)}</li>`).join('');
  return `<!doctype html>
<html lang="${esc(model.deck.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${esc(csp)}">
<title>${esc(title)}</title>
<meta name="description" content="${esc(model.deck.description)}">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="../engine/seal-slides.css">
${hasCss ? '<link rel="stylesheet" href="deck.css">\n' : ''}<script type="importmap">${importmap}</script>
<script type="application/json" id="deck-data">${json}</script>
<script type="module" src="../engine/boot.js"></script>
</head>
<body>
<noscript><h1>${esc(title)}</h1><ol>${outline}</ol><p>This deck needs JavaScript.</p></noscript>
</body>
</html>
`;
}

function indexPage(decks) {
  const items = decks.map(d => `<li><a href="${esc(d.slug)}/">${esc(d.title || d.slug)}</a>${d.description ? `<p>${esc(d.description)}</p>` : ''}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Decks</title>
<link rel="icon" href="data:,">
<link rel="stylesheet" href="engine/seal-slides.css">
<style>body{overflow:auto;padding:clamp(24px,6vw,80px)}h1{font-family:var(--f-display);font-weight:400;font-size:clamp(36px,6vw,72px);margin:0 0 .5em}ul{list-style:none;padding:0;max-width:70ch}li{margin:0 0 1.4em}a{font-family:var(--f-display);font-size:28px;color:var(--now);text-underline-offset:4px}p{margin:.3em 0 0;color:var(--ink-2);line-height:1.5}</style>
</head>
<body>
<h1>Decks</h1>
<ul>
${items}
</ul>
</body>
</html>
`;
}

export async function build({ decksDir = path.join(ROOT, 'decks'), outDir = path.join(ROOT, 'site'), repo = null } = {}) {
  const deckDirs = [];
  for (const d of await readdir(decksDir, { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(path.join(decksDir, d.name, 'deck.md'))) deckDirs.push(path.join(decksDir, d.name));
  }
  if (!deckDirs.length) throw new Error(`no decks (folders with a deck.md) under ${decksDir}`);
  const loaded = [];
  const errors = [];
  for (const abs of deckDirs.sort()) {
    const input = await readDeckFolder(abs);
    const model = loadDeck(input);
    errors.push(...model.errors);
    for (const s of model.slides) {
      if (s.draw && !existsSync(path.join(abs, s.draw))) errors.push(new Error(`${s.file}: draw "${s.draw}" does not exist in ${input.deck.dir}`));
    }
    loaded.push({ abs, input, model });
  }
  if (errors.length) {
    const e = new Error('the build found errors:\n' + errors.map(x => '  ' + x.message).join('\n'));
    e.errors = errors;
    throw e;
  }
  await rm(outDir, { recursive: true, force: true });
  const outEngine = path.join(outDir, 'engine');
  await mkdir(outEngine, { recursive: true });
  for (const f of await listFiles(path.join(ROOT, 'engine'))) {
    if (/\.(js|css)$/.test(f)) await copyFile(path.join(ROOT, 'engine', f), path.join(outEngine, f));
  }
  await vendor(outEngine);
  const summary = [];
  for (const { abs, input, model } of loaded) {
    const slug = input.deck.slug;
    const out = path.join(outDir, slug);
    await mkdir(out, { recursive: true });
    for (const rel of await walk(abs)) {
      if (rel.endsWith('.md')) continue;
      await mkdir(path.join(out, path.dirname(rel)), { recursive: true });
      await copyFile(path.join(abs, rel), path.join(out, rel));
    }
    const data = { ...input, repo, built: new Date().toISOString() };
    const hasCss = existsSync(path.join(abs, 'deck.css'));
    await writeFile(path.join(out, 'index.html'), deckPage({ data, model, hasCss }));
    summary.push({ slug, title: model.deck.title, description: model.deck.description, slides: model.slides.length });
  }
  await writeFile(path.join(outDir, 'index.html'), indexPage(summary));
  await writeFile(path.join(outDir, '.nojekyll'), '');
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const repo = repoInfo(args);
    const summary = await build({
      decksDir: path.resolve(args.decks || path.join(ROOT, 'decks')),
      outDir: path.resolve(args.out || path.join(ROOT, 'site')),
      repo,
    });
    for (const d of summary) console.log(`built ${d.slug}: ${d.slides} slides`);
    if (repo && repo.pr) console.log(`read-only preview of ${repo.owner}/${repo.name} pull request ${repo.pr}`);
    else if (repo) console.log(`editor saves to ${repo.owner}/${repo.name}${repo.ref ? ' from ' + repo.ref : ''}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
