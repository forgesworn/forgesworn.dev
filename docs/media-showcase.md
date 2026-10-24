# The 4K listening room

The homepage, `live-media.html` and public `media-lab.html` lead with the
complete licensed Deja Vu Ambient Sunrise Mix.  One **Play & join** action
starts the music and enables RelaySwarm.  Standard video controls handle
pause, seeking, volume and full screen.  Opening playback details keeps the
same video running.

The homepage build reuses the marked public main element from
`site/live-media.html`, so its player, source and participation behaviour do
not diverge.  `site/index.html` remains generated output.  The native
loopback comparator at `media-lab.html` retains its separate process controls
and opens its diagnostic sections automatically.

## Real participation

Each visitor has one visible video and one hls.js player.  There is no hidden
holder, second player, prefetching copy of the film or fabricated viewer.
Before Play, no media is requested and no signalling socket or peer opens.
Play enables public Nostr rendezvous and native WebRTC data channels;
RelaySwarm can serve already held fragments to other visitors.  Pause
and page departure close sharing connections and release the
media cache.  Native play rejoins; its upload allowance and original lifetime
are retained across pause/resume.

The first viewer normally receives media from the HTTPS host.  Origin
delivery remains available when there is no useful peer, a relay is
unavailable, a network prevents a direct connection or a peer deadline is
missed.  A successful connection does not establish that media travelled
through it.  The received-video counter rises only after peer media passes
integrity verification.

The small rolling cache means viewers need overlapping media positions to
help one another.  **Invite someone to the room** copies a public link with
the recording's quality.  The recipient's Play discovers the active shared
clock and joins its current position, including when they arrive from the
homepage without an invitation.

## Shared listening session

The first Play in an empty room creates its clock.  Later listeners join
that clock; the person who started it can leave without ending it for the
others.  The recording loops while the room remains occupied.  Pause leaves
the room and stops peer sharing; Play discovers the current room again and
returns to its live position.  Native seeking can move away from live, with
**Back to live** to return.  Following playback tolerates buffering and only
corrects drift over six seconds.  Full screen and playback details retain
the same video and session.

There is no always-running encoder or new coordination service.  Existing
Nostr relays carry a small signed clock/presence event every six seconds,
bound to the exact room, immutable source digest and recording duration.
The 4K mix and the shorter 1080p excerpt have separate rooms.  Networking
begins after Play, and initial discovery is bounded; a relay must accept the
listener's publication before the page calls it shared.  If coordination is
unavailable, playback falls back to the media host and says it is playing
on its own.

Presence expires after approximately 24 seconds.  Explicit departures keep
that short epoch grace so refreshes can rejoin; after every listener's lease
has expired, the next Play starts a fresh recording at the beginning.  Abrupt
tab closes and lost connections need no permanently running cleanup process.
An expiry tag does not guarantee that a relay deletes its stored event.

The experimental public addressable event uses kind `30378` and the
[NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) replacement
rules, with client-enforced expiry.  It uses a fresh temporary signing key
per join, at most three relay sockets, bounded messages and 256 presence
records.  Media delivery retains its own existing sockets and resource
limits.  Concurrent starters converge on the oldest valid observed epoch.
Relay partitions, device clock differences and anonymous participants mean
this is a shared browser clock with observed presence, not authoritative
global audience counting or frame-accurate synchronisation.  The graph
continues to show this browser's actual media connections.

## What the picture shows

The graph shows the media host, this browser and its actual native peer
connections accepted by RelaySwarm, obtained from `peerConnections()`.
Pending dials and losing negotiations do not become listener nodes.
Labels are numbered 1 through the current visible count: ten becoming five
shows Listener 1 to Listener 5.  Stable internal connection IDs retain the
correct traffic history while those display labels change.  It contains no
global viewer total, guessed peer-to-peer links or network-address display.

Moving points represent media contributions.  Origin movement follows its
share of media accepted for playback.  Peer upload movement counts binary media
successfully submitted to that connection's native data channel.  Download
movement uses RelaySwarm's `onPeerDelivery` callback, after size/hash
verification and acceptance within the playback deadline.  That callback
supplies the actual connection; the page does not infer which peer supplied a
segment from aggregate counters or transport completion.

Connection messages, unverified chunks and failed downloads do not animate a
peer download arrow.  A connection can be present with zero media delivered.
The graph labels say **to them** and **to you**, from this browser's point of
view.  RTC connection bytes remain separate diagnostic observations and do
not feed video labels or movement.  With reduced motion enabled the graph
remains still.  Resizing changes layout without replaying old traffic.

The counters distinguish:

- **From media host:** the origin's share of media accepted for playback.
  Completed HTTP response bodies are observed separately before worker buffer
  transfer, including ranges that did not win a piece;
  `originTransferredBytes` excludes partial bodies aborted before completion.
  Browser acceptance receipts use CDP to include those partial bodies in their
  HTTP measurement.  Playlist and Resource Timing sizes are not mixed into
  the useful-media counter.
- **Verified from viewers:** peer pieces that won verification and contributed
  to a complete segment accepted for playback.  Partial failed objects and
  duplicate losing copies do not increment this counter.
- **Media sent by you:** binary media bytes successfully submitted to the
  native data channel.  These are not a claim that the recipient decoded
  them.  The library's larger response-reservation counter is retained
  separately as `acceptedUploadBytes` in diagnostic observations.
- **Connected viewers:** the library's currently connected peers, distinct
  from connections that are still negotiating.

Units switch between B, KB, MB and GB so a small transfer is not rounded to
`0.0 MB`.  The exact byte count is retained on each counter.  The viewer
contribution percentage divides verified peer bytes by completed peer plus
origin media bytes.  Totals include buffered video and remain cumulative
across pause/resume; graph connection labels cover each current connection.
The source label identifies the **latest segment received**, rather than
claiming that a buffered segment is playing at this instant.  Native HLS,
which cannot use this adapter, retains browser HTTP observations separately.

These are browser observations, not a claim of net bandwidth or financial
savings.  Signalling, commitments, duplicate attempts and protocol overhead
also use bandwidth.  Published origin CPU/RSS results are dated native
measurements, separate from this public replay.

## 4K delivery observations

The [24 October accounting and delivery receipt](evidence/media-transfer-stats-20261024.json)
records the zero-video/moving-arrow regression, the corrected two-browser
preview transfer and sustained original-4K acceptance.  The candidate pinned
to RelaySwarm `1cc8ff6` before the subsequent main-branch integration
delivered 11,798,811 verified peer bytes over 45.7 seconds: 14.4% of the
receiver's accepted video.  Its actual HTTP media response bodies, including
cancelled partial downloads, totalled 71,493,897 bytes against 81,756,904
accepted video bytes.  Both players decoded the original 2160p recording.
Pausing removed the remote node and resuming restored the dense current
listener labels.  The source commit and bundle hashes are pinned in the
receipt; immutable v0.3.0 release assets do not contain these later fixes.
The shipped bundle also incorporates the newer main branch's selection and
discovery core.  Its exact source and matching WASM are recorded in
`site/vendor/media-peer-demo.build.json`; the earlier contribution measurement
does not automatically qualify that newer runtime.

Earlier 40-second windows on a heavily loaded shared Mac delivered zero complete verified peer
segments.  Increasing the peer wait from 1.2 to 2.5 seconds and its ceiling
from 2.5 to 5 seconds still completed no peer segment, despite 5.57 MB sent.
The receiver stalled and played less video.  Its lower HTTP total does not
establish a saving, and those timings were not adopted.  The receipt keeps
the failed attempts and host load alongside the subsequent fixes.  These
earlier observations use the previous browser bundle.  The measured candidate
still recorded six stalls per player (14.48 and 8.89 seconds); the result
proves useful peer delivery, not smooth playback, a controlled speed win,
cross-NAT performance or production capacity.

The public profile now uses schema-3 piece commitments and the Rust/WASM
multi-holder scheduler.  Viewers can supply small verified ranges of an
unchanged 4K fragment, with HTTP filling the remaining pieces.  A complete
segment still passes all verification before reaching the player.  Each
source is credited only for the first verified copy that contributes to that
accepted segment.  Performance receipts must include playback progress and
stalls alongside useful peer bytes; an open connection alone proves no
contribution.

The demo also opts into `zeroBudgetPeerRace`.  When there is no safe time to
wait before starting HTTP, the normal request starts immediately.  Only a
peer that already advertised the exact cached object may race it through the
verified piece engine.  The first complete accepted source wins; the losing
arm is cancelled.  This creates no additional origin request and does not
prefetch media outside the visible player's demand.  Progressive HTTP payload
locks that load to HTTP, so sources cannot mix after an append.  Pausing or
turning off the swarm stops its peer arm while preserving normal HTTP
playback.

## Integrity and scope

The complete recording is immutable, static HLS made by FFmpeg packet copy
with no re-encoding.  Its original coded geometry is 3840 × 2160; its retained
sample aspect ratio produces a natural HTML display width of 3842.  The
optional 1080p excerpt was captured from actual Sapflow publishing.
The public film is not a continuously running Sapflow origin.

`site/media/dejavu-swarm/catalogue-v2.json` records the exact sequence, size,
whole-object SHA-256 and canonical piece hashes of every approved fragment.
The adapter pins that
catalogue's SHA-256 in source and independently checks its identity, origin,
path, sequence and size.  Its trust anchor is the reviewed website over
HTTPS.  Each browser generates a temporary local signing key to wrap those
exact trusted digests in the existing RelaySwarm commitment format.  Peer
claims cannot choose the expected hash.  This is receiver-local attestation,
not an independent broadcaster signing a live feed.  No publisher secret is
embedded in the website, and the library verifier is unmodified.

The shared swarm identity is fixed for each immutable quality.  Regenerate
the catalogue and bump its version and swarm IDs if media is repackaged.
`scripts/package-public-swarm-pieces.mjs` verifies every full-media body against
the original pinned hashes before deriving pieces, and checks every local
preview piece.  `/media/dejavu-4k/index.m3u8` is a small, reviewed playlist alias
whose fragment URLs still point to the same remote media.  It gives schema 3
an exact `/media/` identity without moving or altering the recording.  The
source recording and signing keys do not enter the repository.

Rendezvous uses the explicitly listed public Nostr relays and encrypted peer
signals.  The public STUN setting supplies direct candidate discovery;
the page contains no TURN credentials or credential issuer.  Operators can
exercise Spry and coturn through the separate native comparator.  Direct
connection fallback here is not difficult-NAT, physical-phone or production
capacity qualification.  RelaySwarm remains experimental.

## Bounds and privacy

The public profile allows three peers, two concurrent upload peers, at most
4 MiB/s upload, 1 GiB of charged upload per playback session and an absolute
15-minute sharing lifetime.  The media cache is bounded to 12 objects and
64 MiB; one fragment may be at most 16 MiB.  The player targets a ten-second
buffer with a fourteen-second configured ceiling and a 32 MiB media budget.
An appended fragment can overshoot a buffer target; decoder memory is
separate.  There is no background download of the full 817 MB recording.
The pinned 689 KiB piece catalogue is bounded to 1 MiB, and the browser uses
the existing 399 KiB Rust/WASM module.  Both load only after Play.  The bundle
receipt records the exact source, WASM digest and dependency notices; the
website build copies that public module without compiling Rust.

Public relays see connecting addresses and metadata.  Connected peers can
learn one another's network addresses.  The page explains participation
beside Play and provides details beneath the graph.  It uses temporary
identities without sign-in or a social-account key.  The library's cellular
upload protection remains enabled; a constrained browser can retain origin
playback even when it cannot contribute.  Permission for the recording
covers this public demonstration; its music/video rights are separate from
the MIT code.

## Reproduce the checks

```sh
npm run sync
npm run build
npm test
node test/media-showcase-browser.mjs --site site \
  --url https://forgesworn.dev/ --output .local/showcase.json
node test/media-public-swarm-browser.mjs --public-relays --quality full \
  --output .local/visitor-swarm.json
node test/media-showcase-visitors.mjs --site site --quality preview \
  --output .local/visible-visitors.json
node test/media-showcase-visitors.mjs --site site --quality full \
  --observe-seconds 45 --min-peer-bytes 10000000 --min-peer-share 0.1 \
  --output .local/4k-peer-contribution.json
node test/media-swarm-visual-browser.mjs .local/graph-observation-regression.json
```

The first browser command serves candidate site assets at the approved
public origin for the media host's actual CORS policy.  Remote film requests
remain real.  Omit `--site` to test deployed bytes.  It checks original 4K
frames, nonzero decoded audio, one Play action, native pause/resume/seek and
full-screen controls, sharing shutdown, unchanged playback through stats,
and mobile layout.  The second opens separate browser contexts, exchanges
verified video through real public rendezvous and requires cleanup.  Its
same-machine peer path does not establish cross-NAT performance.  Receipts
record the precise boundary and retain relay failures.

The [dated functional receipt](evidence/media-showcase-4k-visitors-20261024.json)
retains the two-browser 4K transfer and actual homepage graph observations,
including failed public-relay attempts and the same-machine boundary.
