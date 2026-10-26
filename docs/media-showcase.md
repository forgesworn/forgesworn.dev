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

The recording label sits with the source caption below the player. It does
not cover the picture or Safari’s native fullscreen control when controls
appear.

A [physical Safari trace](evidence/physical-safari-playback-20261026.json) on
26 October recorded 330 seconds of advancing ManagedMediaSource playback,
including an actual programme wrap and 178 seconds afterwards. Observed
counters stayed at zero stalls and player errors; the owner reported
“Smooth, no pauses”. This qualifies that existing phone session on revision
`9e07608`, not a cold phone cache, dropped-frame performance, peer delivery
or public TURN. Native dimensions, audio properties and frame counters
remain unmeasured.

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
**Back to live** to return. Continuous recorded playback compares the raw
player timeline with its fixed room-clock mapping; VOD fallback retains the
circular clock comparison. Both use the existing browser observation timer. Automatic correction
allows 750 ms of decoder offset plus the last observed seek interruption,
measured through sustained advancing video time. Safari's `seeked` and
`playing` events alone do not end recovery. Automatic correction needs
five seconds of stable playback and
an offset in the same direction for at least three seconds, and requires
both positions in one continuous buffer with two seconds of headroom.
Corrections are spaced at least 15 seconds apart. Waiting, seeking or
pausing restarts the recovery period. Joining and **Back to live** can align
immediately; returning from full screen uses the recovery
checks. For example, a 500 ms seek makes the ordinary allowance 1.25 seconds;
removing 770 ms of offset must not itself cause another half-second interruption.
Pausing or hiding the page cancels an unfinished measurement so time away
cannot inflate the allowance. Emptying the video clears the old engine's
measured cost. The music's tempo stays unchanged. This avoids repeated clock seeks
interrupting a slower decoder while it is trying to recover. Buffering and
differences
in device clocks or audio output can still create temporary offsets; this is
not a multi-speaker audio synchronisation protocol. Full screen and playback
details retain the same video and session. A natural recording boundary
retains room membership, native peer connections, identity and cached media.

Before Play, the page prepares the HLS module without creating a player or
requesting video. The first tap attaches the selected media source and calls
the same video's `play()` before waiting for room discovery or peer setup.
The pending playback request supplies demand to ManagedMediaSource while the
approved stream starts at the freshly discovered room position. Metadata
preparation happens after that tap. Initial
playback does not wait for the former paused three-second prime. This preserves
the tap's playback request; it does not establish startup headroom or guarantee
cold-cache continuity.

For a new full-recording room, discovery reserves a local candidate identity
without publishing an active listener or starting its clock. The original HLS
pipeline prepares verified encoded media at raw position zero. Its SDK startup
barrier holds the first callback until contiguous media covers measured source
recovery headroom, within three objects, 24 MiB and the original eight-second
deadline. It then acknowledges the room start over the existing relays, anchors
that same timeline once, and repeats fresh target, authority and coverage checks
before releasing the callback. Preparation is not decoded playback or an active
watcher. The trusted play request and visible player remain the same.

Existing rooms retain their advancing clock. If another starter publishes first,
the unpublished candidate cohort is retired before any held body reaches HLS;
the empty attached player joins the observed epoch. Pause and cancellation retire
local preparation. A published epoch is never moved backwards. Unsupported
metadata and browsers without a frame witness retain the ordinary startup path.
An adopted epoch can first appear in an unready publication notification and
then become ready after its ACK. Recorded playback compares that ready epoch
with the recording's bound epoch, so the intervening notification cannot hide
the required handoff. A losing unpresented candidate retires its view and peer
scope on the same empty player and original pending Play; a presented pipeline
keeps its existing replacement path. Same-epoch ACKs do not reload the source.
Controller fixtures cover both notification stages and stale callbacks. They
do not establish a cause for every cold-start failure or qualify fresh playback.
The M4 checks below qualify their recorded source revision for two fresh browser contexts
on one direct route, including an actual recording wrap. Physical phones,
cross-network traversal and public TURN remain separate acceptance gates.

The supported recordings use a bounded client-generated live playlist. The
canonical VOD manifest is verified against its pinned digest before its
durations and exact media URLs are used. A sliding window includes 24 seconds
ahead and 24 seconds behind the room clock, with a discontinuity and repeated
initialisation map at each programme wrap. There is no ENDLIST in this view.
The existing player can load the next head before the tail finishes; normal
wraps do not end, reset to zero, re-prime, replace a peer identity or force a
catch-up seek. No additional player or streaming service is created.

The extra history retains metadata through a slow startup or temporary
underflow. hls.js can otherwise seek forward when the current fragment falls
outside its live playlist, even with infinite maximum latency. The playlist
still has at most 64 fragments; the media back buffer remains four seconds
and the encoded-media cache limits stay unchanged. This history does not
prefetch old media or establish sustained cold-cache continuity.

The [cold-start recovery receipt](evidence/cold-start-recovery-20261025.json)
retains the controlled nine-second response delay: the short history omitted
needed fragments and forced a catch-up seek; the longer history retained them
and avoided that seek. A separate 59 ms wait still occurred in the new control,
so its strict no-wait result remains red. The earlier full 4K run also remains
red and predates this metadata-history correction.

Each session has a fixed player-time origin derived from its first selected
fragment. A global media sequence number is not a player timestamp. Shared
clock following uses this explicit mapping; displayed programme time, listener
telemetry and the musical pulse use the corresponding recording phase. Playback
remains at 1x. A genuinely new room epoch replaces the media pipeline on the
same visible video; same-epoch pause/resume retains the mapping.

Unrecognised metadata and native HLS retain the original VOD path. That path
can prime three seconds on replay, with its bounded current-position release
and playback-demand bootstrap. Those fallback waits remain measured and are outside the prepared-room M4
qualification below.
Recorded public playback targets 20 seconds of forward buffer,
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

Both native entry paths set `crossOrigin = 'anonymous'` before assigning the
manifest: the same-origin playlist references media on the approved remote
host. A recovery requests native playback immediately after assigning that
source; it does not wait for metadata to supply playback demand. Metadata
restores the recording phase without issuing another Play, so a later viewer
pause or browser policy rejection cannot be undone by that callback. The old
HLS replay-prime barrier is cancelled during the handoff.

The [native recovery receipt](evidence/native-hls-recovery-20261025.json)
records an HTTP/2-controlled native comparison and an intentional fatal-error
test through the real homepage controller. Terminal media errors stop the
stall timer, leave listener presence and restore an enabled Play again control.
The recovery test proves phase restoration and resource shutdown; its measured
transition interruption is retained and it does not qualify uninterrupted
cold-cache playback or physical phones.

Native HLS cannot use the RelaySwarm fragment loader. Its active peer topology
is empty; earlier verified peer downloads and uploads remain visible as
historical totals. Native origin-transfer totals are shown as unavailable.
This recovery is an alternative delivery path, not evidence that the original
ManagedMediaSource issue or physical iPhone playback has passed acceptance.

A subsequent [iOS 18.3 Simulator run](evidence/safari-native-demand-20261026.json) on the previously deployed revision
presented 4K video for 148 seconds with no reported stalls and three dropped
frames, while exchanging verified media with a direct peer. Shortly after
the first report download, it recorded player errors and a native handoff
that remained paused at time zero. The download's role is unproven; this is
a failed run, not a replay or physical-phone pass. The new controller checks
cover immediate native demand, phase restoration, pause, policy rejection and
handoff during replay priming. They qualify controller ordering, not decoded
recovery on Safari.

Saved reports now retain allowlisted HLS error types/details, the fatal flag,
native numeric media-error codes, terminal playback state and fallback reason.
They never copy arbitrary error messages, source URLs or SDK error objects.
A zero stall counter does not establish success when playback is failed or
paused. Frame counters can reset on an engine change; earlier drops must not
be discarded when assessing a run.

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

**Save report** and, where supported, **Share report** in Playback details
export a separate `forgesworn-playback-report` JSON file. It retains at most
240 observations, sampled at most once per second through the existing player
tick: actual frame counters and dimensions, buffering, stalls, visibility,
the last Play rejection's fixed error code (without its message),
room offset, verified peer and upload counters, library version and anonymous
selected route types. Startup observations distinguish the SDK barrier's fixed
state/reason and one-shot counters, Hls loading/buffering and current main
fragment enums/numbers, the attached MediaSource's state/streaming flag, and
playback intent and room preparation/readiness. The last player error retains
only its fixed codes and fragment type/sequence/discontinuity, without a URL.
These observations do not retry, resume or otherwise change startup policy.
Missing readings, retired pipelines and unsupported properties remain `null`. It excludes addresses,
SDP, peer identities, credentials and source URLs or filesystem paths. Nothing
is uploaded by the page; sharing requires the viewer's action. Export handlers
do not call playback controls; the browser's download/share presentation is
observed separately. The report is a diagnostic observation, not by itself a
controlled comparison or proof of a cold browser cache.

Reports keep raw media position and buffer ranges. Continuous media duration
can be infinite and is therefore exported as `null`; `playbackMode`,
`recordingPosition` and `recordingDuration` separately describe the programme
phase. Folding raw player time modulo the recording duration would lose the
session's initial timeline offset.

Playback waits include real underflow and seek interruptions. A network
`stalled` event alone does not increment the playback counter while the media
still has future data and is not seeking; frame and playhead readings remain
separate evidence of progress.

These are browser observations, not a claim of net bandwidth or financial
savings.  Signalling, commitments, duplicate attempts and protocol overhead
also use bandwidth.  Published origin CPU/RSS results are dated native
measurements, separate from this public replay.

## 4K delivery observations

The [26 October prepared-room summary](evidence/prepared-room-4k-20261026.json)
records staged 60.075-second and 330.213-second full-4K checks. Both viewers had
**zero post-first-frame stalls and zero dropped frames**. Their maximum sampled
room-clock offsets were 0.321/0.119 seconds in the short run and 0.343/0.116
seconds in the long run, within the unchanged 750 ms budget. The second viewer's
first three samples were not yet presented; every later eligible sample was
checked, with no unknown samples or violations.

| Run | Viewer | Accepted peer bytes | Peer share | HTTP body bytes | Accepted loaded bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| 60 s | A | 24,484,771 | 11.08% | 216,343,039 | 220,988,648 |
| 60 s | B | 42,297,447 | 19.72% | 191,321,195 | 214,516,682 |
| 330 s | A | 127,992,334 | 12.02% | 1,039,748,321 | 1,064,588,887 |
| 330 s | B | 70,385,118 | 6.65% | 1,041,002,497 | 1,058,116,921 |

The original contribution gate requires at least 10 MiB and 10% accepted peer
share in **one harness-selected receiving viewer**. In the long run A passed;
B's 6.65% remains below that share threshold. These percentages describe loaded
video, including buffered media. HTTP body totals include partial reads before
losing races were aborted. They are observations, not net HTTP, wire-byte,
billing or competitor-advantage claims.

Both long-run viewers actually crossed the 267.32-second programme boundary:
recording phase rolled over while raw Hls time kept increasing, and SDK
observations included discontinuity counters 0 then 1. Periodic samples cover
at least another 61.558 seconds for A and 62.638 seconds for B after their first
observed wrapped phases. Each retained one visible video, one nonempty media
source URI and one acknowledged epoch pair; no pipeline reset or post-frame
interruption was observed. JavaScript Hls object identity was not serialized.
The periodic sampled window was 329.387 seconds, distinct from the run's
330.213-second observation timer.

These were two fresh Chrome 155 contexts on the same M4 Mac, using normal
unmuted HTML media at 1x and direct host-to-host UDP peers. Browser HTTP cache
was disabled; a cold CDN was not established. Startup still took 4.111 seconds
for A and 2.981 seconds for B in the long run. The short pass also had faster
HTTP delivery than the preceding failed run, so this is not a controlled claim
that preparation alone caused the improvement. Physical iPhone playback,
separate networks/NAT and independently operated public TURN remain unqualified.

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

The demo also opts into `zeroBudgetPeerRace` and `lateHaveRace`. When there is
no safe time to wait before starting HTTP, the normal request starts
immediately. A native connection already accepted at load entry may race it
after advertising the exact cached object, including an object that becomes
available while HTTP runs. This uses the original 2.5-second window, with no
extension or added HTTP request. One holder set is frozen when the peer arm
starts; a new or replaced connection cannot join that load. The
Rust piece planner uses its explicit peer-only mode. It has no internal HTTP source;
the ordinary HTTP loader runs independently. A verified calibration piece
unlocks further bounded ranges, while unassigned pieces remain bounded pending
work. The first complete accepted source wins; the losing
arm is cancelled.  This creates no additional origin request and does not
prefetch media outside the visible player's demand.  Progressive HTTP payload
locks that load to HTTP, so sources cannot mix after an append.  Pausing or
turning off the swarm stops its peer arm while preserving normal HTTP
playback.

Sustainable serial waits also require an actual origin timing sample. A cold
loader starts HTTP immediately instead of treating its configured reserve as
measured recovery time. Cached and late-HAVE races retain their independent
parallel window; ordinary positive budgets resume once source timing exists.
This prevents the observed cold mixed-transfer admission, without establishing
that later WAN, decoder or clock-correction interruptions are resolved.

Each peer request stays within four pieces and 512 KiB, retaining the upload
burst and rate bounds even when the complete fragment exceeds the burst.
Only the accepted load-entry connections that advertise the object when the
peer arm starts can participate. At the peer floor, remaining peer work is cancelled while
the independent HTTP loader continues. Older modules without the explicit
mode safely decline that arm. The buffered mixed mode keeps its HTTP ranges.

## Integrity and scope

The complete recording is immutable, static HLS made by FFmpeg packet copy
with no re-encoding.  Its original coded geometry is 3840 × 2160; its retained
sample aspect ratio produces a natural HTML display width of 3842.  The
optional 1080p excerpt was captured from actual Sapflow publishing.
The public film is not a continuously running Sapflow origin.

The original file has 268.6 seconds of video and 267.32 seconds of audio.
The looping programme retains every audio packet and removes only the final
32 video frames after the soundtrack ends. Its duration is 267.32 seconds.
The init and first 133 fragments remain byte-identical. The final fragment
uses the new immutable name `segment-0133-audioend-v2.m4s`; its 18 video
packets and all 34 audio packets are copied without re-encoding. Merely
shortening EXTINF leaves the actual video timestamps unchanged and does not
repair the gap. The old final fragment and catalogue remain available.

`node scripts/package-public-swarm-audioend.mjs --full-dir DIR` reproduces
the reviewed metadata from the 267.32-second packet-copy package. It verifies
the init, all 133 unchanged fragments and the exact new tail before writing
catalogue v3 and the public manifest. The original piece packager now writes
`index-v1.m3u8`, preserving the corrected public index.

The [recorded-loop receipt](evidence/recorded-loop-20261025.json) separates
the successful isolated 4K boundary check from the earlier failed 300-second
cold-cache run. The boundary check does not establish sustained WAN playback
or physical iPhone acceptance.

`site/media/dejavu-swarm/catalogue-v3.json` records the exact sequence, size,
whole-object SHA-256 and canonical piece hashes of every approved fragment.
The adapter pins that
catalogue's SHA-256 in source and independently checks its identity, origin,
path, sequence and size.  Its trust anchor is the reviewed website over
HTTPS.  Each browser generates a temporary local signing key to wrap those
exact trusted digests in the existing RelaySwarm commitment format.  Peer
claims cannot choose the expected hash.  This is receiver-local attestation,
not an independent broadcaster signing a live feed.  No publisher secret is
embedded in the website, and the library verifier is unmodified.

The VOD swarm identity is fixed for each immutable quality. Continuous
recorded cohorts also bind the room epoch, manifest digest and programme
duration, so incompatible timelines cannot share commitments. Regenerate
the catalogue and bump its version and swarm IDs if media is repackaged.
`scripts/package-public-swarm-pieces.mjs` verifies every full-media body against
the original pinned hashes before deriving pieces, and checks every local
preview piece.  `/media/dejavu-4k/index.m3u8` is a small, reviewed playlist alias
whose fragment URLs still point to the same remote media.  It gives schema 3
an exact `/media/` identity without moving or altering the recording.  The
source recording and signing keys do not enter the repository.

Rendezvous uses the explicitly listed public Nostr relays and encrypted peer
signals. STUN supplies direct candidate discovery. The public Spry credential
endpoint and expected TURN/TLS URL remain unconfigured. Once an independent
operator supplies both, playback also requests an expiring TLS credential
from that independently operated public instance. Direct connections remain
eligible; a relay supplies a route when the browser cannot use direct UDP. The static site contains no
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
The public profile supplies STUN and, when configured, the operator's
TCP/TLS TURN route without changing browser privacy preferences. Vanadium's default restriction on
non-proxied UDP can require that relay; see the
[GrapheneOS explanation](https://bsky.app/profile/grapheneos.org/post/3lqpnxljvd22d).
If the issuer or a usable peer route is unavailable, HTTPS playback continues.
The player never embeds private test credentials in its bundle.

An independently operated showcase supplies `data-turn-credential-endpoint`
(an HTTPS URL) and `data-turn-url` (an explicit
`turns:relay.example:5349?transport=tcp` route) on `#main`. Both are required;
the ForgeSworn page supplies neither. TLS/TCP ports such as 443, 5349 and 5350
are supported when explicitly selected. Issuer responses cannot select a
different route, and later mutation of a configuration object cannot retarget
an existing peer adapter.

`media-turn-credentials.mjs` uses the configured public Spry instance's
`POST /v1/public/credentials` contract only during participation. It validates
the direct `urls`, `username`, `credential` and epoch-second `expiresAt` fields,
selects only the explicitly configured TLS TURN URL and coalesces one lease per viewer across
new peer connections. The supported public service contract freshly mints one-hour
credentials. The client keeps a conservative monotonic lifetime, charging
request/body time and a rounding margin; a wall-clock correction can only
shorten it. Renewal starts after two thirds of the remaining lifetime.
New peer connections use the latest credential. Relayed connections retire
shortly before their old credential expires so the SDK can reconnect while
the playing HLS instance and verified cache survive. Pause cancels renewal.
Diagnostics expose availability and expiry duration, never the credential.

An unconfigured public relay causes no request, timer or startup delay;
HTTP playback and direct/STUN peers remain available.

The public profile is separate from KithMoot's paired private mesh. Its source
bounds issuance to 32 requests per minute globally and six per source, with a
bounded in-memory source table. A 4 KiB client response cap, four-second
request/body deadline and spaced retries bound the browser path. The final
public instance endpoint and a deliberate 4K bandwidth setting are operator
configuration; the existing paired instance is not an anonymous issuer.

The earlier test issuer's published-origin CORS and bidirectional 1 MiB
hash-verified TLS checks passed on 25 October 2026. That lab route was replaced
by the paired private deployment. No separate public instance is live in the
reviewed evidence. Final public issuance, sustained 4K through that relay,
credential rotation during playback and physical iPhone acceptance require
the configured public route and fresh playback evidence. The direct-peer M4
checks above do not qualify that public TURN path.
The pinned 689 KiB piece catalogue is bounded to 1 MiB, and the browser uses
the pinned Rust/WASM module. Both load only after Play. The bundle
receipt records the exact source, WASM digest and dependency notices; the
website build copies that public module without compiling Rust.

The browser bundle pins an exact RelaySwarm 0.4.4 source revision. Cached
schema-3 media uses the explicit peer-only ranged planner even when the
whole-object peer estimate is late, and
waiting for unavailable main-rendition recorded media requires an active
same-key fetch lease. Live and unknown playlists retain bounded seeding
coordination.
Sustainable peer waits and range-sized WASM upload inputs are retained. A six MiB object requested in sixteen
ranges copies six MiB into WASM instead of 96 MiB; this is input-copy accounting,
not a throughput or device-continuity claim. Playback details show the actual native/MSE engine and
vendored library version/source. The former 15-minute adapter cutoff was
removed; recordings and native loop connections can continue while playing.

The site explicitly packages and enables a dedicated module Worker for the
Rust piece-transfer scheduler and payload verification. It reuses the already
compiled WASM module; no additional WASM request is needed. The companion's
source, size and SHA-256 are recorded beside the SDK bundle in
`site/vendor/media-peer-demo.build.json`. Worker startup is asynchronous.
While it is unavailable, HTTP playback continues; failed transfers do not
retry large Rust verification on the browser's main thread. Work, queued
payloads and concurrent objects are bounded, and leaving the swarm terminates
its Worker. This moves verification work away from playback and controls;
physical-device continuity and useful peer contribution still need measured
playback evidence.

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
  --observe-seconds 300 --min-peer-bytes 10000000 --min-peer-share 0.1 \
  --expected-playback-mode recorded-live \
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
