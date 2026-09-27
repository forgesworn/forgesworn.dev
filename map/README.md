# Ecosystem map

`ecosystem.txt` is the map. Edit it, then run:

```bash
npm run map              # writes both HTML pages, the PNG and the A4 PDF
npm run map -- --strict  # also fail on names missing from forgesworn-repos.json
npm run map -- --html-only
```

It produces two versions from the same source:

| File | What it is |
|------|------------|
| `ecosystem-map.png` | Dark, 1400px wide at 2x, for the web and social posts |
| `ecosystem-map-a4.pdf` | Light, one A4 page, vector, for printing |
| `ecosystem-map.html`, `ecosystem-map-a4.html` | The self-contained pages both are rendered from |

The format is documented at the top of `ecosystem.txt`. Section order is layout
order: sections flow left to right and wrap, so move a section to change which
row it lands on. The build lists catalogued repos that are not on the map.

The A4 page fits itself to the sheet: a script in the page searches for the
largest scale at which everything fits, so adding or removing entries never
needs a layout change. Captions come out at about 7pt. Opening
`ecosystem-map-a4.html` in a browser and printing it at 100% gives the same
page as the PDF.

## Status rings

An entry can carry `| early` (dashed ring) or `| spec` (dotted ring). These come
from reading the code, not from version numbers: `early` marks prototypes and
work whose headline feature is not yet wired end to end; `spec` marks a
specification with no runtime of its own. Everything else has a solid ring.

## Icons

`icons/<repo-name>.png` or `icons/<repo-name>.svg`, in that order. An SVG drawn
in `currentColor` is treated as a glyph and tinted with its section's colour;
any other SVG or PNG is a logo and shown as drawn. Entries with no icon get a
monogram.

Logos come from the repos themselves where one reads well at small size. The
glyphs are from [Lucide](https://lucide.dev) (ISC licence, `icons/LICENCE-lucide.txt`);
each glyph file starts with a comment naming its Lucide icon. To swap one, copy
another Lucide SVG over it and keep the comment.

The PNG and PDF need Playwright's Chromium (`npx playwright install chromium`).
