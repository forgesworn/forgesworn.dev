# Local live-media comparison

Play an operator-selected recording through a real native Sapflow or MediaMTX
origin and inspect the work each process does.  The launcher republishes the
original H.264 video and AAC audio at their source rate.  It does not transcode,
copy the recording into the website, or upload it anywhere.

This is a local operator tool.  It listens only on `127.0.0.1`.  The public
static website cannot start an origin or read a file from a visitor's machine.
Use media you have permission to play; permission for the supplied demo
recording has already been confirmed by its owner.

## Start it

Node 24, FFmpeg, FFprobe and native executables for the selected origins are
required.  Install `srt-live-transmit` if you want SRT ingest.  Both origins
should use the same machine and architecture.  Keep unrelated source branches
and their build output intact; the launcher accepts existing executables and
runs no Cargo command.

```sh
node scripts/media-lab-server.mjs \
  --input /path/to/licensed-recording.mp4 \
  --sapflow /path/to/sapflow \
  --mediamtx /path/to/mediamtx
```

Open the printed loopback URL.  To enable the optional local TURN choices,
supply both or either relay executable:

```sh
node scripts/media-lab-server.mjs \
  --input /path/to/licensed-recording.mp4 \
  --sapflow /path/to/sapflow \
  --mediamtx /path/to/mediamtx \
  --spry /path/to/spry-turn --coturn /path/to/turnserver \
  --port 0
```

The optional TURN path uses RelaySwarm and two logical viewers in the browser.
The launcher supplies short-lived per-viewer credentials and forces the
selected local relay.  These credentials are returned only by the guarded
local API; they are absent from the config, stats and completed observations.
This is not a public relay service or an internet NAT measurement.

Only one origin runs at a time.  Switching the selected origin stops the old
origin, publisher and optional relay groups before starting the replacement.
Stop the launcher with Ctrl-C when finished.  Temporary origin configuration
is private and removed after its children have stopped.  A failed child
cleanup prevents a replacement run; the launcher does not silently leave an
old origin running alongside a new one.

## Comparable profiles

The defaults are explicit:

| Choice | Origin HTTP implementation |
|---|---|
| Sapflow | Its public default Hyper path |
| Sapflow own HTTP | Optional own loop, one worker, same Sapflow executable |
| MediaMTX | Native MediaMTX HLS server |

Every run records the selected profile, version and executable SHA-256.
The own-loop preset is a separate treatment, not a hidden default.  It is
also distinct from the sixteen-worker M4 snapshot used by earlier marketing
figures.  Current-host observations do not inherit those results.

Every local treatment uses the same full hls.js 1.7.3 player build.  MediaMTX
can advertise separate audio and video playlists, which require the full
build's alternate-audio controllers.  The light build omits them; loading
only the video rendition cannot establish a fair audio/video comparison.
The exact published full ESM asset, archive integrity and source revision are
recorded in `site/vendor/hls.full.build.json`.  The public muxed-media demo
retains its separately recorded light build.

All origins receive both source tracks using packet-copy publishing.  The
shared delivery profile is Low-Latency HLS, 24 retained playlist entries,
approximately one-second segments and 200 ms parts, with recording off and
matching generated publisher credentials.  Actual segment and part durations
also depend on the source's keyframes and sample timing.  MediaMTX's unrelated
RTSP, WebRTC, MoQ, administration, metrics, profiling and playback servers are
disabled.  Both publishers and HTTP origins bind loopback.

The matched internal stream path is `live/event-lab-<run-id>`, which satisfies
the public Sapflow server's `live/event-*` admission rule.

The retained count uses Sapflow's public default of 24.  The examined public
Sapflow build accepts seven entries but cannot become ready at that setting:
it inserts seven leading gaps and requires more than seven entries for content
readiness, while its window eviction retains at most the configured count.
Both origins therefore receive 24, with the same requested segment and part
timing.  Sapflow's initial gap entries and MediaMTX's rendition layout remain
implementation differences; equal settings do not imply identical playlists
or identical bytes retained at every moment.

RTMP uses FFmpeg directly.  SRT uses FFmpeg's MPEG-TS output piped to the
installed `srt-live-transmit` executable with a 1,316-byte chunk and a requested
200 ms latency.  No libsrt or srt-rs source is used.  FFmpeg and the SRT sender
have their own process counters, separate from origin CPU and RSS.

H.264/AAC inputs are checked before the local page opens.  The config exposes
codec, resolution, frame rate, duration, bitrate, file size and SHA-256, but
omits the source path, filename and arbitrary media tags.  Hashing reads the
recording once before measurement; it does not buffer the full file in RAM.
Browser decoding support for the particular profile and resolution still
needs actual playback evidence.

## What the counters measure

- **Origin CPU:** change in that process's accumulated CPU time divided by the
  actual sampling interval.  One fully occupied core is 100%, not the whole
  computer.  `averageCpuPercent` covers the interval between the first and
  latest successful process sample.  Publisher and TURN CPU are separate.
- **Process memory:** sampled RSS and the highest sampled RSS for each child.
  It excludes kernel socket buffers, the browser, other processes and some
  shared-memory accounting.  It is not total system memory.
- **HTTP bytes and rate:** HLS response-body bytes read by the local proxy,
  with a rate over the actual most recent sampling interval.  This includes
  audio, video, initialisation and playlists.  It excludes headers and the
  config, stats, credential and hash-metadata APIs.  Cancellation can leave a
  small amount of proxy-read data that the browser did not consume.
- **HTTP request work:** `requests` counts incoming browser HLS requests.
  `originRequests` counts actual upstream requests, including bounded redirect
  hops; `redirectsFollowed` counts those extra hops.  Readiness probes are
  excluded from these delivery counters.  A final response's first-byte timing
  includes any preceding redirect work.
- **First-byte time:** proxy request start to the upstream response headers.
  **Response time:** request start to completion of the proxied response.
  These are not glass-to-glass delay or browser decoding time.  Percentiles
  retain at most the most recent 2,048 observations; total sample counts are
  recorded separately.
- **Browser results:** first decoded frame, decoded-frame progress, waiting
  time and peer metrics are measured by the player.  The backend does not
  manufacture viewer counts, decoding rates, avoided bytes or frame rates.
  Frame-callback media dimensions are recorded separately from the video's
  natural display dimensions.  The supplied recording has 3840 by 2160 media
  pixels and a 17415:17408 pixel ratio, so its preserved display width rounds
  to 3842.  That display adjustment does not change its encoded video.

When both origins keep up, they should deliver approximately the same encoded
programme bitrate.  A larger received-byte count alone does not mean a better
implementation.  Compare CPU, memory, startup, real playback interruptions
and request timing under the same input and player behaviour.

MediaMTX can advertise separate audio and video renditions.  Keep both enabled
and fetched by the browser.  The older simulated viewer benchmark omitted its
separate audio rendition, so its historical results are not a substitute for
this browser comparison.

The local comparator uses the full pinned hls.js build for every origin, so
both receive the same player and MediaMTX's separate audio track is actually
played.  The public muxed preview keeps the smaller light build.  Viewer
buffering targets four seconds with a six-second configured ceiling; the
peer holder targets eight with a ten-second ceiling.  MSE can overshoot by a
fragment, and decoded-frame memory is separate from both these settings and
the explicitly bounded peer cache.

## Timing and completed observations

A run starts the source from offset zero unless an operator explicitly asks
for another offset.  Packet-copy seeking follows available keyframes; compare
matching offsets.  An optional duration limits publisher media time.  Normal
EOF is followed by a matched twelve-second drain, subject to the overall
330-second run limit, so buffered playback has time to progress.  The source
and each origin can have their own EOF behaviour; a completed publisher window
is not proof that every frame of the recording was displayed.

`ended` means the source or configured run window finished.  `stopped` means
a manual Stop or a switch interrupted it.  `error` means a process or readiness
check failed, the publisher exited before its intended media window, or the
hard deadline expired before successful publisher completion.  Successful exit
and terminal `progress=end` are both required.  For a complete video from offset
zero with an independently probed frame total, the copied video count must
match exactly.  Its progress clock must also reach the mapped AAC endpoint,
clipped only by the requested duration, within the recorded 250 ms tolerance.
This handles FFmpeg progress ending at shorter audio while all video frames
were copied.  Longer audio retains its longer endpoint; this is not a minimum
of track durations.  Other windows retain the original requested-duration
clock check.  Wall time or exit code alone does not establish completion.

Stats retain `publisherVideoFrames`, `expectedVideoFrames`,
`expectedProgressSeconds` and `expectedProgressBasis`, alongside the final
reported `publisherMediaSeconds`, `publisherProgressEnded`,
`publisherCompletedWindow` and raw `publisherEnded` flag.  Copied frames are
FFmpeg output counts; they are separate from browser decoded-frame evidence.
An unexpected SRT sender failure also invalidates the run during the tail
drain, even when FFmpeg has already completed its intended media window.
Final counters retain the matching run ID.  A browser must also
prove actual decoded frames before saving a playback observation.  Do not
report an interrupted or failed treatment as a performance win.

For useful comparisons, use at least three paired repetitions at the same
source offset, codec, duration, transport and viewer configuration.  Alternate
which engine runs first.  Allow for warm-up and retain the individual results,
not only a median.  Keep other workloads unchanged and record the host; a
single shared-host result does not establish maximum capacity or a universal
advantage.  Native and VM-hosted references belong in separate comparisons.
Config and stats include one-, five- and fifteen-minute host load averages;
final snapshots preserve the start and finish values.  These are scheduler
load averages, not CPU percentages.  Heavy unrelated load makes comparative
timing unsuitable for clean performance claims even if playback works.

## Local API

Requests require the exact loopback Host and, when supplied, the same Origin
and a same-origin/none Fetch-Site.  No CORS permission is granted.  POST bodies
are JSON, capped at 4 KiB, and cannot supply files, executables, command-line
arguments, origin URLs or arbitrary configuration.

| Endpoint | Behaviour |
|---|---|
| `GET /lab/config` | Sanitised source and host metadata, engine identities, relay availability, profiles and bounds |
| `POST /lab/run` | Start one selected native origin; return its run ID and opaque playlist URL |
| `POST /lab/stop` | Stop the current run; an optional mismatching `runId` is ignored |
| `GET /lab/stats` | Current sampled counters and the last completed run snapshot |
| `GET /lab/runtime` | Active local TURN credentials only when a relay run exists |
| `GET /lab/hash?path=…` | SHA-256 and size of a previously completed active media response; no fetch on a cache miss |

A run request:

```json
{
  "engine": "sapflow",
  "transport": "rtmp",
  "offsetSeconds": 0,
  "durationSeconds": 30,
  "turnEngine": "off",
  "turnTransport": "udp"
}
```

Engine IDs are `sapflow`, `sapflow-own` and `mediamtx`.  Ingest is `rtmp` or
`srt`; the latter is offered only when its sender tool is available.  Relay
IDs are `off`, `spry` and `coturn`, with `udp` or `tcp` client transport.
A selected relay returns its private `runtime` in the run response.

The playlist URL is `/media/lab/hls/<run-id>/index.m3u8`; clients must use the
returned value.  The `/lab/hls/<run-id>/…` alias is also accepted.  Only the
active origin's HLS subtree can be proxied.  Relative audio/video rendition
paths, query strings and single byte ranges are preserved.  At most two native
redirect hops may remain on the exact configured loopback origin and active
HLS subtree.  This supports MediaMTX's `?cookieCheck=1` canonical request;
external origins, other paths, credentials in redirect URLs, loops beyond the
hop bound, traversal and responses over 64 MiB are rejected.  Browser cookies
are not forwarded.  A bounded private native cookie jar retains MediaMTX's
cookie-check marker and HLS session for that run, restricted to the configured
loopback origin and active stream, with cookie path and expiry matching.  It
holds at most 16 cookies and 8 KiB, and is discarded with the run.  Native
`Set-Cookie` headers and cookie values are absent from config, stats and
observations; they are never set in the browser.
Responses stream with backpressure and cancellation; media is not accumulated
in an application cache.

The hash endpoint remembers at most 512 digest/size records for completed
full media responses.  Partial ranges, HEAD responses, cancelled transfers
and incomplete data cannot create a commitment digest.  Older records are
evicted.  It never returns a filesystem path or buffers media for a hash lookup.

## Public playback and permission

The public player leads with the complete 4K recording.  Play & join starts
the mix with sound and joins the real visitor swarm.  Pausing stops sharing;
native play rejoins.  The standard video controls handle seeking, sound and
full screen.  Opening the stats preserves the same video element, source,
time and sound settings.  An optional lighter 1080p excerpt can be selected;
changing quality restarts the chosen source. No media or peer networking
starts before Play. A read-only room subscription keeps the live listener
ticker current before Play and after Pause; those observers do not count.
See [the showcase guide](media-showcase.md).

The 1080p excerpt is captured from actual Sapflow publishing.  The full 4K
playback artefact is static HLS made by FFmpeg packet copy: its original
H.264/AAC tracks are retained without re-encoding.  Its manifest explicitly
records `liveOrigin: false`.  Public playback measures that browser's frames,
buffer and delivery; native server CPU belongs to the local runner or a dated
recorded run.  The static playback artefact is not a live-origin benchmark.

Code is MIT.  The owner authorised the supplied recording for the public
demonstration; that permission does not relicense the music or video under
MIT.  Keep the media permission notice with the published files.  Local
source paths, credentials, provider URLs and arbitrary source metadata do
not belong in public receipts.

The packagers require an explicit provenance choice.  For an owner-licensed
recording, provide a small permission file:

```json
{
  "title": "Licensed demonstration recording",
  "permission": "owner-authorised-public-demo",
  "provider": "owner-licensed recording"
}
```

```sh
npm run demo:package -- --licensed --provenance permission.json \
  --input /path/to/licensed.mp4 --sapflow /path/to/sapflow \
  --source /path/to/exact-public-source --quality 1080p --seconds 30 \
  --out /path/to/new-preview-directory

npm run demo:broadcast -- --provenance permission.json \
  --input /path/to/licensed.mp4 --out /path/to/new-full-hls-directory
```

The preview normalises a bounded excerpt, then captures and independently
decodes actual RTMP and SRT Sapflow output.  The full packager strips source
metadata, writes bounded static HLS, hashes each file and independently probes
the packaged tracks and duration.  It never starts an origin.  Neither command
overwrites an existing data set.

The example [Caddy handler](../ops/media-demo.Caddyfile) serves only a dedicated
public directory with GET/HEAD, byte ranges and restricted browser CORS.
Stage a complete, checked, symlink-free versioned directory before installing
the handler.  Validate the complete candidate Caddy configuration, preserve
the previous configuration for rollback, then reload and read back the
public playlist, range, CORS and timing headers.  Do not expose the private
programme library or a local execution API.  A full 4K stream needs about
24 Mb/s of egress per viewer before any measured peer savings.

During a run, `stats.run` identifies it and includes `profile`, `publisherEnded`,
`durationSeconds`, `uptimeSeconds` and the remaining hard run budget.  After
cleanup, `stats.run` is null and `stats.lastRun` contains the final snapshot,
including `lastRun.run.id` and its `ended`/`stopped`/`error` state.  Save only
the final snapshot matching the browser's run.  Stale-tab Stops with a different
run ID cannot stop a replacement.  Aborting a run-start HTTP request cancels
its pending startup and closes its children.

Trusted Node callers may supply an `onDiagnostic` callback to
`startMediaLab(options)` for bounded child-log diagnostics on run cleanup.
Paths, filenames and generated credentials are redacted before that callback;
these logs are never served by the browser API.  Async callbacks are not awaited
during cleanup.

## Check the launcher

Check the homepage's startup controls with `npm run test:media:showcase:lifecycle`.
This uses the real page and controller with explicit room, HLS and media-state
fixtures. It checks same-tap playback ordering despite delayed room discovery,
that room updates preserve the loading label, a blocked audible play can retry
the prepared player, and cancellation or leaving the page releases it.
It does not establish decoded playback or peer delivery.

```sh
node --test test/media-lab-server.test.mjs
```

These focused tests use generated source metadata and disposable executable
fixtures to exercise guards, privacy, process ownership, cancellation,
backpressure, timed completion, profile selection, ranges and hash eviction.
They are not evidence of native media compatibility.  The separate real-browser
qualification must show decoded source video/audio, actual selected relay
candidates when requested, and clean shutdown.

Run the production-page qualification manually with Chromium available through
the installed Playwright dependency:

```sh
node test/media-lab-full-browser.mjs \
  --input /path/to/licensed-recording.mp4 \
  --sapflow /path/to/sapflow --mediamtx /path/to/mediamtx \
  --spry /path/to/spry-turn --coturn /path/to/turnserver \
  --engine sapflow --transport rtmp --relays spry,coturn \
  --turn-transport udp --duration full \
  --output .local/evidence/media-lab-browser.json
```

The runner uses the actual page, Run button, native origins and selected relay.
It checks decoded audio/video, selected relay candidates, fullscreen, completed
source-window observations and the page's downloadable result.  It closes its
browser and child processes on success or failure.  `--duration` also accepts
`30` or `60`, and `--relays` can select either relay independently.  Keep host
load with the results and distinguish a functional playback pass from a clean
paired performance experiment.  This browser check is separate from `npm test`.
