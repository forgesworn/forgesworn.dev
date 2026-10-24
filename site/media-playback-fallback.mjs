const FROZEN_MS = 8_000;
const REBUFFER_MS = 1_000;
const WINDOW_MS = 30_000;
const PROGRESS_SECONDS = 0.05;

// Prefer native playback on iOS until its ManagedMediaSource path is reliable.
// This bypasses the peer fragment loader; other browsers keep their Hls path.
export function prefersNativeHls(video, browser = globalThis.navigator) {
  if (typeof video?.canPlayType !== 'function' || !video.canPlayType('application/vnd.apple.mpegurl')) return false;
  const userAgent = typeof browser?.userAgent === 'string' ? browser.userAgent : '';
  const platform = typeof browser?.platform === 'string' ? browser.platform : '';
  const ios = /\b(?:iPhone|iPad|iPod)\b/i;
  return ios.test(userAgent) || ios.test(platform) ||
    (platform === 'MacIntel' && typeof browser.maxTouchPoints === 'number' && browser.maxTouchPoints > 1);
}

// The caller supplies eligibility: a presented frame, a visible page and an
// active public Hls player with native HLS available. No timers or DOM listeners
// are owned here. reset() clears observations, but never rearms a fired helper.
export function createNativePlaybackFallback(video, { now = () => performance.now() } = {}) {
  let fired = false, lastAt = null, lastTime = null, progressAt = null, progressTime = null;
  let rebufferAt = null, episodes = [];

  const reset = () => {
    lastAt = lastTime = progressAt = progressTime = rebufferAt = null;
    episodes = [];
  };
  const begin = (at, time) => {
    lastAt = progressAt = at;
    lastTime = progressTime = time;
    rebufferAt = video.readyState < 3 ? at : null;
  };

  return {
    reset,
    check(eligible = true) {
      if (fired) return false;
      const at = now(), time = video.currentTime;
      if (!eligible || video.paused || video.seeking || video.ended ||
          !Number.isFinite(at) || !Number.isFinite(time)) {
        reset(); return false;
      }
      if (lastAt === null) { begin(at, time); return false; }

      const elapsedSeconds = Math.max(0, at - lastAt) / 1_000;
      // A recording wrap or an observed seek starts a new grace period. Also
      // recognise large jumps when a short seek completed between checks.
      if (at < lastAt || time < lastTime - PROGRESS_SECONDS ||
          time - lastTime > Math.max(1, elapsedSeconds * 2 + 0.25)) {
        reset(); begin(at, time); return false;
      }
      lastAt = at; lastTime = time;
      episodes = episodes.filter(start => start >= at - WINDOW_MS);

      // A small clock nudge while readyState is still HAVE_CURRENT_DATA does
      // not establish recovered playback or replenish the freeze grace period.
      const progressing = video.readyState >= 3 && time - progressTime >= PROGRESS_SECONDS;
      if (progressing) {
        progressAt = at; progressTime = time;
        if (rebufferAt !== null) {
          if (at - rebufferAt >= REBUFFER_MS) episodes.push(rebufferAt);
          rebufferAt = null;
        }
      } else if (video.readyState < 3 && rebufferAt === null) rebufferAt = at;

      const currentEpisode = rebufferAt !== null && at - rebufferAt >= REBUFFER_MS ? 1 : 0;
      if (at - progressAt >= FROZEN_MS || episodes.length + currentEpisode >= 3) {
        fired = true; reset(); return true;
      }
      return false;
    },
  };
}
