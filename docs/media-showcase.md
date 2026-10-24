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
RelaySwarm can serve already held fragments to other visitors.  Pause,
completion and page departure close sharing connections and release the
media cache.  Native play rejoins; its upload allowance and original lifetime
are retained across pause/resume.

The first viewer normally receives media from the HTTPS host.  Origin
delivery remains available when there is no useful peer, a relay is
unavailable, a network prevents a direct connection or a peer deadline is
missed.  A successful connection does not establish that media travelled
through it.  The received-video counter rises only after peer media passes
integrity verification.

The small rolling cache means viewers need overlapping media positions to
help one another.  **Invite someone into this moment** copies a public link
containing only quality, playback time and the time of the invitation.  The
recipient's Play advances that position by elapsed time, keeping a promptly
opened invitation near the sender's cache window.  Old or completed
invitations start from the beginning.  This is approximate alignment using
browser clocks, not an authoritative synchronisation service.

## What the picture shows

The graph shows the media host, this browser and its actual native peer
connections.  Peer identities are temporary local labels.  It contains no
global viewer total, guessed peer-to-peer links or network-address display.
Connecting edges become connected only when native connection state changes.

Moving points represent media transfers.  Origin movement follows completed
HTTP fragment responses, measured by the real loader before its buffer can be
transferred to a decoder worker.  Peer upload movement counts binary media
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

- **From media host:** completed HTTP media response bodies, including the
  initialisation fragment.  Playlist bytes, failed partial responses and
  Resource Timing sizes are not mixed into this hls.js media counter.
- **Verified from viewers:** complete peer media bytes accepted by RelaySwarm's
  verification path.  HTTP fallback does not increment this counter.
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
records the zero-video/moving-arrow regression and the corrected real
two-browser preview transfer.  Its media arrows match verified bytes by
connection, while HTTP has its own counter.  This uses a pinned public
RelaySwarm source commit containing the observation hook; immutable v0.3.0
release assets do not contain that later addition.

Useful 4K peer delivery remains an experimental limitation.  Two 40-second
windows on a heavily loaded shared Mac delivered zero complete verified peer
segments.  Increasing the peer wait from 1.2 to 2.5 seconds and its ceiling
from 2.5 to 5 seconds still completed no peer segment, despite 5.57 MB sent.
The receiver stalled and played less video.  Its lower HTTP total does not
establish a saving, and those timings were not adopted.  The receipt keeps
the failed attempts and host load rather than selecting only a small
successful exchange.  These observations use the previous browser bundle;
the new observation callback is not a measured performance improvement.

The current public profile requires a complete verified segment before the
peer-first handoff.  A large 4K fragment, limited useful buffer time and
non-overlapping viewer caches can therefore yield a connection with little
or no useful delivery.  The page reports that outcome directly.  Improving
4K contribution needs separate scheduling and fragment-size evidence, with
playback progress and stalls considered alongside peer bytes.

## Integrity and scope

The complete recording is immutable, static HLS made by FFmpeg packet copy
with no re-encoding.  Its original coded geometry is 3840 × 2160; its retained
sample aspect ratio produces a natural HTML display width of 3842.  The
optional 1080p excerpt was captured from actual Sapflow publishing.
The public film is not a continuously running Sapflow origin.

`site/media/dejavu-swarm/catalogue-v1.json` records the exact sequence, size
and SHA-256 of every approved media fragment.  The adapter pins that
catalogue's SHA-256 in source and independently checks its identity, origin,
path, sequence and size.  Its trust anchor is the reviewed website over
HTTPS.  Each browser generates a temporary local signing key to wrap those
exact trusted digests in the existing RelaySwarm commitment format.  Peer
claims cannot choose the expected hash.  This is receiver-local attestation,
not an independent broadcaster signing a live feed.  No publisher secret is
embedded in the website, and the library verifier is unmodified.

The shared swarm identity is fixed for each immutable quality.  Regenerate
the catalogue and bump its version and swarm IDs if media is repackaged.
`scripts/package-public-swarm-catalogue.mjs` builds it from the verified full
media manifest and shipped Sapflow preview; tests hash every local preview
segment.  The source recording and signing keys do not enter the repository.

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
