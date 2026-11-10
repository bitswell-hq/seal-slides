// The Markdown loader. Turns the raw text of a deck folder (deck.md, one
// Markdown file per slide, comment files) into the model the runtime draws,
// and renders slide bodies to HTML. It runs unchanged in Node (the build and
// the tests) and in the browser (the editor's live preview), so it touches no
// DOM and no file system: callers hand it file paths and file contents.

import { load as loadYaml } from 'js-yaml';
import { Marked } from 'marked';

export class LoaderError extends Error {
  constructor(message, file, line) {
    super(file ? `${file}${line ? ':' + line : ''}: ${message}` : message);
    this.name = 'LoaderError';
    this.file = file;
    this.line = line;
  }
}

export const STATUSES = ['plain', 'now', 'next', 'cited', 'title'];
export const LAYOUTS = ['default', 'title', 'center'];
const SLIDE_KEYS = new Set(['title', 'status', 'layout', 'draw', 'alt', 'duration', 'notes', 'sources', 'kicker', 'legend']);
const DECK_KEYS = new Set(['title', 'description', 'duration', 'statuses', 'seals', 'theme', 'lang']);
const COMMENT_KEYS = new Set(['author', 'created', 'file', 'line', 'end_line', 'quote']);
const DEFAULT_SEAL = 'b82ad3de131c7be6ada4e5a622a4e77e1d2d1dbe43b0fcc26f85d11006fa6544';

const lineCount = s => (s.match(/\n/g) || []).length;

/* ---------- front matter ---------- */

// Split `---` front matter from the body. Line numbers are 1-based file lines.
export function splitFrontMatter(raw, file) {
  const text = raw.replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/.exec(text);
  if (!m) {
    if (/^---[ \t]*\n/.test(text)) throw new LoaderError('front matter opened with --- is never closed', file, 1);
    return { text, data: {}, fmText: null, fmStartLine: 0, fmEndLine: 0, body: text, bodyStartLine: 1 };
  }
  const fmText = m[1] || '';
  let data;
  try {
    data = loadYaml(fmText);
  } catch (e) {
    const line = e.mark && e.mark.line != null ? e.mark.line + 2 : 1;
    throw new LoaderError(`front matter is not valid YAML: ${e.reason || e.message}`, file, line);
  }
  if (data == null) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new LoaderError('front matter must be a mapping of keys to values', file, 2);
  const fmEndLine = 2 + lineCount(fmText);
  return { text, data, fmText, fmStartLine: 2, fmEndLine, body: text.slice(m[0].length), bodyStartLine: fmEndLine + 1 };
}

// Where each top-level key sits in the front matter, and where the items of a
// list or the lines of a block scalar sit. All line numbers are file lines.
export function fieldLines(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = {};
  if (!/^---[ \t]*$/.test(lines[0] || '')) return out;
  let end = lines.length;
  for (let i = 1; i < lines.length; i++) if (/^---[ \t]*$/.test(lines[i])) { end = i; break; }
  let cur = null;
  for (let i = 1; i < end; i++) {
    const ln = lines[i];
    const key = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/.exec(ln);
    if (key) {
      cur = { line: i + 1, end: i + 1, value: key[2].trim(), items: [], content: [] };
      out[key[1]] = cur;
      continue;
    }
    if (!cur) continue;
    const block = /^[|>]/.test(cur.value);
    if (ln.trim() === '') {
      if (block) cur.content.push(i + 1);
      continue;
    }
    if (/^[ \t]*#/.test(ln) && !(block && /^[ \t]/.test(ln))) continue;
    cur.end = i + 1;
    if (/^[ \t]*- /.test(ln) || /^[ \t]*-$/.test(ln)) cur.items.push(i + 1);
    cur.content.push(i + 1);
  }
  // Block scalars keep their trailing blank lines only up to the last text line.
  for (const k in out) {
    const f = out[k];
    const lastText = f.content.filter(n => lines[n - 1].trim() !== '').pop();
    f.content = f.content.filter(n => n <= (lastText || 0));
  }
  return out;
}

export function parseDuration(v, file, line) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && isFinite(v) && v >= 0) return v;
  const s = String(v).trim();
  let m = /^(\d+):([0-5]\d)$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)\s*s?$/.exec(s);
  if (m) return Number(m[1]);
  throw new LoaderError(`duration "${s}" is not seconds or m:ss`, file, line);
}

export function formatDuration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- slides ---------- */

function stringList(v, key, file, line) {
  if (v == null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every(x => typeof x === 'string' || typeof x === 'number')) return v.map(String);
  throw new LoaderError(`${key} must be a string or a list of strings`, file, line);
}

// The spoken script: one non-empty line per line read aloud.
function scriptLines(v, file, line) {
  if (v == null) return [];
  const parts = Array.isArray(v) ? stringList(v, 'notes', file, line) : [String(v)];
  return parts.flatMap(p => p.split('\n')).map(s => s.trim()).filter(Boolean);
}

export function parseSlide(raw, file = '') {
  const fm = splitFrontMatter(raw, file);
  const lines = fieldLines(fm.text);
  const d = fm.data;
  const at = k => (lines[k] ? lines[k].line : 1);
  for (const k of Object.keys(d)) {
    if (!SLIDE_KEYS.has(k)) throw new LoaderError(`unknown slide key "${k}" (known: ${[...SLIDE_KEYS].join(', ')})`, file, at(k));
  }
  const title = d.title == null ? '' : String(d.title);
  if (!title.trim()) throw new LoaderError('a slide needs a title in its front matter', file, at('title'));
  const status = d.status == null ? 'plain' : String(d.status);
  if (!STATUSES.includes(status)) throw new LoaderError(`status "${status}" is not one of ${STATUSES.join(', ')}`, file, at('status'));
  const layout = d.layout == null ? 'default' : String(d.layout);
  if (!LAYOUTS.includes(layout)) throw new LoaderError(`layout "${layout}" is not one of ${LAYOUTS.join(', ')}`, file, at('layout'));
  let draw = null;
  if (d.draw != null) {
    draw = String(d.draw);
    if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.m?js$/.test(draw) || draw.split('/').some(p => p === '.' || p === '..')) {
      throw new LoaderError(`draw "${draw}" must be a .js path inside the deck folder`, file, at('draw'));
    }
    if (d.alt == null || !String(d.alt).trim()) throw new LoaderError('a slide with draw needs alt text describing the drawing', file, at('draw'));
  }
  const notes = scriptLines(d.notes, file, at('notes'));
  const nf = lines.notes;
  const noteLines = nf ? (nf.items.length ? nf.items : nf.content.filter(n => fm.text.split('\n')[n - 1].trim() !== '')) : [];
  const sources = stringList(d.sources, 'sources', file, at('sources'));
  const sf = lines.sources;
  return {
    file,
    raw: fm.text,
    title,
    status,
    layout,
    draw,
    alt: d.alt == null ? '' : String(d.alt),
    kicker: d.kicker == null ? '' : String(d.kicker),
    legend: d.legend === true,
    duration: parseDuration(d.duration, file, at('duration')),
    notes,
    sources,
    body: fm.body,
    bodyStartLine: fm.bodyStartLine,
    lines: {
      title: at('title'),
      kicker: at('kicker'),
      notes: notes.map((_, i) => noteLines[i] || (nf ? nf.line : 1)),
      sources: sources.map((_, i) => (sf && sf.items[i]) || (sf ? sf.line : 1)),
      body: fm.bodyStartLine,
    },
  };
}

export function parseDeck(raw, file = '') {
  const fm = splitFrontMatter(raw, file);
  const lines = fieldLines(fm.text);
  const d = fm.data;
  const at = k => (lines[k] ? lines[k].line : 1);
  for (const k of Object.keys(d)) {
    if (!DECK_KEYS.has(k)) throw new LoaderError(`unknown deck key "${k}" (known: ${[...DECK_KEYS].join(', ')})`, file, at(k));
  }
  const statuses = {};
  if (d.statuses != null) {
    if (typeof d.statuses !== 'object' || Array.isArray(d.statuses)) throw new LoaderError('statuses must map a status to its label', file, at('statuses'));
    for (const [k, v] of Object.entries(d.statuses)) {
      if (!STATUSES.includes(k)) throw new LoaderError(`statuses: "${k}" is not one of ${STATUSES.join(', ')}`, file, at('statuses'));
      statuses[k] = String(v);
    }
  }
  const seals = { A: DEFAULT_SEAL };
  if (d.seals != null) {
    if (typeof d.seals !== 'object' || Array.isArray(d.seals)) throw new LoaderError('seals must map a name to 64 hex digits', file, at('seals'));
    for (const [k, v] of Object.entries(d.seals)) {
      if (!/^[A-Za-z][\w-]*$/.test(k)) throw new LoaderError(`seal name "${k}" must be a letter followed by letters, digits, - or _`, file, at('seals'));
      if (!/^[0-9a-f]{64}$/i.test(String(v))) throw new LoaderError(`seal "${k}" must be 64 hex digits (32 bytes)`, file, at('seals'));
      seals[k] = String(v).toLowerCase();
    }
  }
  const theme = d.theme == null ? 'auto' : String(d.theme);
  if (!['auto', 'light', 'dark'].includes(theme)) throw new LoaderError('theme must be auto, light or dark', file, at('theme'));
  return {
    file,
    raw: fm.text,
    title: d.title == null ? '' : String(d.title),
    description: d.description == null ? '' : String(d.description),
    lang: d.lang == null ? 'en' : String(d.lang),
    duration: parseDuration(d.duration, file, at('duration')),
    statuses,
    seals,
    theme,
    body: fm.body,
  };
}

// A comment kept as a file in the repository, under <deck>/comments/.
export function parseCommentFile(raw, file = '') {
  const fm = splitFrontMatter(raw, file);
  const d = fm.data;
  for (const k of Object.keys(d)) {
    if (!COMMENT_KEYS.has(k)) throw new LoaderError(`unknown comment key "${k}" (known: ${[...COMMENT_KEYS].join(', ')})`, file, 1);
  }
  if (!d.file) throw new LoaderError('a comment needs the file it is about', file, 1);
  const line = d.line == null ? null : Number(d.line);
  return {
    id: 'file:' + file,
    kind: 'file',
    source: file,
    author: d.author == null ? '' : String(d.author),
    created: d.created == null ? '' : String(d.created),
    file: String(d.file),
    line,
    endLine: d.end_line == null ? line : Number(d.end_line),
    quote: d.quote == null ? '' : String(d.quote),
    body: fm.body.trim(),
    url: null,
    pr: null,
  };
}

// The text of a comment file, the inverse of parseCommentFile.
export function formatCommentFile({ author, created, file, line, endLine, quote, body }) {
  let fm = `author: ${yamlScalar(author)}\ncreated: ${yamlScalar(created)}\nfile: ${yamlScalar(file)}\n`;
  if (line != null) fm += `line: ${line}\n`;
  if (endLine != null && endLine !== line) fm += `end_line: ${endLine}\n`;
  if (quote) fm += `quote: ${JSON.stringify(quote)}\n`;
  return `---\n${fm}---\n${body.trim()}\n`;
}

// Parse a whole deck: { deck: {file, raw}, slides: [{file, raw}], comments }.
// Errors are collected rather than thrown so the build can report all of them.
export function loadDeck(input) {
  const errors = [];
  let deck = null;
  try { deck = parseDeck(input.deck.raw, input.deck.file); } catch (e) { errors.push(e); }
  const slides = [];
  for (const s of input.slides) {
    try { slides.push(parseSlide(s.raw, s.file)); } catch (e) { errors.push(e); }
  }
  const comments = [];
  for (const c of input.comments || []) {
    if (c.kind) { comments.push(c); continue; }
    try { comments.push(parseCommentFile(c.raw, c.file)); } catch (e) { errors.push(e); }
  }
  if (deck && !slides.length && !errors.length) errors.push(new LoaderError('the deck has no slides (add Markdown files under slides/)', input.deck.file));
  const total = deck && deck.duration != null ? deck.duration : slides.reduce((a, s) => a + (s.duration || 0), 0) || null;
  return { deck, slides, comments, total, errors };
}

// Slide files are ordered by file name, with numbers compared as numbers.
export function sortSlideFiles(names) {
  return [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/* ---------- Markdown ---------- */

const md = new Marked({ gfm: true });

// Render a slide body. Each top-level block carries data-line and
// data-line-end, its first and last file lines, so a selection in the
// rendered slide maps back to lines of the Markdown file.
export function renderMarkdown(body, startLine = 1) {
  const tokens = md.lexer(body);
  let line = startLine;
  let html = '';
  for (const t of tokens) {
    const first = line;
    const n = lineCount(t.raw);
    line += n;
    if (t.type === 'space') continue;
    const single = [t];
    single.links = tokens.links;
    let h = md.parser(single);
    if (t.type !== 'html') {
      const last = first + Math.max(0, n - (t.raw.endsWith('\n') ? 1 : 0));
      h = h.replace(/^<([a-z][a-z0-9]*)/i, `<$1 data-line="${first}" data-line-end="${last}"`);
    }
    html += h;
  }
  return html;
}

export function renderInline(s) {
  return md.parseInline(s);
}

/* ---------- editing the front matter ---------- */

const PLAIN_BAD = /^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d|\.\d).*)$/i;
export function yamlScalar(s) {
  s = String(s);
  if (s && s === s.trim() && !PLAIN_BAD.test(s) && /^[\p{L}\p{N}(][^\n#:'"{}[\],&*!|>%@`]*$/u.test(s)) return s;
  return JSON.stringify(s);
}

function emitField(key, value) {
  if (value == null) return null;
  if (key === 'notes') {
    const lines = (Array.isArray(value) ? value : String(value).split('\n')).map(l => l.trim());
    while (lines.length && !lines[lines.length - 1]) lines.pop();
    while (lines.length && !lines[0]) lines.shift();
    if (!lines.length) return null;
    return `notes: |\n${lines.map(l => (l ? '  ' + l : '')).join('\n')}`;
  }
  if (Array.isArray(value)) {
    const items = value.map(v => String(v).trim()).filter(Boolean);
    if (!items.length) return null;
    return `${key}:\n${items.map(v => '  - ' + JSON.stringify(v)).join('\n')}`;
  }
  if (typeof value === 'number') return `${key}: ${value}`;
  if (typeof value === 'boolean') return `${key}: ${value}`;
  return `${key}: ${yamlScalar(value)}`;
}

// Replace one top-level front-matter key, leaving every other line as it was.
// A null value, an empty list or empty notes removes the key.
export function setField(raw, key, value) {
  const text = raw.replace(/\r\n?/g, '\n');
  const emitted = emitField(key, value);
  const lines = text.split('\n');
  if (!/^---[ \t]*$/.test(lines[0] || '')) {
    if (emitted == null) return text;
    return `---\n${emitted}\n---\n${text}`;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (/^---[ \t]*$/.test(lines[i])) { end = i; break; }
  if (end < 0) throw new LoaderError('front matter opened with --- is never closed', '', 1);
  const f = fieldLines(text)[key];
  const repl = emitted == null ? [] : emitted.split('\n');
  if (f) {
    lines.splice(f.line - 1, f.end - f.line + 1, ...repl);
  } else {
    lines.splice(end, 0, ...repl);
  }
  return lines.join('\n');
}

/* ---------- finding a quote in a file ---------- */

// A projection of Markdown source without markup characters and with runs of
// white space folded to one space, keeping the source offset of every char.
function project(text) {
  let out = '';
  const map = [];
  let prevSpace = true;
  let atLineStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (atLineStart) {
      const m = /^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)?/.exec(text.slice(i, i + 12));
      if (m && m[0].length) { i += m[0].length - 1; atLineStart = false; if (!prevSpace) { out += ' '; map.push(i); prevSpace = true; } continue; }
      atLineStart = false;
    }
    if (c === '\n') { atLineStart = true; }
    if (c === ']' && text[i + 1] === '(') {
      const close = text.indexOf(')', i + 2);
      if (close > 0) { i = close; continue; }
    }
    if ('*_`~[]'.includes(c)) continue;
    if (/\s/.test(c)) {
      if (prevSpace) continue;
      out += ' '; map.push(i); prevSpace = true; continue;
    }
    out += c.toLowerCase(); map.push(i); prevSpace = false;
  }
  return { out, map };
}

const lineAt = (text, offset) => lineCount(text.slice(0, offset)) + 1;

// Find the lines of a file that hold a quoted span of rendered text. When the
// quote appears more than once, the occurrence nearest `near` wins.
export function locate(raw, quote, near = 1) {
  const text = raw.replace(/\r\n?/g, '\n');
  const q = String(quote || '').replace(/[*_`~[\]]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!q) return null;
  const { out, map } = project(text);
  let best = null;
  for (let at = out.indexOf(q); at >= 0; at = out.indexOf(q, at + 1)) {
    const line = lineAt(text, map[at]);
    const endLine = lineAt(text, map[at + q.length - 1]);
    if (!best || Math.abs(line - near) < Math.abs(best.line - near)) best = { line, endLine };
  }
  return best;
}

// Lines a selection between two offsets of a text covers (1-based, inclusive).
export function linesOfRange(text, start, end) {
  const s = Math.min(start, end), e = Math.max(start, end);
  const line = lineAt(text, s);
  let endLine = lineAt(text, e);
  if (e > s && text[e - 1] === '\n') endLine = Math.max(line, endLine - 1);
  return { line, endLine };
}

// Estimated speaking time of a script at a given pace (words per minute).
export function speakingSeconds(lines, wpm = 150) {
  const words = lines.join(' ').split(/\s+/).filter(Boolean).length;
  return words / wpm * 60;
}
