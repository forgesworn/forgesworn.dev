# forgesworn.dev

Source for the [forgesworn.dev](https://forgesworn.dev) organisation landing page.

ForgeSworn publishes open-source building blocks for sovereign commerce, identity,
privacy, and trust. The public project set covers machine-payable APIs,
deterministic Nostr identities, encrypted access control, privacy-preserving
trust, spoken verification, spatial coordination, AI-agent tooling,
cryptographic primitives, protocol work, and hardened release infrastructure.

## Public Repo Catalogue

The landing page is generated from `forgesworn-repos.json`. The canonical copy
lives in [forgesworn/.github](https://github.com/forgesworn/.github) — this repo
holds no tracked copy. CI fetches it at deploy time; locally, run `npm run sync`
to pull it before building. The catalogue excludes org/profile plumbing and
upstream forks.

A weekly CI job (`catalogue-drift.yml`) diffs the canonical catalogue against
the live GitHub org and fails if a public repo is missing from it, so the
catalogue cannot rot silently. Run it locally with `npm run check:drift`.

Current focus areas:

- L402 / Machine Payments
- Spatial / Meeting
- Identity / Access
- AI Agents
- Trust / Privacy
- Cryptographic Primitives
- Compliance
- Protocol / Standards
- Tooling / Demos

## Use Cases

The use-cases page (`/use-cases.html`) is generated from
[forgesworn-use-cases.json](forgesworn-use-cases.json) — 25 end-to-end
workflows that compose the catalogue libraries, each with a persona, the
step-by-step flow, and the building blocks it uses. Stack links are resolved
against `forgesworn-repos.json` at build time, so each block links back to its
repo. Add or edit workflows in the JSON; no template changes needed.

## Development

```sh
npm run sync    # fetch the canonical forgesworn-repos.json
npm run build   # generates site/index.html and site/use-cases.html
npm test
```

Both pages are generated output (gitignored) and are rebuilt in CI on deploy.

## Licence

MIT. See [LICENCE](LICENCE).
