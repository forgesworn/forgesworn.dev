# Articulated fly

The viewer uses the FlyBody anatomical rig with an engineered kinematic
controller.  It does not run MuJoCo or a neural low-level flight policy.

`site/fly/body-controller.js` decodes verified Motor v1 samples into travel,
heading, feeding and an escape-triggered take-off/flight/landing sequence.
`site/fly/fly-body.js` renders the joint hierarchy and uses inverse kinematics
to place six feet.  Feeding and backward travel can run together.  The fly
returns to exploring when the report and its bounded landing transition finish.

`site/fly/scene-director.js` supplies the labelled visitor experience: forward
walking, turning, take-off, flight, landing and grooming.  A fixed camera makes
travel visible.  Feeding a free visual drop or completing a wallet payment
starts an approach, drinking, swallowing and regurgitation sequence.  These
authored actions do not create neural telemetry or financial gifts.  Verified
new reports interrupt exploration; historical reports remain available for
explicit replay. Quiet reports keep exploring. Reports and gifts received during feeding wait
until the interaction finishes.  Reduced motion and pause stop both paths.

`site/fly/assets/brain-recordings.json` contains actual offline brain runs from
the production sandbox.  These stay explicitly labelled and are never inserted
into the authenticated Nostr event feed.  The signing key used by browser test
fixtures is a synthetic, public test key.

## Rebuild

Clone FlyBody at `d015e9bfe441bd90ae431bac24c55cb74bdbce26`.  In a separate
Python 3.12 environment, install `mujoco==3.13.0`, `numpy==1.26.4`,
`trimesh==5.1.0` and `fast-simplification==0.2.0`, then run:

```sh
python tools/fly-body/export-model.py /path/to/flybody site/fly/assets/body
```

The export records the source commit and mesh hash.  Weld duplicated vertices
before decimation; compiled OBJ seams otherwise turn into disconnected triangles.
Preserve the source licence and NOTICE.txt when rebuilding.

## Checks

```sh
npm test
node tools/captures/fly-living.mjs
node tools/captures/fly-body.mjs
```

Browser checks use an isolated headless browser, synthetic signatures and
intercepted relays, with `site/` served at `http://127.0.0.1:8826`.
They send no public messages or payments.  Screenshot capture uses shotguard.
Review the generated desktop and phone arrival, flight, regurgitation and
stepping images as well as the assertions.  Checks cover visible screen travel,
foot lift, stance slip, framing through complete cycles, reduced motion, pause,
tampered events, authenticated neural interruption, failed and mocked successful
wallet payments.  The legacy fly-motor.mjs entry point runs fly-living.mjs.
