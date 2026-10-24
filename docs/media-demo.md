# Run the media demonstration locally

The public page replays generated HLS packaged by Sapflow. It does not run a
public ingest service, TURN server or credential issuer. Its two logical
viewers use the real RelaySwarm browser loader; the HLS origin remains the
fallback. Local mode adds an actual Spry TURN process and forces relay ICE
for the two viewers.

Use a current Node installation, a built Sapflow executable/source checkout
and a Spry TURN 0.2.1 executable. These tools are supplied separately; the
helper does not download, build or install them. Use generated media without
personal recordings or production credentials.

The published page includes prepared media, so start the local page and relay
with those files:

```sh
node scripts/serve-media-demo.mjs --spry /path/to/spry-turn --transport udp
```

To prepare a new original generated clip, capture into a fresh directory first:

```sh
node scripts/package-media-demo.mjs \
  --input generated.mp4 \
  --sapflow /path/to/sapflow/target/release/sapflow \
  --source /path/to/sapflow \
  --generated \
  --out .local/media-demo-capture
cp -R .local/media-demo-capture/. site/media/demo/
```

This preparation also requires FFmpeg, ffprobe and `srt-live-transmit` on PATH.
The helper normalises generated video to H.264/AAC, publishes it to separate
real Sapflow RTMP and own-SRT listeners, captures complete HLS segments and
independently decodes both results with FFmpeg.  It writes a finite VOD playlist
around those captured bytes, discarding only live-window GAP placeholders.
It records the exact source, executable and media hashes in `manifest.json`.
It refuses to replace an existing capture directory, terminates its process
groups and removes temporary working files on exit.
The browser serves the resulting files as replay; that is separate from
running a continuously publishing SRT/RTMP origin.

Open the printed `http://127.0.0.1:PORT/live-media.html?relay=local` URL. The
HTTP server and Spry's UDP/TCP listeners bind only to `127.0.0.1`. Ports are
chosen locally; `--port NUMBER` optionally sets the HTTP port. Stop with
Ctrl-C. To exercise the TCP client-to-relay path, stop the helper and rerun
with `--transport tcp`. The helper does not provide a TLS mode.

The page only requests `/media/demo/runtime.json` when both `relay=local`
and hostname `127.0.0.1` are present. That local endpoint supplies two
separate, opaque, ten-minute TURN REST principals and `iceTransportPolicy:
"relay"`. The shared random signing secret stays in the helper's memory and
Spry's environment. The terminal prints the page URL, never credentials or
child output. Credentials are available to the local browser because it
needs them to authenticate; do not save or publish the runtime response.
Reloading obtains fresh principals. This is a short demonstration, not a
credential-renewal or long-lived-session qualification.

Host, Origin (when present) and Fetch Metadata checks restrict requests to
the exact local HTTP origin. Responses disable caching and do not enable
cross-origin credential access. The file server serves only the checkout's
`site/` directory, blocks hidden paths, `node_modules`, traversal and symlinks
outside that directory, and has no directory listing. It accepts GET/HEAD,
supports single byte ranges and refuses files above 64 MiB. The runtime
endpoint is deliberately generated in memory, not written into public files.

Spry is started with its explicit loopback-peer testing switch. Its shared
UDP/TCP port is reserved in both protocols before launch, with bounded
startup retries. Normal shutdown, startup cancellation and failed startup
terminate its process group, escalating from TERM to KILL after a short
grace period. Do not expose this helper through a reverse proxy, port
forward or public bind. Other software running as the same local user is
outside this helper's isolation boundary.

The local path demonstrates actual browser peer transfer through the
selected relay, with origin fallback still available. Inspect the page's
selected transport and peer/origin delivery counters; successful playback
alone is not proof that peers supplied every media part. No physical phone,
cross-network/NAT behaviour, public certificate trust, native SDK bindings
or production capacity is qualified by this demonstration.

The browser path uses two logical viewers in one page.  A bounded in-page
Nostr wire adapter carries RelaySwarm's actual signed presence and encrypted
SDP.  Native WebRTC data channels carry media.  The browser generates a temporary
demo publisher key, signs commitments to the recorded media hashes and discards
that key when the session stops.  This exercises the real loader and integrity
checks; it does not authenticate a production publisher.  Public playback uses
host ICE candidates only, without a public STUN or TURN service.  If those peers
cannot connect, the normal HLS origin still supplies the video.

The holder is bounded to 64 segments, 4 MiB per segment and 32 MiB total.
The session closes after 90 seconds or at the end of the video.  Stop, Replay
and page navigation also close its players, peer connections and signalling.
Peer bytes, verified fragments and candidate types come from actual library
and browser observations.  Origin delivery is never counted as verified peer
delivery.

| Library | What the demonstration exercises |
|---------|---------------------------------|
| sapflow-core | Publisher and stream validation in the captured ingest pipeline |
| sapflow-rtmp | Real RTMP ingest into Sapflow |
| sapflow-srt | Sapflow's own SRT listener receiving generated MPEG-TS |
| sapflow-hls | Actual H.264/AAC packaging, playlists and captured fMP4 segments |
| Sapflow server | Loopback sockets and HTTP output during preparation |
| RelaySwarm | Browser rendezvous, WebRTC transfer, signed commitments, hash verification and origin fallback |
| Spry TURN | Forced native relay ICE in local mode, with separate viewer principals |
| sapflow-client / sapflow-ffi | Separate generated Swift/Kotlin consumer checks, rather than browser execution |

The native binding checks can be run from the Sapflow checkout:

```sh
CARGO_BUILD_JOBS=2 node scripts/build-native.mjs check
```

They exercise actual generated bindings and native consumers with synthetic
compressed samples and socket-free protocol state.  The
[dated native receipt](evidence/media-native-bindings-2026-10-24.json) records
the checked source and result.  They do not establish camera capture, an app
publishing decoded media, or a physical phone call.

Run the unit and HTTP/process checks with:

```sh
npm test
npm run test:media:lifecycle
```

The server tests use a disposable executable fixture to exercise process,
credential and HTTP boundaries.  The lifecycle browser test explicitly mocks
media/peer adapters to check competing Play, Replay, Stop and navigation.
Real decoded-media and Spry/browser acceptance are separate runs.

```sh
npm run test:media:peer -- --spry /path/to/spry-turn --transport udp --clip rtmp --output .local/media-peer.json
npm run test:media:ui -- --spry /path/to/spry-turn --transport tcp --clip srt --output .local/media-ui.json
```

The peer runner verifies decoded frames, real peer bytes, both selected relay
candidates, then disconnects the holder and requires completed HTTP fallback
with further decoded playback.  It finally requires zero open peer and
signalling connections and zero held media.  The UI runner clicks the actual
landing-page controls and independently reads native candidate statistics.
Neither runner changes the computer's network settings or grants camera or
microphone permissions.

The [dated browser receipt](evidence/media-browser-2026-10-24.json) records the
generated concert film passing both RTMP/UDP and SRT/TCP compositions, recovery
after peer disconnection, actual page controls and resource cleanup.  Public
host-only mode played through HTTP on the qualification Mac, whose two browsers
could not connect host-only ICE peers even in an independent native WebRTC
pair.  That result qualifies origin playback, not internet peer reachability.
