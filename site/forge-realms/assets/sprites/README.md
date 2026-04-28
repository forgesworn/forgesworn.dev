# Sprite Assets

Production sprite atlases belong here. The current `v3/` files are generated deterministic SVG sprites used by the game while the final atlas art is being produced. The older `v1/` and `v2/` sets are kept as fallback references.

Expected atlas files:

- `units-v1.png`
- `units-v1.json`
- `buildings-v1.png`
- `buildings-v1.json`
- `resources-v1.png`
- `resources-v1.json`

See `docs/sprite-atlas-spec.md` for frame naming, animation, anchor, and sizing rules.

Regenerate the current integrated placeholder set with:

```bash
npm run sprites
```

`atlas-v1/runtime.json` and `runtime-*.png` are the canonical runtime atlas outputs. `runtime-webp.json` and `runtime-*.webp` are optimized mobile/web derivatives generated from those PNGs. Keep both sets: the PNG atlas preserves the high-quality source, while the game chooses WebP at runtime when the browser supports it.
