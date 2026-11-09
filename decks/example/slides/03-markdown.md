---
title: A slide is a Markdown file
status: now
duration: 0:22
notes: |
  The front matter carries everything that is not on the slide.
  The title, a status, and a target length.
  The notes are the script you read aloud, one short line at a time.
  Sources are listed apart, in their own view.
  The body below the front matter is ordinary Markdown.
sources:
  - "README.md, The Markdown slide format"
  - "engine/loader.js"
---
<div class="cols">

```yaml
---
title: A slide is a Markdown file
status: now
duration: 0:22
notes: |
  One line per line read aloud.
sources:
  - "README.md"
---
```

- **title** heads the slide
- **status** picks its marks
- **notes** is the spoken script
- **sources** go to the sources view
- **duration** paces the recording

</div>
