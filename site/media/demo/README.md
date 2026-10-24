# Original demonstration media

The concert is generated, including its performers, audience and audio.
No camera recording, private room, operator account or real event is used.

- `poster.webp` is original Sunburst artwork.  `artwork.json` records the
  requested model, prompt, source checksum and image conversion.
- `source.mp4` is the generated Higgsfield film normalised to H.264/AAC,
  with metadata stripped, repeated to make a short streaming demonstration.
  `video-prompt.txt` contains the actual generation prompt.
- `manifest.json` records the input and prepared source checksums, exact
  public Sapflow revision, executable hash and runtime-source checksums.
- `rtmp/` and `srt/` contain media independently captured from real Sapflow
  ingest, then decoded with FFmpeg.  Each `segments.json` fixes the fragment
  hashes and sizes used by the actual RelaySwarm integrity checks.

The live snapshots are retained as text for inspection.  The playable
`stream.m3u8` files are finite replays of complete segments, with their
original media bytes and durations.  Initial live-window GAP placeholders
are omitted.  The page runs no public encoder, ingest or TURN service.

The original generated film and artwork follow this repository's MIT
licence.  Browser dependencies retain the notices under `/vendor/`.
Generation credentials, account details and provider download URLs are
never embedded in the page or these files.

See [the preparation and local relay guide](https://github.com/forgesworn/forgesworn.dev/blob/main/docs/media-demo.md).
