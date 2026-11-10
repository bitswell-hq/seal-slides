# seal-slides

Slide decks written in Markdown, with hand-drawn animated SVG slides where a slide needs motion, an in-browser editor that saves edits and comments to the repository through GitHub, and a session recorder that turns the deck and your voice into a 1920×1080 video. The build writes static files for GitHub Pages; nothing runs on a server.

The engine comes from the Perch decks (the pitch, SCF submission and paper decks in [stellar-registry/perch](https://github.com/stellar-registry/perch)): their navigation, light and dark themes, portrait and landscape layouts, SVG drawing context, icons, seals, spoken-script speaker notes, sources view and recorder. It carries no Perch content. One example deck lives in [`decks/example/`](decks/example/) and is published at <https://bitswell-hq.github.io/seal-slides/example/>.

## Quick start

```sh
npm ci
npm run dev          # builds site/ and serves it at http://127.0.0.1:8080/
```

Open <http://127.0.0.1:8080/example/>. Node 22 or later.

## Authoring a deck

A deck is a folder under `decks/`. The folder name is the deck's address on the site (`decks/example/` is published at `/example/`).

```text
decks/example/
  deck.md              the deck: title, target length, status labels, seals
  slides/              one Markdown file per slide, in file-name order
    01-title.md
    02-folder.md
    ...
  animations/          drawing modules that slides name with draw:
    dial.js
    pipeline.js
  comments/            comments kept as files (see Editing and comments)
  deck.css             optional: overrides of the engine's colours and fonts
  assets/              optional: images and other files the slides link to
```

Slides are ordered by file name, with numbers compared as numbers, so `2-x.md` comes before `10-y.md`. One file per slide keeps a slide's history, its pull-request diff and its comments in one place.

`deck.md` holds the deck's front matter; its body is not shown.

| Key | Meaning |
| --- | --- |
| `title` | The deck's title, used for the page title. |
| `description` | The page's meta description and the line under the deck on the site's index. |
| `duration` | Target length of the whole deck, as `m:ss` or seconds. The recorder's timer counts against it. Without it, the slides' durations are added up. |
| `statuses` | The label each slide status shows, for example `now: works today` and `next: planned`. A status without a label shows its marks but no label. |
| `seals` | Named seals as 64 hex digits (32 bytes) each, for example `A: a17ed1…`. Seal `A` exists even when none is given. |
| `theme` | `auto` (follow the system, the default), `light` or `dark`. |
| `lang` | The page language, `en` by default. |

The build stops on an unknown key, a malformed value or a missing drawing module, and names the file and line.

## The Markdown slide format

Each slide is a Markdown file with front matter:

```markdown
---
title: A slide is a Markdown file
status: now
duration: 0:30
notes: |
  The front matter carries everything that is not on the slide.
  The title, a status, and a target length.

  A blank line is a pause.
sources:
  - "README.md, The Markdown slide format"
  - "[A paper](https://example.org/paper), p. 4"
---
The body is ordinary Markdown (GitHub-flavoured): paragraphs, lists,
**emphasis**, `code`, fenced code blocks, tables, block quotes and links.
```

| Key | Meaning |
| --- | --- |
| `title` | Required. The slide's heading. |
| `status` | `plain` (the default: an engraved frame, no label), `now` (solid marks), `next` (dashed marks and printer's proof marks, for planned work), `cited` (plain ink, for someone else's work) or `title`. The label comes from the deck's `statuses`. |
| `layout` | `default` (heading, then the body or the drawing), `title` (a large title beside the drawing) or `center` (one centred statement). |
| `duration` | Target time for the slide, as `m:ss` or seconds. The script panel and the recorder show it. |
| `notes` | The spoken script: short lines read aloud, one per line. Inline Markdown works. A list of strings works too. |
| `sources` | Where the slide's claims come from, one string per source; inline Markdown links work. They are shown apart from the script. |
| `draw` | A drawing module for an animated slide, as a path inside the deck folder (see Animated slides). |
| `alt` | Required with `draw`: what the drawing shows, for screen readers. |
| `kicker` | `title` layout only: a small line above the title. |
| `legend` | `title` layout only: `true` adds a legend of the deck's status labels. |

Relative links and image paths resolve against the deck folder (where the page is served), not the `slides/` folder: write `assets/photo.png`. Raw HTML is allowed in the body, so a slide can lay out columns with `<div class="cols">…</div>` (leave a blank line after the opening tag so the Markdown inside is still read). Other classes the engine styles inside slides: `lead` (a larger display paragraph) and `muted` (secondary ink).

### Speaker script and sources

`N` shows the current slide's script, headed by its target time, its word count and a reminder that the sources are behind `S`. `S` shows the current slide's sources instead, with a link to every slide's sources on one page. The example deck's script is 306 words, about 2:02 at 150 words a minute; its slides' targets add up to 2:15, inside the deck's 3:00 limit. The editor's Script tab shows the estimate for each slide as you write.

## Animated slides

A slide that needs motion names a drawing module with `draw:`. The module's default export describes the drawing:

```js
// decks/example/animations/pipeline.js
export default {
  // viewBox for landscape and for portrait windows
  viewBox: ['0 0 1600 760', '0 0 800 1240'],
  // Draw the slide's final picture. Runs again when the window turns.
  draw(c) {
    const T = c.tall;                       // true in portrait
    c.icon('doc', T ? 400 : 220, T ? 150 : 360, 140, { k: 'ink' });
    c.at(600);                              // the next marks appear from 600 ms
    c.arrow(300, 360, 578, 370, { k: 'soft', w: .8 });
    c.seal(800, 370, 112);
  },
  // Optional: start and stop anything that keeps playing.
  enter(svg, { still, Anim }) { /* ... */ },
  leave(svg) { /* ... */ },
  // Optional: extra icons, as [tag, attributes] lists in a 60-unit box.
  icons: {},
};
```

Every mark the context draws prints itself once when the slide arrives (lines draw, fills fade in, dashed `next` lines march) and takes its colour from the theme, so one drawing serves the light and dark themes. `?still=1`, reduced motion and edit mode show the final picture without motion.

The drawing context `c`:

| Member | What it draws |
| --- | --- |
| `line`, `path`, `circle`, `rect` | Plain shapes. |
| `text`, `lines` | Text, or several lines of it; `c.wrap(s, n)` breaks a sentence into lines of at most `n` characters. |
| `arrow`, `curve`, `head` | Arrows, S-curves (`head: true` for an arrowhead), arrowheads. |
| `chip` | A rounded label. |
| `icon(name, x, y, size)` | An icon: key, person, passkey, secret, envelope, tree, account, controller, stamp, hourglass, sig, proof, check, cross, agent, shop, cup, doc, coin, warn, policy, door, factory, desk, mic, pencil, comment, branch. |
| `seal(x, y, r, { id })` | One of the deck's seals: a guilloché rosette drawn from its 32 bytes. |
| `node`, `pin`, `region`, `box`, `btree` | A labelled circle, a dot, a hatched region, a box with a `double`, `single` or `hatched` border, a binary tree with one path lit. |
| `at(ms)`, `group(transform)` | Set the entrance clock; start a new group. |
| `tall`, `fs`, `sw`, `E`, `f2`, `deg` | Orientation, base font size and stroke width, an SVG element helper, rounding, degrees. |

Common options on every call: `k` (stroke colour: `ink`, `soft`, `faint`, `now`, `next`, `seal`, `paper`), `w` (stroke width as a multiple of the base), `fill`, `d` (entrance delay in ms), `anim` (`an-draw`, `an-fade`, `an-march`, `an-seal`, `an-sweep`, `none`) and `p` (parent element). [`engine/draw.js`](engine/draw.js) documents the rest.

A module needs no imports: everything comes through `c` and the second argument of `enter`. That is also what lets the editor redraw an edited module live.

## Controls

| Key | Action |
| --- | --- |
| → ↓ Space PageDown | Next slide |
| ← ↑ Shift+Space PageUp | Previous slide |
| Home, End | First, last slide |
| `N` | Speaker script |
| `S` | Sources for this slide |
| `T` | Light or dark theme (remembered for the deck) |
| `E` | Edit mode |
| `R` | Record a video; `R` again stops and saves |
| `P` | Pause or resume a recording |
| Escape | Cancel the recording countdown; close the all-sources page |

Swipe in any direction on a touch screen, or tap the right or left of the slide. `#4` in the address opens slide 4; `?theme=dark`, `?still=1`, `?notes=1`, `?sources=1` and `?edit=1` set the matching state on load.

## Editing and comments

`E` (or the pencil button) opens the editor beside the slide. The deck keeps working: arrow keys move between slides when the cursor is not in a text box.

- **Slide**: the slide's Markdown file. The slide redraws as you type; a front-matter mistake is shown with its line and the last good version stays on screen.
- **Script** and **Sources**: the slide's `notes` and `sources`, one line each. Typing here rewrites only that key of the front matter.
- **Drawing**: the slide's drawing module, for animated slides. Redraw (Ctrl+Enter) imports the edited text and redraws the slide.
- **Comments**: the slide's comments, and a box to write one.

### Signing in

Saving uses the viewer's own GitHub account. Paste a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with read and write access to **Contents** and **Pull requests** on this repository. The token is kept in this tab's `sessionStorage` only, so it is gone when the tab closes; it is never written to the repository, a cookie or `localStorage`, and it is sent only to `api.github.com`. Someone without push access to the repository needs a token that can fork it (a classic token with `public_repo`); their edits go through their fork.

GitHub's device flow would avoid pasting a token, but its endpoints (`github.com/login/device/code` and `github.com/login/oauth/access_token`) do not answer cross-origin requests from a browser, so it needs a server to relay them, and this project runs none.

### What saving does

Save commits every changed file in one commit and opens a pull request:

1. On the published site, the first save creates a branch `seal-slides/<deck>/<login>-<time>` from the commit the page was built from and opens a pull request into the branch the page was built from. Later saves add commits to that branch while its pull request is open.
2. On a pull-request preview, saves commit to that pull request's branch, when you can push to it.
3. Without push access, the branch is created in your fork (made on first use) and the pull request comes from it.

Edit mode asks you to sign in before the first edit: the editor's text boxes are read-only until you have. Viewing the deck and reading comments need no sign-in. When a pull request of yours from the editor is open, signing in loads that pull request's version of each file it changed, redraws the slides with it and says so with a link, so a second edit builds on the first and not on the page as built.

Before committing to an existing branch, the editor checks that each file the pull request changes is still the text it loaded; if it changed in the pull request in between, nothing is committed, and the editor links the pull request and offers to copy your text and to load the newer version of that file, so you can put your edit back. Your changes to other files stay as they are. A file the pull request does not change is committed as you edited it.

### Comments

Select text on the slide, in the script panel or in any of the editor's text boxes (including a drawing module's code) and press **Comment**; or comment on the whole slide. The comment is anchored to the file and lines that hold the selection.

- When an open pull request changes that file, the comment becomes a review comment on it: on the selected lines when they are part of the diff, otherwise on the file, quoting the selection and its line numbers. If the pull request holds another version of the file, the quote is found again there to get the right line.
- Otherwise it becomes a comment file, `decks/<deck>/comments/<time>-<login>.md`, committed and opened as a pull request the same way as an edit. Its front matter records the author, time, file, lines and quoted text; its body is the comment. Comment files are part of the build, so once merged they show on the published deck.

Anyone can read comments without signing in: the comment button in the controls shows how many the current slide has. The published site shows comment files and the review comments of open pull requests on the deck's files; a preview shows its own pull request's review comments. Comments are always shown as plain text.

## Recording a session

The record button in the controls, or `R`, records the deck with your voice and saves a video file. Everything happens in the browser; nothing is uploaded. The recorder is the one the Perch SCF deck uses, generalised for Markdown slides.

1. Press `R` and allow the microphone. If it is blocked, the deck says so and records nothing; allow it in the site settings and press `R` again.
2. The deck prepares the slides, then counts down 3, 2, 1. `R` or Escape cancels the countdown.
3. Present as usual with the arrow keys. A presenter panel, top right, shows the script for the current slide, the time against the deck's target, the time on this slide against its target, and the next slide. The panel is not in the video.
4. `P` pauses and resumes. `R`, or Stop and save, ends the recording and downloads `<deck>-<date>-<time>.mp4`, or `.webm`. The message names the format, size and length.

The video is 1920×1080 at 30 frames a second, with no camera. The recorder lays copies of the slides out at 1920×1080 in an invisible box and paints each slide in its final state onto a canvas: drawings as images, text, backgrounds, borders and list markers where the browser laid them out. The recording is that canvas plus the microphone, through `MediaRecorder`. Slides change with a short crossfade; arrival animations and drawings that keep playing are not recorded, and images from another origin are left out (they would stop the canvas from being recorded). The recording uses the theme in effect when it starts, and unsaved edits are included.

The file is MP4 (H.264 and AAC) where the browser's `MediaRecorder` can write it, as in Safari and recent Chrome, and WebM (VP9 or VP8 with Opus) otherwise; the recorder writes the duration that WebM files from `MediaRecorder` lack. The recorder needs `MediaRecorder`, canvas capture and a microphone, which recent Chrome, Edge, Firefox and Safari provide; it has been tested in Chromium only.

## Deploying

`.github/workflows/pages.yml` builds every deck on each push to `main` and publishes `site/` on the `gh-pages` branch. `.github/workflows/preview.yml` publishes each same-repository pull request under `/pr-preview/pr-<number>/` on the same branch, keeps a comment with the link on the pull request, and removes the preview when the pull request closes. Both build without write access and hand the site to a separate job that pushes it.

The repository needs two settings once: Pages serving from the `gh-pages` branch (Settings → Pages → Deploy from a branch), and Actions allowed to write to the repository (Settings → Actions → General → Workflow permissions), which the deploy and preview jobs use to push `gh-pages` and comment.

The build takes the repository the editor saves to from flags or the environment, then from the local git checkout:

```sh
node scripts/build.mjs [--decks decks] [--out site] [--repo owner/name] [--ref branch] [--sha commit] [--pr number]
# or SEAL_SLIDES_REPO, SEAL_SLIDES_REF, SEAL_SLIDES_SHA, SEAL_SLIDES_PR
```

Each deck page embeds its Markdown, loads the engine from `../engine/`, and carries a Content Security Policy that allows scripts only from the site itself, its inline import map (by hash) and drawing modules edited in the page, and fetches only from the site and `api.github.com`.

## Tests

```sh
npm test                           # unit tests, Node's built-in runner
npx playwright install chromium    # once
npm run test:smoke                 # headless Chromium
```

- `test/loader.test.mjs`: front matter, line maps, ordering, durations, errors with file and line, Markdown rendering with line anchors, front-matter edits that round-trip through YAML, finding a quote in a file.
- `test/github.test.mjs`: the persistence layer against a mocked GitHub API: new branch and pull request, reusing the viewer's pull request, loading its version of the files, conflicts, previews committing to their pull request's branch, forks (and syncing a fork that lags), line and file review comments, re-finding a quote in a newer file, comment files, and reading comments without a token.
- `test/build.test.mjs`: the example deck builds; the page's CSP matches its import map; deck text cannot close the page's script element; a broken deck is reported with file and line and writes nothing.
- `test/recorder.test.mjs`: the WebM duration fix and the choice of MP4 or WebM.
- `test/serve.test.mjs`: the dev server serves its folder and nothing beside it.
- `test/smoke/smoke.test.mjs`: in headless Chromium with fake media devices and a fake GitHub API: navigation, hash, marks, script and sources panels, theme, portrait drawings; read-only comments; edit mode (sign-in before the first edit, live preview, a YAML error, script and sources edits, save, a comment on a selected line, a slide change while typing, loading the viewer's open pull request, and a conflict on one file with its text copied and its newer version loaded while another file's edit is kept); recording with pause (the file is 1920×1080 with an audio track, its frames match the painted slides and hold nothing of the presenter panel), a blocked microphone and a cancelled countdown; and each painted slide against a screenshot of the live slide.

Verified by hand for this version: the example deck's slides in light theme at 1440×900 and in portrait, edit mode and a recording in headless Chromium 156, viewed as screenshots. Not verified: Safari and Firefox, a real microphone, signing in with a real token against github.com, and the Pages and preview workflows (they run once this repository's settings above are in place).

## Repository layout

```text
engine/           the browser engine, plain ES modules with no build step
  boot.js         entry point of a built deck page
  loader.js       the Markdown loader (runs in Node and the browser)
  runtime.js      slides, navigation, themes, script and sources panels
  draw.js         the SVG drawing context, icons and seals
  editor.js       edit mode
  github.js       the GitHub persistence layer (runs in Node and the browser)
  auth.js         where the token is kept
  recorder.js     the session recorder
  seal-slides.css
scripts/build.mjs builds decks/ into site/
scripts/serve.mjs serves site/ locally
decks/example/    the example deck
test/             unit tests and the browser smoke test
```

Dependencies, pinned: [`marked`](https://github.com/markedjs/marked) 18.1.1 and [`js-yaml`](https://github.com/nodeca/js-yaml) 5.5.0 (copied into `site/engine/vendor/` with their licences), and [`playwright`](https://github.com/microsoft/playwright) 1.64.1 for the smoke test only.

## License

MIT; see [LICENSE](LICENSE).
