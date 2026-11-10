---
title: Some slides are drawn
status: now
draw: animations/pipeline.js
alt: A Markdown file goes into the engine, marked with a seal, and comes out as a slide. A dot travels the path from file to slide.
duration: 0:25
notes: |
  When a slide needs motion, it names a drawing module.
  The module draws with a small context: lines, curves, icons, chips and seals.
  Every mark prints itself once, when the slide arrives.
  The same drawing gets a landscape and a portrait layout.
  And a module can keep playing, like the dot moving along this path.
sources:
  - "README.md, Animated slides"
  - "engine/draw.js"
---
`draw: animations/pipeline.js` in the front matter
