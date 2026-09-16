// High-level illustration controller. Neural samples choose the action; these
// bounded transitions and gait timing are engineered, not simulated neurons.
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const approach = (x, target, dt, rate) => x + (target - x) * (1 - Math.exp(-dt * rate));
export class BodyController {
  constructor() {
    this.x = 0; this.y = 0; this.z = 0; this.heading = 0;
    this.phase = 0; this.speed = 0; this.feed = 0; this.song = 0;
    this.air = 0; this.bank = 0; this.pitch = 0; this.mode = 'rest';
    this.escapeLatched = false; this.finishing = false; this.landingTime = 0;
  }
  reset() {
    this.speed = this.feed = this.song = this.bank = this.pitch = this.air = this.z = 0;
    this.mode = 'rest'; this.escapeLatched = this.finishing = false; this.landingTime = 0;
  }
  finish() {
    this.finishing = true;
    if (!this.escapeLatched) this.reset();
  }
  step(sample, dt) {
    const [escape, feed, forward, turn, backward, song, balance] = sample;
    if (escape > 0 && !this.finishing) this.escapeLatched = true;
    const airborne = this.escapeLatched && !this.finishing;
    this.air = approach(this.air, airborne ? 1 : 0, dt, airborne ? 4 : 3.5);
    this.feed = approach(this.feed, this.escapeLatched ? 0 : feed, dt, 14);
    this.song = song;
    if (turn && balance) {
      const target = balance < 0 ? Math.PI : 0;
      const error = Math.atan2(Math.sin(target - this.heading), Math.cos(target - this.heading));
      this.heading += error * Math.min(1, dt * (3 + turn * 5));
    }
    const drive = forward - backward;
    this.speed = approach(this.speed, this.finishing ? 0 : this.escapeLatched ? .22 : drive * .14, dt, 12);
    const oldX = this.x, oldY = this.y;
    this.x = clamp(this.x + Math.cos(this.heading) * this.speed * dt, -.38, .38);
    this.y = clamp(this.y + Math.sin(this.heading) * this.speed * dt, -.15, .15);
    const travelled = Math.hypot(this.x - oldX, this.y - oldY);
    this.phase += travelled / .042;
    if (dt > 0) this.speed = Math.sign(this.speed) * travelled / dt;
    this.z = this.air * .25;
    this.pitch = approach(this.pitch, airborne ? -.5 : 0, dt, 5);
    this.bank = approach(this.bank, turn * balance * .3 * this.air, dt, 5);
    if (this.finishing && this.escapeLatched) {
      this.landingTime += dt;
      this.mode = 'landing';
      if (this.landingTime >= 1.6) this.reset();
    } else this.mode = this.escapeLatched ? this.air < .7 ? 'takeoff' : 'flight'
      : Math.abs(this.speed) > .004 ? this.speed < 0 ? 'backward' : 'forward'
      : turn ? 'turn' : feed ? 'feed' : song ? 'sing' : 'rest';
    return this;
  }
}
