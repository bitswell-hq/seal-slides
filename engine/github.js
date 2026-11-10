// The GitHub persistence layer. Edits become a commit on a branch plus a pull
// request; comments become pull-request review comments, or comment files
// committed the same way when no open pull request changes the file. It
// calls the REST API with the viewer's own token and runs in the browser and
// in Node (the tests pass a mocked fetch).

import { locate, formatCommentFile, parseCommentFile } from './loader.js';

export class GitHubError extends Error {
  constructor(status, message, body) {
    super(`GitHub ${status}: ${message}`);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class ConflictError extends Error {
  constructor(path, branch, pr) {
    super(`${path} changed in pull request #${pr.number} since the editor loaded it; nothing was saved. See ${pr.url}`);
    this.name = 'ConflictError';
    this.path = path;
    this.branch = branch;
    this.pr = pr;
  }
}

const seg = s => String(s).split('/').map(encodeURIComponent).join('/');

export class GitHubClient {
  constructor({ token = null, fetch: f = null, api = 'https://api.github.com' } = {}) {
    this.token = token || null;
    this.fetch = f || ((...a) => globalThis.fetch(...a));
    this.api = api;
  }
  async request(method, path, body) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await this.fetch(this.api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      let msg = (json && json.message) || res.statusText || 'request failed';
      if (json && Array.isArray(json.errors) && json.errors.length) msg += ' (' + json.errors.map(e => e.message || e.code || JSON.stringify(e)).join('; ') + ')';
      throw new GitHubError(res.status, msg, json);
    }
    return json;
  }
  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, body); }
  patch(path, body) { return this.request('PATCH', path, body); }
}

// Unicode-safe base64 decoding of the contents API.
export function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// The new-file line numbers a unified diff patch shows, grouped by hunk.
export function patchHunks(patch) {
  const hunks = [];
  if (!patch) return hunks;
  let lines = null, n = 0;
  for (const l of patch.split('\n')) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (m) { lines = new Set(); hunks.push(lines); n = Number(m[1]); continue; }
    if (!lines) continue;
    if (l.startsWith('-') || l.startsWith('\\')) continue;
    lines.add(n++);
  }
  return hunks;
}

// Whether lines line..endLine of the new file all sit in one hunk, which is
// what GitHub needs to anchor a review comment to them.
export function rangeInPatch(patch, line, endLine = line) {
  if (line == null) return false;
  return patchHunks(patch).some(set => {
    for (let i = line; i <= endLine; i++) if (!set.has(i)) return false;
    return true;
  });
}

const prNumber = c => {
  const m = /\/pulls\/(\d+)$/.exec(c.pull_request_url || '');
  return m ? Number(m[1]) : null;
};

export function normalizeReviewComment(c) {
  const end = c.line != null ? c.line : c.original_line;
  const start = c.start_line != null ? c.start_line : (c.original_start_line != null ? c.original_start_line : end);
  return {
    id: 'review:' + c.id,
    kind: 'review',
    author: c.user ? c.user.login : '',
    created: c.created_at || '',
    file: c.path,
    line: start == null ? null : start,
    endLine: end == null ? null : end,
    quote: '',
    body: c.body || '',
    url: c.html_url || null,
    pr: prNumber(c),
    outdated: c.line == null && c.subject_type !== 'file',
  };
}

function quoteBlock(q) {
  return q.split('\n').map(l => '> ' + l).join('\n');
}

export function commentBody(anchor, body, inDiff) {
  if (inDiff) return body.trim();
  const where = anchor.line != null ? `Line ${anchor.line}${anchor.endLine && anchor.endLine !== anchor.line ? '–' + anchor.endLine : ''}` : 'Whole slide';
  return (anchor.quote ? quoteBlock(anchor.quote) + '\n\n' : '') + `${where}:\n\n${body.trim()}`;
}

const stamp = d => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '').replace('T', '-');

// One deck in one repository, as the page was built: repo is
// { owner, name, ref, sha, pr } where ref is the branch the page was built
// from, sha its commit and pr the pull request a preview belongs to.
export class DeckStore {
  constructor({ client, repo, deckDir, now = () => new Date(), sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    this.client = client;
    this.repo = repo;
    this.deckDir = deckDir.replace(/\/+$/, '');
    this.slug = this.deckDir.split('/').pop();
    this.now = now;
    this.sleep = sleep;
    this._viewer = null;
  }
  get full() { return `${this.repo.owner}/${this.repo.name}`; }
  get base() { return `/repos/${seg(this.repo.owner)}/${seg(this.repo.name)}`; }

  async viewer() {
    if (!this._viewer) this._viewer = await this.client.get('/user');
    return this._viewer;
  }

  // The fork the viewer commits to when they cannot push to the repository.
  async fork(login) {
    const c = this.client;
    try {
      const r = await c.get(`/repos/${seg(login)}/${seg(this.repo.name)}`);
      if (r.fork && r.parent && r.parent.full_name === this.full) return { owner: r.owner.login, name: r.name, fresh: false };
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
    }
    const f = await c.post(`${this.base}/forks`, { default_branch_only: false });
    const fork = { owner: f.owner.login, name: f.name, fresh: true };
    // Forking is asynchronous; wait until the fork answers.
    for (let i = 0; i < 10; i++) {
      try { await c.get(`/repos/${seg(fork.owner)}/${seg(fork.name)}/commits?per_page=1`); return fork; } catch (_) { await this.sleep(1500); }
    }
    throw new Error(`the fork ${fork.owner}/${fork.name} is not ready yet; try again in a minute`);
  }

  // The open pull request the viewer's edits go to, if there is one: the
  // preview's own when they can push to it, otherwise the one this editor
  // opened for them earlier. It never forks.
  async lookup() {
    const c = this.client;
    const me = await this.viewer();
    const info = await c.get(this.base);
    const canPush = !!(info.permissions && info.permissions.push);
    const baseRef = this.repo.ref || info.default_branch;
    const here = p => p.head.repo.full_name === this.full;
    let pr = null;
    if (this.repo.pr) {
      const pull = await c.get(`${this.base}/pulls/${this.repo.pr}`);
      if (pull.state === 'open' && canPush && pull.head.repo && here(pull)) pr = pull;
    }
    if (!pr) {
      const prefix = `seal-slides/${this.slug}/`;
      const pulls = await c.get(`${this.base}/pulls?state=open&per_page=100`);
      pr = pulls.find(p => p.user && p.user.login === me.login && p.head.ref.startsWith(prefix) &&
        p.head.repo && here(p) === canPush && p.base.ref === baseRef) || null;
    }
    const home = pr && !canPush ? { owner: pr.head.repo.owner.login, name: pr.head.repo.name } : { owner: this.repo.owner, name: this.repo.name };
    return { me, info, canPush, baseRef, pr, home };
  }

  // Where an edit goes: the branch, the repository holding it and its pull request.
  async target() {
    const { me, info, canPush, baseRef, pr, home } = await this.lookup();
    const fork = !canPush;
    if (pr) return { owner: home.owner, name: home.name, branch: pr.head.ref, pr, fork, create: false, baseRef };
    const at = canPush ? home : await this.fork(me.login);
    const branch = `seal-slides/${this.slug}/${me.login}-${stamp(this.now())}`;
    return { owner: at.owner, name: at.name, branch, pr: null, fork, create: true, baseRef, from: this.repo.sha, defaultBranch: info.default_branch };
  }

  // The deck's files as the viewer's open pull request holds them, by path,
  // so that the next edit builds on the last one rather than on the page as
  // built. Null when the viewer has no open pull request.
  async pending() {
    const { pr, home } = await this.lookup();
    if (!pr) return null;
    const changed = await this.client.get(`${this.base}/pulls/${pr.number}/files?per_page=100`);
    const files = new Map();
    for (const x of changed) {
      if (x.status === 'removed' || !x.filename.startsWith(this.deckDir + '/') || x.filename.startsWith(this.deckDir + '/comments/')) continue;
      const text = await this.readFile(home.owner, home.name, x.filename, pr.head.ref);
      if (text != null) files.set(x.filename, text);
    }
    return { pr: { number: pr.number, url: pr.html_url }, branch: pr.head.ref, files };
  }

  async createBranch(t) {
    const c = this.client;
    const at = `/repos/${seg(t.owner)}/${seg(t.name)}`;
    let from = t.from;
    if (!from) from = (await c.get(`${this.base}/git/ref/heads/${seg(t.baseRef)}`)).object.sha;
    try {
      await c.post(`${at}/git/refs`, { ref: `refs/heads/${t.branch}`, sha: from });
    } catch (e) {
      // A fork can lag behind the repository; bring it up to date once and retry.
      if (!(e instanceof GitHubError) || e.status !== 422 || !t.fork) throw e;
      await c.post(`${at}/merge-upstream`, { branch: t.defaultBranch || t.baseRef });
      await c.post(`${at}/git/refs`, { ref: `refs/heads/${t.branch}`, sha: from });
    }
  }

  async readFile(owner, name, path, ref) {
    try {
      const r = await this.client.get(`/repos/${seg(owner)}/${seg(name)}/contents/${seg(path)}?ref=${encodeURIComponent(ref)}`);
      return r && r.content != null ? decodeBase64(r.content) : null;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  // One commit with every file, through the git data API.
  async commitFiles(t, files, message) {
    const c = this.client;
    const at = `/repos/${seg(t.owner)}/${seg(t.name)}`;
    const ref = await c.get(`${at}/git/ref/heads/${seg(t.branch)}`);
    const head = ref.object.sha;
    const parent = await c.get(`${at}/git/commits/${head}`);
    const tree = await c.post(`${at}/git/trees`, {
      base_tree: parent.tree.sha,
      tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    const commit = await c.post(`${at}/git/commits`, { message, tree: tree.sha, parents: [head] });
    await c.patch(`${at}/git/refs/heads/${seg(t.branch)}`, { sha: commit.sha, force: false });
    return commit;
  }

  // files: [{ path, content, base }] where base is the text the editor loaded
  // (see pending); a file that changed on the branch since then is a conflict.
  async saveEdit({ files, message, body }) {
    if (!files.length) throw new Error('nothing to save');
    const t = await this.target();
    if (t.create) {
      await this.createBranch(t);
    } else {
      for (const f of files) {
        if (f.base == null) continue;
        const now = await this.readFile(t.owner, t.name, f.path, t.branch);
        if (now != null && now !== f.base && now !== f.content) throw new ConflictError(f.path, t.branch, { number: t.pr.number, url: t.pr.html_url });
      }
    }
    const commit = await this.commitFiles(t, files, message);
    let pr = t.pr;
    if (!pr) {
      pr = await this.client.post(`${this.base}/pulls`, {
        title: message.split('\n')[0],
        head: t.fork ? `${t.owner}:${t.branch}` : t.branch,
        base: t.baseRef,
        body: body || `Opened from the seal-slides editor for \`${this.deckDir}\`.`,
        maintainer_can_modify: true,
      });
    }
    return {
      repo: `${t.owner}/${t.name}`,
      branch: t.branch,
      commit: { sha: commit.sha, url: commit.html_url || `https://github.com/${t.owner}/${t.name}/commit/${commit.sha}` },
      pr: { number: pr.number, url: pr.html_url },
      createdPr: !t.pr,
    };
  }

  // anchor: { file, line, endLine, quote } with line numbers of the file as
  // the page was built (null line: the whole file).
  async saveComment({ anchor, body }) {
    if (!body || !body.trim()) throw new Error('the comment is empty');
    const c = this.client;
    const me = await this.viewer();
    let candidates;
    if (this.repo.pr) {
      const pull = await c.get(`${this.base}/pulls/${this.repo.pr}`);
      candidates = pull.state === 'open' ? [pull] : [];
    } else {
      const pulls = await c.get(`${this.base}/pulls?state=open&per_page=30`);
      const prefix = `seal-slides/${this.slug}/`;
      const rank = p => (p.user && p.user.login === me.login ? 0 : 1) + (p.head.ref.startsWith(prefix) ? 0 : 2);
      candidates = pulls.slice(0, 10).sort((a, b) => rank(a) - rank(b));
    }
    for (const pull of candidates) {
      const files = await c.get(`${this.base}/pulls/${pull.number}/files?per_page=100`);
      const f = files.find(x => x.filename === anchor.file && x.status !== 'removed');
      if (!f) continue;
      let { line, endLine } = anchor;
      if (endLine == null) endLine = line;
      if (line != null && anchor.quote && pull.head.sha !== this.repo.sha) {
        // The pull request may hold another version of the file; find the quote there.
        const hr = pull.head.repo;
        const text = await this.readFile(hr ? hr.owner.login : this.repo.owner, hr ? hr.name : this.repo.name, anchor.file, pull.head.sha);
        const found = text != null ? locate(text, anchor.quote, line) : null;
        if (found) ({ line, endLine } = found); else line = endLine = null;
      }
      const inDiff = rangeInPatch(f.patch, line, endLine);
      const payload = inDiff
        ? { body: commentBody(anchor, body, true), commit_id: pull.head.sha, path: anchor.file, line: endLine, side: 'RIGHT', ...(endLine > line ? { start_line: line, start_side: 'RIGHT' } : {}) }
        : { body: commentBody({ ...anchor, line, endLine }, body, false), commit_id: pull.head.sha, path: anchor.file, subject_type: 'file' };
      const made = await c.post(`${this.base}/pulls/${pull.number}/comments`, payload);
      return { kind: inDiff ? 'review-line' : 'review-file', url: made.html_url, pr: { number: pull.number, url: pull.html_url }, comment: normalizeReviewComment(made) };
    }
    // No open pull request changes the file: keep the comment as a file.
    const created = this.now().toISOString().replace(/\.\d+Z$/, 'Z');
    const path = `${this.deckDir}/comments/${stamp(this.now())}-${me.login}.md`;
    const content = formatCommentFile({ author: me.login, created, file: anchor.file, line: anchor.line, endLine: anchor.endLine, quote: anchor.quote, body });
    const where = anchor.line != null ? `:${anchor.line}` : '';
    const r = await this.saveEdit({ files: [{ path, content }], message: `Comment on ${anchor.file}${where}` });
    return { kind: 'file', url: r.commit.url, pr: r.pr, path, comment: { ...parseCommentFile(content, path), url: r.commit.url } };
  }

  // Review comments of open pull requests on files of this deck. A preview
  // page shows its own pull request's comments.
  async listComments() {
    const c = this.client;
    const inDeck = x => x.path && x.path.startsWith(this.deckDir + '/');
    if (this.repo.pr) {
      const list = await c.get(`${this.base}/pulls/${this.repo.pr}/comments?per_page=100`);
      return list.filter(inDeck).map(normalizeReviewComment);
    }
    const [pulls, list] = await Promise.all([
      c.get(`${this.base}/pulls?state=open&per_page=100`),
      c.get(`${this.base}/pulls/comments?sort=created&direction=desc&per_page=100`),
    ]);
    const open = new Set(pulls.map(p => p.number));
    return list.filter(x => inDeck(x) && open.has(prNumber(x))).map(normalizeReviewComment);
  }
}
