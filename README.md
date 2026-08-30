# forgesworn.dev

Source for the [forgesworn.dev](https://forgesworn.dev) organisation landing page.

ForgeSworn is an open-source workshop: apps people can use today and libraries
developers can build with, on Nostr, Lightning and plain cryptography. The public
project set covers machine-payable APIs and Lightning bearer notes, deterministic
Nostr identities and hardware signers, encrypted access control and family
wardship, privacy-preserving trust, spoken verification, content-addressed
storage, video rooms and live streams over Nostr, spatial coordination, AI-agent
tooling, cryptographic primitives, protocol work, and hardened release
infrastructure.

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

- Payments / L402
- Identity / Access
- Storage / Data
- Live / Real-time
- Spatial / Meeting
- AI Agents
- Trust / Privacy
- Cryptographic Primitives
- Compliance
- Protocol / Standards
- Tooling / Demos

Presentation for each area (accent colour, entry-point repo, plain-English
headline, website/demo/docs links) lives in `scripts/build-site.mjs`, not in the
JSON. A category the JSON has but the script does not know is still rendered,
after the known ones, with sensible fallbacks.

## Use Cases

The use-cases page (`/use-cases.html`) is generated from
[forgesworn-use-cases.json](forgesworn-use-cases.json) — 32 end-to-end
workflows that compose the catalogue libraries, each with a persona, the
step-by-step flow, and the building blocks it uses. Stack links are resolved
against `forgesworn-repos.json` at build time, so each block links back to its
repo. Add or edit workflows in the JSON; no template changes needed. The workflow
count in the page title, meta tags and hero is filled in at build time.

## Products

The "Use something today" grid on the landing page is hand-written in
`site/template.html`: it names things that are not all catalogue building
blocks (flock, DonkeyRide, My Signet) and its copy is editorial. Update it when
a product launches or its promise changes.

## Development

```sh
npm run sync    # fetch the canonical forgesworn-repos.json
npm run build   # generates site/index.html and site/use-cases.html
npm test
```

Both pages are generated output (gitignored) and are rebuilt in CI on deploy.

## Licence

MIT. See [LICENCE](LICENCE).
