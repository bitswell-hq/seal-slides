// Entry point of a built deck page: reads the deck the build embedded,
// mounts it, then fetches open review comments from GitHub in the background.

import { loadDeck } from './loader.js';
import { mountDeck } from './runtime.js';
import { GitHubClient, DeckStore } from './github.js';
import { loadToken } from './auth.js';

const data = JSON.parse(document.getElementById('deck-data').textContent);
const model = loadDeck(data);

if (model.errors.length) {
  const pre = document.createElement('pre');
  pre.style.cssText = 'padding:24px;white-space:pre-wrap;font:14px ui-monospace,monospace';
  pre.textContent = 'This deck failed to load:\n\n' + model.errors.map(e => e.message).join('\n');
  document.body.append(pre);
  throw model.errors[0];
}

const deck = await mountDeck({ data, model, slug: data.deck.slug });
window.sealSlides = deck;

// Read-only viewers see review comments of open pull requests too. Without a
// token this uses GitHub's unauthenticated API, which is rate limited per IP.
if (data.repo && data.repo.owner && navigator.onLine !== false) {
  const store = new DeckStore({ client: new GitHubClient({ token: loadToken() }), repo: data.repo, deckDir: data.deck.dir });
  store.listComments()
    .then(list => deck.setComments([...model.comments, ...list]))
    .catch(e => console.info('seal-slides: review comments not loaded:', e.message));
}
