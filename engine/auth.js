// The viewer's GitHub token lives in this page's memory only: it is gone on
// reload, is never written to sessionStorage, localStorage, a cookie or the
// repository, and is sent only to api.github.com. Storage is shared by every
// page of the origin (pull-request previews, other Pages sites of the
// organisation), so nothing is kept there.

let token = null;

export function loadToken() {
  return token;
}

export function saveToken(t) {
  token = t;
}

export function clearToken() {
  token = null;
}

// A pasted token, trimmed; null when it cannot be a GitHub token.
export function cleanToken(s) {
  const t = String(s || '').trim();
  return /^(?:github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(t) ? t : null;
}
