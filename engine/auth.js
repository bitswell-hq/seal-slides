// The viewer's GitHub token lives in this tab's sessionStorage only: it is
// gone when the tab closes, is never written to localStorage, a cookie or the
// repository, and is sent only to api.github.com.

const KEY = 'seal-slides:github-token';

export function loadToken() {
  try { return sessionStorage.getItem(KEY) || null; } catch (_) { return null; }
}

export function saveToken(token) {
  try { sessionStorage.setItem(KEY, token); } catch (_) { /* storage unavailable: the token lasts until reload */ }
}

export function clearToken() {
  try { sessionStorage.removeItem(KEY); } catch (_) { /* storage unavailable */ }
}

// A pasted token, trimmed; null when it cannot be a GitHub token.
export function cleanToken(s) {
  const t = String(s || '').trim();
  return /^(?:github_pat_|ghp_|gho_|ghu_)[A-Za-z0-9_]{20,}$/.test(t) ? t : null;
}
