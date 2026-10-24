# Browser media dependencies

The page loads these local files only after someone starts the video.

- `hls.light.min.mjs`: hls.js 1.7.3, the light ESM build from its npm
  distribution.  Its Apache-2.0 notices are in `hls.js-LICENSE`, with the
  licence text in `APACHE-2.0.txt`.
- `media-peer-demo.js`: the real RelaySwarm browser loader and its signing
  dependencies, bundled from a pinned public source revision.
  `media-peer-demo.build.json` records the source, lockfile, bundle hash and
  included versions.  `media-peer-demo.NOTICE.txt` contains their notices.

The peer bundle is reproduced with:

```sh
node scripts/build-media-peer-demo.mjs /path/to/relayswarm
```

The RelaySwarm checkout must contain the recorded revision and its matching,
installed lockfile dependencies.  The builder archives the pinned source into
temporary staging, checks dependency versions and removes its staging after
building.  It doesn't modify that checkout or add a browser credential.
