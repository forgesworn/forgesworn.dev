// Engineered display stroke in FlyBody's yaw/roll/pitch joint coordinates.
// Sweep and feathering are a quarter-cycle apart. This is not measured wing data.
export const WING_SAMPLES = 64;
export const FOLDED_WING = [1.5, .7, -1];
export function wingStroke(phase) {
  const a = phase * Math.PI * 2;
  return [.3 - 1.1 * Math.cos(a), -.1 + .16 * Math.sin(2 * a), .8 + 1.1 * Math.tanh(3 * Math.sin(a))];
}
export function wingDeployment(air) {
  const t = Math.max(0, Math.min(1, air / .22));
  return t * t * (3 - 2 * t);
}
