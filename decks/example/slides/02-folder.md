---
title: One folder per deck
status: now
duration: 0:20
notes: |
  A deck is one folder.
  deck.md holds the title, the target length and the status labels.
  Every slide is its own Markdown file, read in file-name order.
  Drawn slides are small JavaScript modules beside them.
  The build turns the folder into static files, with no server.
sources:
  - "README.md, Authoring a deck"
  - "scripts/build.mjs"
---
```text
decks/example/
  deck.md              title, duration, status labels, seals
  slides/
    01-title.md        one Markdown file per slide
    02-folder.md
    04-drawn.md        draw: animations/pipeline.js
  animations/
    pipeline.js        a drawn slide
  comments/            comments kept as files
```

`npm run build` writes `site/`, ready for GitHub Pages.
