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
Before Play, a read-only subscription to the room's existing Nostr relays
keeps the listener ticker current. It requests no media, creates no peer or
signing identity, and does not count the page visitor as a listener.
Play enables public peer rendezvous and native WebRTC data channels;
RelaySwarm can serve already held fragments to other visitors.  Pause
and page departure close sharing connections and release the
media cache. Native play rejoins; cumulative video counters are retained
across pause/resume. Peer networking has no wall-clock or cumulative-upload
cutoff while listening. The read-only ticker remains connected
after Pause. Closing the page closes its room subscriptions too.

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
**Back to live** to return. Following playback checks the circular clock
offset through the existing browser observation timer. Automatic correction
allows 750 ms of decoder offset plus the last observed seek interruption
(`seeking` to `seeked`), needs five seconds of stable playback and
an offset in the same direction for at least three seconds, and requires
both positions in one continuous buffer with two seconds of headroom.
Corrections are spaced at least 15 seconds apart. Waiting, seeking or
pausing restarts the recovery period. Joining, **Back to live** and recording
loops can align immediately; returning from full screen uses the recovery
checks. For example, a 500 ms seek makes the ordinary allowance 1.25 seconds;
removing 770 ms of offset must not itself cause another half-second interruption.
Emptying the video clears the old engine's measured cost. The music's tempo stays unchanged. This avoids repeated clock seeks
interrupting a slower decoder while it is trying to recover. Buffering and
differences
in device clocks or audio output can still create temporary offsets; this is
not a multi-speaker audio synchronisation protocol. Full screen and playback
details retain the same video and session. A natural recording boundary
retains room membership, native peer connections, identity and cached media.

HLS loads at the discovered room position, then primes the existing paused
player until the fresh room position has three seconds of continuous media
ahead. It aligns once before playing, rather than correcting startup delay
with an audible seek after the music begins. On a recording loop the same
HLS instance loads from zero before choosing the new room position; room and
peer identities remain intact. Near the end it prepares zero and waits for
the room to wrap. After twelve seconds a safely buffered current position
can start away from live; if a managed source needs playback demand, a
one-shot bootstrap prevents an indefinite paused wait. Later clock corrections
use the recovery checks above. Loop priming time remains in the measured wait
count and duration. Recorded public playback targets 20 seconds of forward buffer,
caps its time target at 24 seconds and retains four seconds behind the
playhead. Its hls.js byte target is 64 MiB, which is not a hard process-memory
limit. The local live-server comparison keeps its original smaller buffers.

Public iPhone and iPad playback uses the same peer-capable hls.js integration
as other MediaSource-capable browsers. Browser identity no longer bypasses
RelaySwarm. The public integration enables `sustainablePeerWait`: a positive
peer wait must fit the fragment's media duration after allowing measured HTTP
recovery time. Its extension has the same cap; repeated peer misses cannot
continually spend more time than each segment replenishes. Cached peer races
still start HTTP immediately and keep their separate deadline.

On public browsers with native HLS available, playback can recover from a failing
hls.js path without replacing the visible video or listener session. Eight
seconds without healthy progress, three rebuffer episodes of at least one
second within thirty seconds, or a fatal playback error after the first frame
switches the same approved stream to the native player. Pause, seeking,
background time and recording wraps reset the stall observations. The switch
releases the HLS instance and all peer resources, preserves volume and the
playhead, and keeps the shared listener handle. It happens once per playback.

Native HLS cannot use the RelaySwarm fragment loader. Its active peer topology
is empty; earlier verified peer downloads and uploads remain visible as
historical totals. Native origin-transfer totals are shown as unavailable.
This recovery is an alternative delivery path, not evidence that the original
ManagedMediaSource issue or physical iPhone playback has passed acceptance.

For public browsers without native HLS, a separate decoder recovery handles a
playhead frozen inside a continuous buffer after media arrives. After 1.5 seconds without movement and 750 ms
with at least a second of buffered video ahead, it can advance 100, 200 then
300 ms inside that same range, at least three seconds apart. Three failed
attempts exhaust the recovery budget. It replenishes only after sustained
advancing playback and presented frames where frame callbacks are available,
not the seek's own change of time.
Pause, seeking, end and media errors block it. The existing observation timer
drives this check; playback details show the recovery count. This addresses
a case outside hls.js 1.7.3's buffer-hole nudge conditions.

There is no always-running encoder or new coordination service.  Existing
Nostr relays carry a small signed clock/presence event every six seconds,
bound to the exact room, immutable source digest and recording duration.
The 4K mix and the shorter 1080p excerpt have separate rooms.  Networking
for media peers begins after Play, and initial discovery is bounded; a relay
must accept the listener's publication before the page calls it shared. The
read-only ticker subscribes on page entry. If coordination is
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
global audience counting or frame-accurate synchronisation.

Play and Pause publish membership changes directly; other connected pages
update on those events rather than waiting for a heartbeat. The ticker
includes this browser only while joined. Browsing and paused observers do not
count. An initial matching relay end-of-stored-events reply is required before
showing an observed count. With no established room observation, it displays
a dash and a connection status. Abrupt browser loss is detected by lease
expiry rather than instantaneously; anonymous relays cannot provide an exact
global count during partitions. A confirmed empty observed room gets a quiet
animated invitation to start it, respecting reduced motion.

Optional signed ephemeral kind `20378` reports travel on the same room
sockets, at most every six seconds, and expire locally after 12 seconds.
They contain only the room/source/epoch, temporary signalling keys, media
position, follow-live state and bounded media byte counters for at most three
links. They contain no IP address, SDP, URL, account identity or device label.
Reports are accepted only for a currently present participant and the current
epoch. A signature authenticates a report's author; its remote measurements
and its claimed association to a media signalling key remain self-reported.
These values never affect verification, scheduling or local byte totals.

## What the picture shows

The graph shows the media host, this browser and fresh room participants.
Short node names keep the picture clear. Transfer rates, connection details,
totals and the peer contribution meter sit below it. The layout gives larger
rooms more vertical space instead of shrinking labels on a phone.
Labels use the same sorted temporary room identities in every browser;
internal native connection IDs retain their own traffic history. Hollow
participants have no locally measured connection. Pending dials and losing
negotiations do not become extra people. The exact native connection and
remote signalling key come from `peerConnectionDetails()`; independent array
orders are never used to guess an identity. Ambiguous identity claims do not
produce a guessed association. No network address is displayed.

Solid links show this browser's own media observations. Dashed links between
other listeners, and from the source host to them, require fresh signed
listener reports and are labelled as reports. A connection without traffic
can remain visible with zero delivery. Missing or expired reports do not
produce remote transfer animation.

Moving points represent media contributions.  Origin movement follows its
share of media accepted for playback.  Peer upload movement counts binary media
successfully submitted to that connection's native data channel.  Download
movement uses RelaySwarm's `onPeerDelivery` callback, after size/hash
verification and acceptance within the playback deadline.  That callback
supplies the actual connection; the page does not infer which peer supplied a
segment from aggregate counters or transport completion.

Connection messages, unverified chunks and failed downloads do not animate a
peer download arrow.  A connection can be present with zero media delivered.
Directional rates use changes in measured media byte counters and sample
times. Link widths and moving batch areas show relative measured traffic;
the dots are media batches, not individual network packets. Unchanged
counters do not create traffic. RTC connection bytes remain separate
diagnostic observations and do not feed video labels or movement. With
reduced motion enabled the graph remains still. Resizing changes layout
without replaying old traffic.

**Your peer delivery** measures the fraction of this browser's recently
loaded video supplied by verified peers over a rolling ten-second window.
With no recent accepted video it says it is waiting for traffic. It is a
contribution measure, not a claim about Wi-Fi signal, spare capacity or the
health of every connection in the room.

### Following the music

The broad rings around **Broadcast** follow bass attacks and energy in the
licensed soundtrack, sampled against the video's actual playback position.
They are decorative musical motion. The smaller points on connections still
represent measured video contributions.

The 16 KB rhythm file contains 40 ms energy samples and detected bass onsets
from the original recording and the exact public preview. FFmpeg decodes the
audio once during packaging. The browser reads this small score at up to
30 visual updates per second while the graph is in view. The native media
element continues to own sound, seeking and full screen. No microphone or
audio context is needed.

The pulse stops during pause, buffering or seeking, when the graph is off
screen, when the page is hidden, and for reduced motion. It returns at the
current media position after playback or visibility resumes. A missing score
leaves the musical rings still and does not change playback or peer delivery.

Regenerate the score with the licensed original and the committed preview:

```sh
node scripts/package-media-rhythm.mjs \
  --input /path/to/licensed.mp4 \
  --preview site/media/dejavu-preview/rtmp/index.m3u8 \
  --out site/media/dejavu-rhythm.json
```

The counters distinguish:

- **Loaded from source:** media accepted through the source loader, including
  responses supplied by the browser cache. Replaying a cached recording can
  increase this logical total without downloading the film again. Completed
  HTTP response bodies are observed separately before worker buffer transfer,
  including ranges that did not win a piece;
  `originTransferredBytes` excludes partial bodies aborted before completion.
  Browser acceptance receipts use CDP to include those partial bodies in their
  HTTP measurement.  Playlist and Resource Timing sizes are not mixed into
  the useful-media counter.
- **Source response bodies · network / browser cache:** separate readings in
  Playback details, based on Resource Timing for the approved init and numbered
  segment URLs only. Playlists, scripts, posters and the digest catalogue are
  excluded. An exposed cache hit or validated response counts its encoded body
  as cached; a normalised revalidation header allowance is not a new network
  body. Network body readings exclude headers, transport overhead and request
  timing gaps; in-flight and aborted requests are not fully accounted for.
  These are browser-reported response-body counts, not total wire traffic or
  proof that the player accepted every body.
  A concealed `0 / 0` size remains unknown. If any included timing cannot be
  classified, the cumulative network/cache readings are unavailable rather than
  a misleading known subset. Coverage also stays incomplete while timing body
  totals trail completed source-loader bodies, or dropped observer records are
  reported. The coverage row gives classified and observed response counts.
  Native HLS cannot guarantee this timing coverage and leaves the readings
  unavailable. The graph receives `sourceNetworkBytes` only with complete
  observed classification coverage; logical `originBytes` keeps its original
  loaded-video meaning.
- **Verified from viewers:** peer pieces that won verification and contributed
  to a complete segment accepted for playback.  Partial failed objects and
  duplicate losing copies do not increment this counter.
- **Media sent by you:** binary media bytes successfully submitted to the
  native data channel.  These are not a claim that the recipient decoded
  them.  The library's larger response-reservation counter is retained
  separately as `acceptedUploadBytes` in diagnostic observations.
- **Listeners here:** fresh observed active room membership, including this
  listener. The smaller **connected to you** reading separately shows this
  browser's accepted active peers. Three listeners can mean two local peers.

Units switch between B, KB, MB and GB so a small transfer is not rounded to
`0.0 MB`.  The exact byte count is retained on each counter.  The viewer
contribution percentage divides verified peer bytes by completed peer plus
logical source media bytes, including cache hits. It is a loaded-video share,
not a network bandwidth saving. Totals include buffered video and remain cumulative
across pause/resume; graph connection labels cover each current connection.
The source label identifies the **latest segment received**, rather than
claiming that a buffered segment is playing at this instant.  Native HLS,
which cannot use this adapter, retains browser HTTP observations separately.
The schema1 comparison export remains compatible: `browser.responseBytes`
retains its existing response-body semantics, which can include cached loads;
the new network/cache and coverage readings are separate live diagnostics.

These are browser observations, not a claim of net bandwidth or financial
savings.  Signalling, commitments, duplicate attempts and protocol overhead
also use bandwidth.  Published origin CPU/RSS results are dated native
measurements, separate from this public replay.

## 4K delivery observations

The [playback recovery receipt](evidence/iphone-playback-recovery-20261024.json)
records nine focused recovery cases and a three-browser preview check using
the current correction policy. All three retained their membership and peer
connections over a recording loop, with a maximum media-clock spread of
0.636 seconds. The cached macOS WebKit runner could not create a page, so
physical iPhone playback remains an acceptance check.

The [shared listener and topology receipt](evidence/shared-listener-topology-20261024.json)
records three actual browser contexts decoding the public preview over native
WebRTC and a local signed Nostr relay. All three retained their exact peer
connections and shared epoch across a recording loop. The largest circular
media-clock spread was 0.208 seconds, with a 0.161-second 95th percentile.
Those timing observations predate the more tolerant playback recovery policy
above and do not qualify physical iPhone playback.
Membership changes reached the other local pages 17–29 ms after an accepted
join and 100 ms after Pause. Remote graph edges were checked against each
other browser's actual connection identities. A separate isolated room
confirmed read-only observation and join/leave against the real public relays.
These are same-Mac preview and protocol checks, not a new 4K throughput
benchmark, physical-device clock qualification or public-NAT capacity claim.

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
signals. STUN supplies direct candidate discovery. When playback starts, the
browser also obtains an expiring Spry TLS credential from the independently
operated Archy node. Direct connections remain eligible; a relay supplies a
route when the browser cannot use direct UDP. The static site contains no
relay password or operator root secret. The separate native comparator can
exercise Spry and coturn. RelaySwarm remains experimental; public credential
delivery alone does not qualify sustained 4K playback or physical phones.

## Bounds and privacy

The public profile allows three peers, two concurrent upload peers and at
most 4 MiB/s upload. Contribution continues throughout active playback,
with no cumulative byte quota. Pause and page departure close peer networking.
The media cache is bounded to 12 objects and 64 MiB; one fragment may be at
most 16 MiB. The player targets a twenty-second forward buffer with a
twenty-four-second time ceiling, four seconds behind and a 64 MiB byte target.
An appended fragment can overshoot a buffer target; decoder memory is
separate.  There is no background download of the full 817 MB recording.
The public profile supplies STUN and the operator's TCP/TLS TURN route without
changing browser privacy preferences. Vanadium's default restriction on
non-proxied UDP can require that relay; see the
[GrapheneOS explanation](https://bsky.app/profile/grapheneos.org/post/3lqpnxljvd22d).
If the issuer or a usable peer route is unavailable, HTTPS playback continues.
The player never embeds private test credentials in its bundle.

`media-turn-credentials.mjs` POSTs a bounded request to
`https://demo.forgesworn.dev:7443/turn-credentials` only during participation.
The response permits only `turns:demo.forgesworn.dev:5349?transport=tcp`, uses
no-store responses and a unique expiring principal, and refreshes after two
thirds of its remaining lifetime. Slow HTTP responses consume that lifetime.
New peer connections use the latest credential. Relayed connections retire
shortly before their old credential expires so the SDK can reconnect while
the playing HLS instance and verified cache survive. Pause cancels renewal.
Diagnostics expose availability and expiry duration, never the credential.

The operator runs a small Rust issuer behind an isolated TLS listener. It
consumes a bounded private pool minted by Spry's existing CLI and cannot read
the TURN root secret. Per-address and global issuance limits, four active
issuer connections, 32 TURN allocations and an 8 MiB/s aggregate bandwidth
limit per allocation bound this demo. The private dashboard remains separate.
Operator installation and rollback are maintained in
[Archy's issuer guide](https://github.com/forgesworn/archipelago-apps/tree/main/operator/turn-issuer).
Published-origin browser CORS and bidirectional 1 MiB hash-verified TLS relay
checks passed on 25 October 2026. Sustained cold-cache 4K contribution,
credential rotation during playback and physical iPhone acceptance remain
separate checks.
The pinned 689 KiB piece catalogue is bounded to 1 MiB, and the browser uses
the existing 402 KiB Rust/WASM module.  Both load only after Play.  The bundle
receipt records the exact source, WASM digest and dependency notices; the
website build copies that public module without compiling Rust.

The current browser bundle pins RelaySwarm 0.4.4. Cached schema-3 media reaches
the mixed piece planner even when the whole-object peer estimate is late, and
waiting for unavailable main-rendition recorded media requires an active
same-key fetch lease. Live and unknown playlists retain bounded seeding
coordination.
Sustainable peer waits and range-sized WASM upload inputs are retained. A six MiB object requested in sixteen
ranges copies six MiB into WASM instead of 96 MiB; this is input-copy accounting,
not a throughput or device-continuity claim. Playback details show the actual native/MSE engine and
vendored library version/source. The former 15-minute adapter cutoff was
removed; recordings and native loop connections can continue while playing.

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
node test/media-shared-topology-browser.mjs --site site \
  --output .local/shared-topology.json
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
