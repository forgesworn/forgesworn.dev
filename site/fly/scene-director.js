// Authored visitor experience, separate from signed neural telemetry. No I/O.
const smooth = x => { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
const mix = (a, b, t) => a + (b - a) * t;
function approach(body, origin, t) {
  const arrive = smooth((t - .35) / .85);
  body.x = mix(origin.x, 0, arrive); body.y = mix(origin.y, 0, arrive);
  body.z = mix(origin.z, 0, arrive);
  const heading = Math.hypot(origin.x, origin.y) > .01 ? Math.atan2(-origin.y, -origin.x) : origin.heading;
  const turn = Math.atan2(Math.sin(heading - origin.heading), Math.cos(heading - origin.heading));
  body.heading = t < 1.2 ? origin.heading + turn * smooth(t / .35)
    : mix(origin.heading + turn, 0, smooth((t - 1.2) / .4));
  body.air = Math.min(1, body.z / .16);
  return origin.z > .02 ? 'landing' : t < .35 || t > 1.2 ? 'turn' : 'forward';
}
export class SceneDirector {
  constructor() { this.time = 0; this.meal = null; this.home = null; this.limit = .2; this.mode = 'forward'; this.food = 0; this.share = 0; this.release = 0; }
  resume(body) { this.time = 0; this.home = { x: body.x, y: body.y, z: body.z, heading: body.heading }; }
  feed(body, gift = false) {
    this.home = null;
    this.meal = { time: 0, x: body.x, y: body.y, z: body.z, heading: body.heading, gift };
  }
  step(body, dt) {
    const oldX = body.x, oldY = body.y, oldHeading = body.heading;
    this.time += dt; this.food = this.share = this.release = 0;
    body.feed = 0; body.song = 0; body.bank = 0;
    if (this.home) {
      this.mode = approach(body, this.home, this.time);
      if (this.time >= 1.6) { this.home = null; this.time = 0; }
    } else if (this.meal) {
      const m = this.meal; m.time += dt; const t = m.time;
      const arriving = approach(body, m, t);
      this.food = m.gift ? 0 : 1;
      if (t < 1.6) this.mode = arriving;
      else if (t < 4.2 && !m.gift) {
        this.mode = 'feed'; body.feed = smooth((t - 1.6) / .35);
        this.food = 1 - smooth((t - 1.9) / 2.3);
      } else if (t < 4.9 && !m.gift) { this.mode = 'swallow'; this.food = 0; }
      else {
        const spit = m.gift ? t - 1.6 : t - 4.9;
        this.food = 0; this.mode = 'share'; body.feed = 1;
        this.share = smooth(spit / 1.5);
        this.release = smooth((spit - 1.5) / .65);
        if (spit > 2.25) { body.feed = 1 - smooth((spit - 2.25) / .4); this.mode = 'rest'; }
        if (spit > 3.1) { this.meal = null; this.time = 0; }
      }
    } else {
      const t = this.time % 16, a = this.limit;
      if (t < 3) {
        this.mode = 'forward'; body.x = mix(0, a, smooth(t / 3)); body.z = 0; body.heading = 0;
      } else if (t < 4) {
        this.mode = 'takeoff'; body.x = a; body.z = .16 * smooth(t - 3); body.heading = Math.PI * smooth(t - 3);
      } else if (t < 8) {
        this.mode = 'flight'; const p = (t - 4) / 4;
        body.x = mix(a, -a, smooth(p)); body.z = .16 + Math.sin(p * Math.PI) * .055; body.heading = Math.PI;
        body.bank = Math.sin(p * Math.PI * 2) * .15;
      } else if (t < 9.5) {
        this.mode = 'landing'; body.x = -a; body.z = .16 * (1 - smooth((t - 8) / 1.5)); body.heading = Math.PI;
      } else if (t < 10.5) {
        this.mode = 'turn'; body.x = -a; body.z = 0; body.heading = Math.PI * (1 - smooth(t - 9.5));
      } else if (t < 14) {
        this.mode = 'forward'; body.x = mix(-a, 0, smooth((t - 10.5) / 3.5)); body.z = 0; body.heading = 0;
      } else { this.mode = 'groom'; body.x = 0; body.z = 0; body.heading = 0; }
      body.y = 0; body.air = Math.min(1, body.z / .16);
    }
    body.pitch = -.28 * body.air;
    const distance = Math.hypot(body.x - oldX, body.y - oldY) + (body.air < .12 ? Math.abs(body.heading - oldHeading) * .06 : 0);
    body.speed = dt > 0 ? distance / dt : 0;
    body.phase += distance / .042;
    body.mode = this.mode;
    return this;
  }
}
