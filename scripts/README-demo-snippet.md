# README demo embed snippets

Pick one of these snippets to paste into `README.md` between the title and the
Install section after `docs/demo.cast` (or `docs/demo.svg`) exists.

## Option A — asciinema badge (hosted player)

Upload with `asciinema upload docs/demo.cast`, note the returned cast id
(e.g. `702134`), then:

```markdown
[![asciicast](https://asciinema.org/a/<CAST_ID>.svg)](https://asciinema.org/a/<CAST_ID>)
```

Pros: real playback, scrubbable, copy-pasteable text.
Cons: requires clicking through to asciinema.org to view.

## Option B — static SVG (inline in GitHub)

Render with `svg-term --in docs/demo.cast --out docs/demo.svg --window`, commit
`docs/demo.svg`, then:

```markdown
![maw demo](docs/demo.svg)
```

Pros: renders directly on GitHub without a click.
Cons: animation only — no scrubbing, no text copy.

## Option C — both (recommended)

Use the SVG for above-the-fold visual, link the asciinema page for
"play interactively":

```markdown
[![maw demo](docs/demo.svg)](https://asciinema.org/a/<CAST_ID>)

> _Click the recording to play interactively on asciinema.org._
```

## Placement

Put the embed immediately after the project title/tagline and before the
`## Install` section. Current README structure:

```
# maw-js
> tagline
<-- PASTE EMBED HERE -->
## Install
```
