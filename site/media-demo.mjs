import { attachFullscreen } from './media-fullscreen.mjs';

const element = id => document.getElementById(id);
const video = element('media-video');
const start = element('demo-start');
const stop = element('demo-stop');
const selector = element('demo-ingest');
const status = element('demo-status');
const counters = { transport: element('demo-transport'), fragments: element('demo-fragments'), bytes: element('demo-bytes'), peers: element('demo-peers') };
let active, operation = 0;

function bytes(value) {
  return value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(text) {
  status.textContent = active?.playbackBlocked && video.paused
    ? 'Your browser needs another play gesture.  Press play on the video to start playback with sound.'
    : text;
}
function setCounter(key, text) { if (counters[key]) counters[key].textContent = text; }

async function requestPlayback(session) {
  if (session.abort.signal.aborted || session !== active) return false;
  try {
    await video.play();
    if (session.abort.signal.aborted || session !== active) return false;
    session.playbackBlocked = false;
    return true;
  } catch (error) {
    if (session.abort.signal.aborted || session !== active) return false;
    if (error.name !== 'NotAllowedError') throw error;
    // Keep the prepared video and its controls available. Browser policy must
    // not turn a request for audible playback into silently muted playback.
    session.playbackBlocked = true;
    setStatus('');
    return false;
  }
}

async function stopPlayback({ reset = true, preparing = false } = {}) {
  const generation = ++operation;
  const session = active;
  active = undefined;
  session?.abort.abort();
  try { await session?.controller?.stop(); } catch { /* Best-effort cleanup after a browser disconnect. */ }
  session?.hls?.destroy();
  if (generation !== operation) return false;
  video.pause();
  video.removeAttribute('src');
  video.load();
  start.disabled = preparing;
  start.textContent = 'Play the demo';
  if (stop) stop.disabled = true;
  selector.disabled = false;
  setCounter('peers', '0');
  if (!preparing) setCounter('transport', 'Stopped');
  if (reset) {
    setStatus('Stopped.  Choose a source and play again.');
  }
  return true;
}

async function json(url, signal) {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('The demo media could not be loaded.');
  return response.json();
}

function stats(value) {
  const data = value.viewer;
  setCounter('bytes', bytes(data.peerBytes));
  setCounter('fragments', String(data.verifiedPeerSegments));
  setCounter('peers', String(data.connectedPeers));
  const pairs = value.transport.selectedPairs;
  const relayed = pairs.length > 0 && pairs.every(pair => pair.localType === 'relay' && pair.remoteType === 'relay');
  setCounter('transport', value.phase === 'stopped' ? 'Stopped' : value.phase === 'peer' ? relayed ? 'Spry TURN' : 'WebRTC peer' : 'HLS origin');
  if (value.phase === 'connecting') setStatus('The video is ready.  Connecting the two demo viewers…');
  else if (value.phase === 'loading-holder') setStatus('Preparing the first viewer to share the video…');
  else if (value.phase === 'peer') setStatus(relayed
    ? 'Playing verified peer video through your local Spry TURN server.'
    : 'Playing verified peer video between two viewers in this browser.');
  else if (value.phase === 'origin-fallback') setStatus('Playing from the HLS origin while peer delivery is unavailable.');
  else if (value.phase === 'stopped') setStatus('Demo session finished.  Play again to reconnect the viewers.');
  else if (value.phase === 'error') setStatus('Playback stopped.  Replay the demo to reconnect.');
}

async function nativePlayback(url, session) {
  video.src = url;
  setCounter('transport', 'Native HLS');
  setCounter('fragments', '0');
  setCounter('bytes', '0 KB');
  setCounter('peers', '0');
  if (await requestPlayback(session)) setStatus('Playing Sapflow-packaged HLS with your browser’s native player.');
}

async function originPlayback(Hls, url, session) {
  const hls = new Hls({ enableWorker: false, maxBufferLength: 10, backBufferLength: 5 });
  session.hls = hls;
  let loaded = 0;
  hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
    loaded += data.payload.byteLength;
    setCounter('fragments', '0');
    setCounter('bytes', '0 KB');
    setCounter('transport', 'HLS origin');
    // Peer-byte counters remain zero in origin mode. Native player controls
    // and the network panel expose origin playback without invented totals.
    setStatus(`Playing Sapflow-packaged HLS from the origin (${bytes(loaded)} received).`);
  });
  hls.on(Hls.Events.ERROR, (_event, error) => { if (error.fatal) setStatus('Playback stopped.  Replay the demo to reconnect.'); });
  hls.attachMedia(video);
  hls.loadSource(url);
  await requestPlayback(session);
}

async function play() {
  if (start.disabled) return;
  start.disabled = true;
  if (!await stopPlayback({ reset: false, preparing: true })) return;
  const generation = operation;
  const abort = new AbortController();
  const session = { abort };
  active = session;
  start.disabled = true;
  selector.disabled = true;
  if (stop) stop.disabled = false;
  // This is an explicit Play gesture. The visible element starts audible and
  // retains any mute or volume choice the person makes across later Replay.
  for (const key of ['fragments', 'peers']) setCounter(key, '0');
  setCounter('bytes', '0 KB');
  setCounter('transport', 'Preparing');
  setStatus('Loading the Sapflow-packaged video…');
  try {
    const base = new URL('./media/demo/', import.meta.url);
    const catalogue = await json(new URL('manifest.json', base), abort.signal);
    const key = selector.value === 'srt' ? 'srt' : 'rtmp';
    const clip = catalogue.clips?.[key];
    if (!clip || clip.playlist !== `${key}/index.m3u8` || clip.manifest !== `${key}/segments.json`) throw new Error('Invalid demo catalogue.');
    const playlistUrl = new URL(clip.playlist, base).href;
    const segments = await json(new URL(clip.manifest, base), abort.signal);
    if (generation !== operation) return;
    const { default: Hls } = await import('./vendor/hls.light.min.mjs');
    if (generation !== operation) return;
    let runtime;
    if (new URL(location.href).searchParams.get('relay') === 'local' && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
      runtime = await json(new URL('runtime.json', base), abort.signal);
    }
    if (Hls.isSupported() && typeof RTCPeerConnection === 'function') {
      try {
        const { startPeerDemo } = await import('./media-peer-demo.mjs');
        if (generation !== operation) return;
        session.controller = await startPeerDemo({ Hls, video, playlistUrl, manifest: segments, runtime, signal: abort.signal,
          onStats: value => { if (!abort.signal.aborted && generation === operation) stats(value); } });
        if (!abort.signal.aborted && generation === operation && video.paused) await requestPlayback(session);
      } catch (error) {
        if (abort.signal.aborted || generation !== operation) return;
        if (runtime) throw new Error('The local TURN peer test could not connect.  Check that Spry is running and try again.');
        await session.controller?.stop();
        await originPlayback(Hls, playlistUrl, session);
      }
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      if (runtime) throw new Error('This browser uses native HLS.  Use a browser with Media Source Extensions for the local peer test.');
      await nativePlayback(playlistUrl, session);
    } else if (Hls.isSupported()) {
      if (runtime) throw new Error('WebRTC is unavailable in this browser.');
      await originPlayback(Hls, playlistUrl, session);
    } else throw new Error('This browser cannot play HLS.  Open the playlist with an HLS player.');
    if (generation === operation) { start.disabled = false; start.textContent = 'Replay the demo'; }
  } catch (error) {
    if (abort.signal.aborted || generation !== operation) return;
    await stopPlayback({ reset: false });
    setStatus(error.message || 'The demo could not start.  Please try again.');
    setCounter('transport', 'Stopped');
  }
}

if (video && start && selector && status) {
  attachFullscreen({ container: element('media-video-wrap'), video, button: element('demo-fullscreen'), onError: setStatus });
  video.addEventListener('playing', () => {
    if (!active?.playbackBlocked) return;
    active.playbackBlocked = false;
    setStatus('Playing the demo.');
  });
  start.addEventListener('click', () => { void play(); });
  stop?.addEventListener('click', () => { void stopPlayback(); });
  selector.addEventListener('change', () => { void stopPlayback(); });
  window.addEventListener('pagehide', () => { void stopPlayback({ reset: false }); });
}
