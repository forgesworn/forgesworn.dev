# Fly artwork and motion

The fly page uses an offline-generated transparent sprite atlas and a local
Canvas 2D renderer. No image API is called by visitors. The brain, wallet,
gift selection and live agent deployment are outside this change.

## Artwork provenance

- Model requested: `gpt-image-2.5-sunburst`, via the Image API and the installed
  imagegen skill's fallback CLI. One generation, then one edit, on 2026-09-16.
- Parameters: `1536x1024`, `quality=high`, `background=transparent`, PNG.
- [Generation prompt](fly-art-prompt.txt) and [edit prompt](fly-art-edit-prompt.txt).
- Final atlas: [fly-atlas-sunburst.png](../site/fly/assets/fly-atlas-sunburst.png).
- SHA-256: `7291745da09d1f6e065a8556646cb8ed90e98ed8506c131bbfb39f14a2259fc5`.
- Six 512px cells: flight, landing, rest, feeding, regurgitation, grooming.
  The renderer registers poses individually; generated cell coordinates are
  approximate rather than reliable rigging anchors.
- Official reference: [Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
  and [image generation](https://developers.openai.com/api/docs/guides/image-generation).

The atlas is illustrative artwork, not measured biological motion. Flight uses
local paths, depth scaling and wing compositing. Landing transitions into a
grounded pose. Feeding consumes a surface drop; sharing grows one and retracts
the head. The browser recognises the runtime's public `Trophallaxis. The fly
brought up … sats` notice as sharing as well as the older `gave a drop` phrase.
Ambient movement and preview controls are labelled separately from brain reports.

## Review locally

Use Node 24. Run `npm test` and `npm run build`. Serve the site with
`python3 -m http.server 8826 --bind 127.0.0.1 --directory site`, then open
`http://127.0.0.1:8826/fly/#stage`.

With Playwright available, `node tools/captures/fly.mjs` captures desktop and
390px phone previews and a motion recording under ignored `captures-out/fly/`.
It uses fresh headless contexts and intercepted relay connections; previews
must publish no Nostr events. Screenshots pass through the existing shotguard.
The script checks flight → landing → grooming, feeding, sharing, no horizontal
overflow, no page errors, reduced motion and a frozen paused canvas.

The artwork is 1.9 MB, self-hosted and loaded once. Motion stops when the stage
is offscreen, the tab is hidden, or the user pauses. Reduced-motion preferences
start with a still pose; preview buttons can select another still pose.

The public site deploys through the repository's GitHub Pages workflow.
Screenshots and browser checks do not establish physical iPhone performance or
acceptance. The animation does not establish whether the running agent is armed
to give gifts.

Validation on 2026-09-16: build and 22 Node tests passed; Chromium desktop/phone
captures and motion checks passed; Firefox at 390px loaded the artwork and
sharing preview with reduced motion. The installed WebKit engine stalled at
startup and was stopped, so Safari remains unverified.
