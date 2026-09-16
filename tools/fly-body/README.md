# Articulated fly

The viewer uses the FlyBody anatomical rig with an engineered kinematic
controller.  It does not run MuJoCo or a neural low-level flight policy.

`site/fly/body-controller.js` decodes verified Motor v1 samples into travel,
heading, feeding and an escape-triggered take-off/flight/landing sequence.
`site/fly/fly-body.js` renders the joint hierarchy and uses inverse kinematics
to place six feet.  Feeding and backward travel can run together.  The fly
rests when the report and its bounded landing transition finish.

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
node tools/captures/fly-motor.mjs
node tools/captures/fly-body.mjs
```

Browser checks use an isolated headless browser, synthetic signatures and
intercepted relays, with `site/` served at `http://127.0.0.1:8826`.
They send no public messages or payments.  Screenshot capture uses shotguard.
Review the generated desktop and phone flight/landing/retreat images as well
as the assertions.  Reduced motion, pause, quiet reports, tampered events and
wallet success without motor telemetry are covered separately.
