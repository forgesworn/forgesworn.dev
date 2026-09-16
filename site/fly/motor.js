export const MOTOR_CHANNELS = ['escape', 'feed', 'forward', 'turn', 'backward', 'song'];
export const PLAYBACK_SLOWDOWN = 10;
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

// The fly's own tags: ["replay", seed, bundle, image] and ["motor", json].
// Replies before 16 September 2026 carried them as `Replay:` and `Motor:` lines
// in the text, which is still read for older notes.
function carried(source) {
  if (source && typeof source === 'object' && Array.isArray(source.tags)) {
    const named = name => source.tags.filter(t => Array.isArray(t) && t[0] === name);
    const motor = named('motor'), replay = named('replay');
    if (motor.length || replay.length) {
      if (motor.length !== 1 || replay.length !== 1 || typeof motor[0][1] !== 'string' || motor[0][1].length > 8000) return null;
      return { motor: motor[0][1], replay: replay[0].slice(1) };
    }
    source = source.content;
  }
  if (typeof source !== 'string' || source.length > 8000) return null;
  const lines = source.split('\n').filter(line => line.startsWith('Motor: '));
  if (lines.length !== 1) return null;
  const seed = /^Replay: seed ([0-9a-f]{8})\b/m.exec(source)?.[1];
  const bundle = /^Replay: .*\bbundle ([0-9a-f]+)/m.exec(source)?.[1];
  const image = /^Replay: .*\bimage ([0-9a-f]+)/m.exec(source)?.[1];
  return { motor: lines[0].slice(7), replay: [seed, bundle, image].filter(Boolean) };
}

// "seed 7f3a2c10, bundle 95bfdd34, image 99c6a3c4", for people who want to rerun it.
export function replayLine(source) {
  const replay = source && typeof source === 'object' && Array.isArray(source.tags)
    ? source.tags.find(t => Array.isArray(t) && t[0] === 'replay')?.slice(1)
    : null;
  if (replay) return ['seed', 'bundle', 'image'].map((k, i) => typeof replay[i] === 'string' ? `${k} ${replay[i].slice(0, 8)}` : null).filter(Boolean).join(', ');
  const line = typeof source?.content === 'string' ? source.content.split('\n').find(l => l.startsWith('Replay: ')) : null;
  return line ? line.slice(8).replace(/\.$/, '') : null;
}

// Parsing is separate from Nostr signature verification. Invalid or older reports
// never fall back to guessing movement from prose. Pass the whole event.
export function parseMotorReport(source) {
  const found = carried(source);
  if (!found) return null;
  try {
    const m = JSON.parse(found.motor);
    if (!m || m.v !== 1 || !integer(m.windowMs, 50, 1000) || m.stepMs !== 50 || !integer(m.seed, 0, 0xffffffff)) return null;
    if (JSON.stringify(m.channels) !== JSON.stringify(MOTOR_CHANNELS) || JSON.stringify(m.sides) !== '["L","R","X"]') return null;
    for (const key of ['neurons', 'spikes', 'baseline']) {
      if (!Array.isArray(m[key]) || m[key].length !== 6 || m[key].some(row => !Array.isArray(row) || row.length !== 3 || row.some(n => !integer(n, 0, 200000000)))) return null;
    }
    for (let c = 0; c < 6; c++) for (let s = 0; s < 3; s++) {
      if (m.neurons[c][s] > 200000 || m.spikes[c][s] > m.neurons[c][s] * m.windowMs || m.baseline[c][s] > m.neurons[c][s] * m.windowMs) return null;
    }
    if (!Array.isArray(m.samples) || m.samples.length !== Math.ceil(m.windowMs / m.stepMs)) return null;
    const active = m.neurons.map((row, c) => m.spikes[c].reduce((a, b) => a + b, 0) - m.baseline[c].reduce((a, b) => a + b, 0) >= Math.max(3, row.reduce((a, b) => a + b, 0) * m.windowMs / 50));
    for (const sample of m.samples) {
      if (!Array.isArray(sample) || sample.length !== 7 || sample.some((n, i) => !integer(n, i === 6 ? -100 : 0, 100))) return null;
      if (sample.slice(0, 6).some((n, c) => n > 0 && !active[c]) || (!sample[3] && sample[6])) return null;
    }
    const seed = found.replay[0];
    if (typeof seed !== 'string' || !/^[0-9a-f]{8}$/.test(seed) || parseInt(seed, 16) !== m.seed) return null;
    return m;
  } catch { return null; }
}

export function motorSampleAt(report, elapsedSeconds) {
  const ms = elapsedSeconds * 1000 / PLAYBACK_SLOWDOWN;
  if (!Number.isFinite(ms) || ms < 0 || ms >= report.windowMs) return [0, 0, 0, 0, 0, 0, 0];
  return report.samples[Math.floor(ms / report.stepMs)].map(n => n / 100);
}

export function motorSummary(report) {
  const words = ['escape', 'proboscis', 'forward walking', 'turning', 'backward walking', 'song'];
  const driven = words.filter((_, c) => report.samples.some(row => row[c] > 0));
  return driven.length ? driven.join(', ') : 'no motor activity above baseline';
}
