# forgesworn.dev

Source for the forgesworn.dev organisation landing page: a static site built
from `forgesworn-repos.json` (the public repo catalogue, fetched from
`forgesworn/.github` at build time) and `forgesworn-use-cases.json` (end-to-end
workflows that compose the catalogue libraries). Node, no framework.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm run sync` | Fetch the canonical `forgesworn-repos.json` |
| `npm run build` | Generate `site/index.html` and `site/use-cases.html` |
| `npm run map` | Generate the ecosystem map from `map/ecosystem.txt` |
| `npm test` | Run the test suite (`node --test test/*.test.mjs`) |
| `npm run check:drift` | Diff the catalogue against the live GitHub org |

There is no separate lint or typecheck script.

## Structure

```
scripts/    build-site.mjs, build-map.mjs, check-catalogue-drift.mjs
site/       static assets and templates (template.html, use-cases-template.html);
            index.html and use-cases.html are generated output, gitignored
tools/      QR generation, Nostr verifier, fly art assets, shotguard checks
map/        ecosystem map source (ecosystem.txt) and generated output
test/       node:test suite
```

## Conventions

- British English in prose.
- `forgesworn-repos.json` has no tracked copy in this repo; it is fetched at
  build time (`npm run sync` locally, a curl step in CI).
- Category presentation (accent colour, entry-point repo, headline, links)
  lives in `scripts/build-site.mjs`, not in the JSON.
- The "Use something today" product grid in `site/template.html` is
  hand-written and editorial, not derived from the catalogue.

## Key Files

| File | Purpose |
|------|---------|
| `forgesworn-use-cases.json` | 32 end-to-end workflows, each naming the catalogue libraries it composes |
| `scripts/build-site.mjs` | Generates `site/index.html` and `site/use-cases.html` |
| `scripts/check-catalogue-drift.mjs` | Fails if a public repo is missing from the catalogue |
| `site/llms.txt` | Served at forgesworn.dev/llms.txt; edit directly, it is not generated |
| `.github/workflows/catalogue-drift.yml` | Weekly CI drift check |
| `.github/workflows/pages.yml` | Builds and deploys the site to GitHub Pages on push to main |

## Common Pitfalls

- `site/index.html` and `site/use-cases.html` are gitignored generated output:
  do not hand-edit them, edit the templates or source JSON instead.
- A new category in `forgesworn-repos.json` still renders even if
  `scripts/build-site.mjs` does not know it, using fallbacks; add proper
  handling there rather than relying on the fallback long-term.
- `forgesworn-repos.json` must be fetched (`npm run sync`) before a local
  build; it is not committed.
