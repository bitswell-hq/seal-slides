// The viewer's GitHub token lives in this page's memory only: it is gone on
// reload, is never written to sessionStorage, localStorage, a cookie or the
// repository, and is sent only to api.github.com. Storage is shared by every
// page of the origin, so nothing is kept there.
//
// Memory is not out of reach of the origin's other pages either: a page that
// frames this one, or opened it, holds a handle on this window and can read
// what is typed into it. The editor therefore offers no sign-in unless the
// page stands alone. That check stands in for a `frame-ancestors 'none'`
// response header, which GitHub Pages cannot send and a meta Content Security
// Policy cannot set. It is a best effort: a same-origin page that opened this
// one can clear `opener` first, and any script running in this page can read
// the token, so the token is as safe as the origin's published pages are.

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

// Whether no other page holds this window: it is not framed and has no opener.
export function standsAlone() {
  return window.top === window && !window.opener;
}

// A pasted token, trimmed; null when it cannot be a GitHub token.
export function cleanToken(s) {
  const t = String(s || '').trim();
  return /^(?:github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(t) ? t : null;
}
