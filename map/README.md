# Ecosystem map

`ecosystem.txt` is the map. Edit it, then run:

```bash
npm run map              # writes ecosystem-map.html and ecosystem-map.png
npm run map -- --strict  # also fail on names missing from forgesworn-repos.json
```

The format is documented at the top of `ecosystem.txt`. Section order is layout
order: sections flow left to right and wrap, so move a section to change which
row it lands on. Icons are `icons/<repo-name>.svg`; anything without one gets a
monogram in its section's colour.

The PNG needs Playwright's Chromium (`npx playwright install chromium`).
