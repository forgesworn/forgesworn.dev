# forgesworn.dev

Source for the [forgesworn.dev](https://forgesworn.dev) organisation landing page.

ForgeSworn publishes open-source building blocks for sovereign commerce, identity,
privacy, and trust. The public project set covers machine-payable APIs,
deterministic Nostr identities, encrypted access control, privacy-preserving
trust, spoken verification, spatial coordination, AI-agent tooling,
cryptographic primitives, protocol work, and hardened release infrastructure.

## Public Repo Catalog

The landing page is generated from [forgesworn-repos.json](forgesworn-repos.json),
which tracks the public ForgeSworn project repos. The catalog excludes
org/profile plumbing and upstream forks.

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

## Development

```sh
npm run build
npm test
```

## Licence

MIT. See [LICENCE](LICENCE).
