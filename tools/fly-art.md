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

The atlas is illustrative artwork. The default view replays signed `Motor:`
telemetry from the brain, ten times slower: 50 ms bins of escape, feeding,
forward walking, turning, backward walking and song drive. Strength and turning
balance come from the readouts. The fly stays still between reports. Pokes and
incoming payments never manufacture a motor response, and older prose-only
reports have no movement fallback. A gift notice has a separately labelled
illustration; it is not inferred from feeding activity.

There is no sustained-flight or grooming readout in the current graph. Those
scripted animations live in the explicitly labelled demonstration disclosure.
The renderer maps readouts to visual motion; it is not a physical flight model.

The locally served `vendor/nostr-verify.js` verifies event hashes and Schnorr
signatures before relay events enter the page state. It contains pinned Noble
code, with licences and build provenance beside the bundle. Rebuild with
`FLY_BUILD_NODE_MODULES=/path/to/node_modules node tools/build-nostr-verifier.mjs`
using esbuild 0.28.2, @noble/curves 2.0.1 and its @noble/hashes 2.0.1 dependency.
No remote scripts are loaded.

## Review locally

Use Node 24. Run `npm test` and `npm run build`. Serve the site with
`python3 -m http.server 8826 --bind 127.0.0.1 --directory site`, then open
`http://127.0.0.1:8826/fly/#stage`.

With Playwright available, `node tools/captures/fly.mjs` captures desktop and
390px phone previews and a motion recording under ignored `captures-out/fly/`.
It uses fresh headless contexts and intercepted relay connections; previews
must publish no Nostr events. Screenshots pass through the existing shotguard.
The script checks the demonstration animations, no horizontal overflow, no page
errors, reduced motion and a frozen paused canvas. `node tools/captures/fly-motor.mjs`
checks the real report-to-renderer path using a full-connectome output signed by
an explicitly synthetic identity. Intercepted relays prove idle time, a poke,
a payment and a forged report stay still; an authentic report replays and stops;
and a quiet report stays still. The production fly identity is substituted only
in intercepted test HTML, never through a production test hook.

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

Motor telemetry update: all 28 Node tests and desktop/phone motor-path browser
checks pass. The neural model and image remain unchanged.
