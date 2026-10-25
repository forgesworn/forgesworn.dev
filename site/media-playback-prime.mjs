// Decide when the existing player has enough appended media to start. The
// controller owns loading, the single alignment, playback and wait accounting.
export function createPlaybackPrime(video, {
  now = () => performance.now(), headroomSeconds = 3, maxWaitMs = 12_000,
} = {}) {
  if (!Number.isFinite(headroomSeconds) || headroomSeconds <= 0 || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    throw new TypeError('Invalid playback priming budget');
  }
  let active = true, complete = false, beganAt = null, deferredTarget = null, deferredDuration = null;
  const reset = () => { active = true; complete = false; beganAt = deferredTarget = deferredDuration = null; };
  const result = (ready, position, reason) => {
    if (ready) complete = true;
    return { ready, position, reason };
  };
  const covered = (position, required) => {
    if (!Number.isFinite(position) || position < 0) return null;
    try {
      for (let index = 0; index < video.buffered.length; index++) {
        const start = video.buffered.start(index), end = video.buffered.end(index);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= position + 0.001 &&
            end > position && end - position >= required - 0.001) return Math.max(start, position);
      }
    } catch { /* A changing or detached buffer is not ready. */ }
    return null;
  };
  return {
    start: reset,
    reset,
    cancel() { active = false; },
    check({ target, duration, allowCurrent = false } = {}) {
      if (!active) return result(false, null, 'cancelled');
      if (complete) return result(false, null, 'complete');
      const at = now();
      if (!Number.isFinite(at)) return result(false, null, 'clock-unavailable');
      if (beganAt === null || at < beganAt) beganAt = at;
      const expired = at - beganAt >= maxWaitMs;
      const validClock = Number.isFinite(target) && target >= 0 && Number.isFinite(duration) && duration > 0;
      const position = validClock ? target % duration : null;
      const canStart = video.readyState >= 3 && !video.seeking;
      let reason = validClock ? 'buffering' : 'clock-unavailable';
      if (validClock) {
        if (deferredDuration !== null && deferredDuration !== duration) {
          deferredTarget = deferredDuration = null;
        }
        if (deferredTarget !== null && position < deferredTarget - duration / 2) {
          deferredTarget = deferredDuration = null;
        }
        // Short clips may never offer a full three-second range. They can
        // start from their available tail instead of missing a tiny wrap window.
        const longRecording = duration > headroomSeconds * 2;
        if (longRecording && duration - position < headroomSeconds && deferredTarget === null) {
          deferredTarget = position; deferredDuration = duration;
        }
        if (deferredTarget !== null) reason = 'next-loop';
        else {
          const needed = Math.min(headroomSeconds, duration - position);
          const safe = canStart ? covered(position, needed) : null;
          if (safe !== null) return result(true, safe, 'buffered');
          // Loading from the start of a loop can track the advancing room
          // clock without ever gaining the required headroom. Play appended
          // current data instead of chasing that moving target until
          // timeout. The controller keeps safe room correction armed at 1x.
          const current = video.currentTime;
          if (allowCurrent === true && canStart && Number.isFinite(current) && current >= 0 && current < duration && current <= position) {
            const currentNeeded = longRecording ? headroomSeconds : Math.min(headroomSeconds, duration - current);
            const safeCurrent = covered(current, currentNeeded);
            if (safeCurrent !== null) return result(true, safeCurrent, 'buffered-current');
          }
        }
      }
      if (expired) {
        const minimum = Number.isFinite(duration) && duration > 0 ? Math.min(1, duration / 2) : 1;
        const safe = canStart ? covered(video.currentTime, minimum) : null;
        if (safe !== null) return result(true, safe, 'timeout-current');
        return result(false, null, 'timeout-unbuffered');
      }
      return result(false, reason === 'next-loop' ? 0 : position, reason);
    },
  };
}
