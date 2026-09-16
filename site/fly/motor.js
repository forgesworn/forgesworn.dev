export const MOTOR_CHANNELS = ['escape', 'feed', 'forward', 'turn', 'backward', 'song'];
export const PLAYBACK_SLOWDOWN = 10;
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

// Parsing is separate from Nostr signature verification. Invalid or older reports
// never fall back to guessing movement from prose.
export function parseMotorReport(content) {
  if (typeof content !== 'string' || content.length > 8000) return null;
  const lines = content.split('\n').filter(line => line.startsWith('Motor: '));
  if (lines.length !== 1) return null;
  try {
    const m = JSON.parse(lines[0].slice(7));
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
    const replay = /^Replay: seed ([0-9a-f]{8})\b/m.exec(content);
    if (!replay || parseInt(replay[1], 16) !== m.seed) return null;
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
