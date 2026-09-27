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

The map shows one entry per product someone could pick up on its own, or with
someone else's software: a language port of an existing entry, or a piece that
only works with one other ForgeSworn product, stays off the map. A port keeps
its own `map/icons/<name>` file, a byte-identical copy of its parent's icon,
kept for reference even though it is not drawn.

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

Logos come from the repos themselves where one reads well at small size, kept
untouched. Everything else is a glyph generated with GPT-Image Sunburst by
`scripts/gen-icons.mjs`:

```bash
node scripts/gen-icons.mjs                    # draw everything queued, within the spend cap
node scripts/gen-icons.mjs --only kenspeckle  # names starting with this
node scripts/gen-icons.mjs --force            # regenerate, keeping the old original
node scripts/gen-icons.mjs --redo             # re-trace every existing original, no API call
```

Each call is logged to `icons/icon-ledger.json` with its token usage and cost;
the run stops before any call that could take total spend past its cap. The
untouched generated original for `<name>` is kept at
`icons/originals/<name>.png`, threshold-and-traced with potrace into
`icons/originals/<name>.trace.svg`, then normalised into the glyph at
`icons/<name>.svg`: centred in a square viewBox, `fill="currentColor"`, no
embedded raster. To redo one icon that doesn't read well, edit its prompt in
`scripts/gen-icons.mjs` and re-run with `--only <name> --force`; a bad
normalisation alone can be redone from the existing trace with `--redo`, no
new spend. `--force` never overwrites a paid original: the old one is kept
alongside with a timestamp.

One glyph, `icons/notelocker.svg`, is still a stand-in from
[Lucide](https://lucide.dev) (ISC licence, `icons/LICENCE-lucide.txt`) for an
entry that is currently commented out in `ecosystem.txt`; its comment names
the Lucide icon it copies. Once notelocker is drawn or dropped for good, and
no other Lucide file remains, delete `icons/LICENCE-lucide.txt` too.

The PNG and PDF need Playwright's Chromium (`npx playwright install chromium`).
