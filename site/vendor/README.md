# Browser media dependencies

The page loads these local files only after someone starts the video.

- `hls.light.min.mjs`: hls.js 1.7.3, the light ESM build from its npm
  distribution, retained for the public muxed-media demo.  `hls.build.json`
  records its original and served hashes and the removed source-map comment.
- `hls.min.mjs`: the full hls.js 1.7.3 minified ESM distribution, used for every
  local comparison treatment.  It includes the alternate-audio controllers
  needed by MediaMTX's separate HLS audio rendition.  The light build omits
  those controllers, so it cannot establish matched audio/video playback.
  `hls.full.build.json` records the official npm archive integrity, source
  revision and unchanged asset SHA-256.  The archive's SHA-512 and SHA-1 were
  checked against the official registry before extracting this file.
- `media-peer-demo.js`: the real RelaySwarm browser loader and its signing
  dependencies, bundled from a pinned public source revision.
  `media-peer-demo.build.json` records the source, lockfile, bundle hash and
  included versions.  `media-peer-demo.NOTICE.txt` contains their notices.
- `relayswarm-core.wasm`: the exact committed Rust/WASM core from that source
  revision.  The same build receipt records its hash, size and Rust dependency
  licences; `relayswarm-core.NOTICE.txt` retains their notices.  No Rust
  compilation is performed by the website bundler.

Both hls.js builds retain the published Apache-2.0 notices in `hls.js-LICENSE`,
with the licence text in `APACHE-2.0.txt`.  The retained notice matches the
1.7.3 package's `LICENSE` byte-for-byte.  The full build is unmodified, including
its upstream source-map reference; the source map is not vendored.

The peer bundle is reproduced with:

```sh
node scripts/build-media-peer-demo.mjs /path/to/relayswarm
```

The RelaySwarm checkout must contain the recorded revision and its matching,
installed lockfile dependencies.  The builder archives the pinned source into
temporary staging, checks dependency versions and removes its staging after
building.  It doesn't modify that checkout or add a browser credential.
Collecting WASM notices uses `cargo metadata --offline --locked` with the
pinned source and already installed registry sources.  It does not create a
Rust target directory or download dependencies.
