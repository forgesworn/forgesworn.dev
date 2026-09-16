// Artwork is generated offline. This renderer has no wallet, signer or network access.
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = t => t * t * (3 - 2 * t);
const POSES = { flight: 0, landing: 1, rest: 2, feed: 3, share: 4, groom: 5 };
// Registration measured from the final atlas, in 512px cell coordinates.
// Grounded poses share the same 175px pivot-to-contact distance after registration.
const PIVOTS = [[320, 280], [320, 300], [326, 300], [316, 225], [320, 225], [328, 235]];

export function behaviourOf(content) {
  // A public gift notice is emitted by the runtime, separately from brain prose.
  if (/Trophallaxis\. The fly brought up \d[\d,]* sats\b/.test(content) || content.includes('gave a drop')) return ['puke', 'Shared a drop.'];
  for (const [phrase, mode, label] of [
    ['startled', 'startled', 'Startled.'],
    ['extended its proboscis', 'fed', 'Fed. Proboscis out.'],
    ['backed away', 'backward', 'Backed away.'],
    ['sang', 'sing', 'Sang.'],
    ['turned', 'turn', 'Turned.'],
    ['walked forward', 'forward', 'Walked forward.'],
  ]) if (content.includes(phrase)) return [mode, label];
  return ['cruise', 'Resting.'];
}

export function createFlyStage({ canvas, box, status, pause, previewButtons }) {
  const ctx = canvas.getContext('2d');
  if (!ctx) { status.textContent = 'Animation unavailable.'; return { react() {}, feed() {}, poke() {}, setSplatHandler() {} }; }
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const atlas = new Image();
  atlas.src = new URL('./assets/fly-atlas-sunburst.png', import.meta.url).href;
  let ready = false, failed = false, width = 800, height = 460, size = 360;
  let time = 0, previous = 0, raf = 0, visible = true, paused = motion.matches;
  let onPoke = null, source = 'Ambient animation', pending = null;
  let state = 'rest', elapsed = 0, duration = 3.5, facing = 1, bank = 0, depth = 1;
  let x = 0, y = 0, startX = 0, startY = 0, endX = 0, endY = 0;
  let pose = POSES.rest, oldPose = pose, blend = 1;
  let drop = null, mealScale = 1;
  const ground = () => height * .81;
  const standingY = () => ground() - size * 175 / 512;
  const labels = { rest: 'Resting', groom: 'Grooming', flight: 'Flying', landing: 'Landing', takeoff: 'Taking off', feed: 'Feeding', share: 'Regurgitating a drop', startled: 'Startled', sing: 'Wing song', backward: 'Walking backwards', forward: 'Walking', turn: 'Turning' };

  function announce() {
    status.textContent = failed ? 'Artwork unavailable — reload to try again.' : `${source} · ${labels[state] || 'Resting'}${paused ? ' · paused' : ''}`;
    canvas.setAttribute('aria-label', `Animated fruit fly. ${labels[state] || 'Resting'}. Use the Poke the fly button to interact.`);
    box.dataset.motion = paused ? 'paused' : state;
    pause.textContent = paused ? 'Play motion' : 'Pause motion';
    pause.setAttribute('aria-pressed', String(paused));
  }
  function setPose(next) {
    if (next === pose) return;
    oldPose = pose; pose = next; blend = 0;
  }
  function enter(next, seconds = 3) {
    state = next; elapsed = 0; duration = seconds;
    startX = x; startY = y;
    const frame = { flight: 0, startled: 0, takeoff: 1, landing: 1, feed: 3, share: 4, groom: 5 }[next] ?? 2;
    setPose(frame);
    if (next === 'flight' || next === 'startled' || next === 'takeoff') {
      endX = width * (x > width * .5 ? .29 : .71);
      endY = Math.max(size * .34 + 32, height * (next === 'startled' ? .32 : .38 + Math.random() * .12));
      facing = endX > x ? 1 : -1;
    }
    if (next === 'landing') { endX = clamp(x + facing * width * .1, width * .3, width * .7); endY = standingY(); }
    if (next === 'feed' || next === 'share') {
      // The labellum and surface droplet meet; the droplet grows before it detaches.
      drop = { x: x + facing * size * 130 / 512, amount: next === 'feed' ? 1 : 0, scale: next === 'feed' ? mealScale : 1, life: 1 };
    }
    if (next === 'turn') facing *= -1;
    announce();
  }
  function resize() {
    const r = box.getBoundingClientRect(), oldWidth = width;
    width = r.width; height = r.height; size = Math.min(width * .7, 405);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    x = x ? x / oldWidth * width : width * .5;
    // Resizing never resumes a paused loop or leaves the fly below the surface.
    y = standingY(); startX = x; startY = y; endX = x; endY = y;
    if (drop) drop.x = x + facing * size * 130 / 512;
    draw();
  }
  function act(mode, origin) {
    source = origin;
    if (paused) {
      pending = null; depth = 1; x = width * .5; y = standingY();
      enter(mode, 4.5); blend = 1;
      if (mode === 'flight' || mode === 'startled') { depth = .68; y = height * .48; }
      if (drop) drop.amount = 1;
      draw(); return;
    }
    if (['feed', 'share', 'groom', 'rest', 'backward', 'forward', 'turn', 'sing'].includes(mode) && y < standingY() - 5) {
      pending = mode; enter('landing', 1.3);
    } else { pending = null; enter(mode, mode === 'startled' ? .65 : mode === 'flight' ? 3 : 4.5); }
    wake();
  }
  function react(word) {
    const mode = { fed: 'feed', puke: 'share', startled: 'startled', sing: 'sing', backward: 'backward', forward: 'forward', turn: 'turn' }[word];
    // Quiet notes do not interrupt an illustrative preview or make up a brain action.
    if (mode) act(mode, 'Latest reported behaviour');
  }
  function feed(sats) {
    mealScale = typeof sats === 'number' && sats > 0 ? .65 + clamp(Math.log10(sats + 1) / 5, 0, 1) * .7 : 1;
    act('feed', 'Incoming payment illustration');
  }
  function preview(mode) {
    mealScale = 1;
    act(mode, 'Animation preview');
    for (const button of previewButtons) button.setAttribute('aria-pressed', String(button.dataset.flyPreview === mode));
  }
  for (const button of previewButtons) button.addEventListener('click', () => preview(button.dataset.flyPreview));
  function poke() { act('startled', 'Local poke'); onPoke?.(); }
  canvas.addEventListener('pointerdown', e => { if (e.button === 0 && e.isPrimary) poke(); });
  pause.addEventListener('click', () => {
    paused = !paused;
    if (paused) { cancelAnimationFrame(raf); raf = 0; }
    else wake();
    announce(); draw();
  });
  motion.addEventListener('change', e => {
    paused = e.matches;
    if (paused) { cancelAnimationFrame(raf); raf = 0; enter('rest'); y = standingY(); blend = 1; }
    else wake();
    announce(); draw();
  });

  function update(dt) {
    time += dt; elapsed += dt; blend = Math.min(1, blend + dt * 9);
    const p = clamp(elapsed / duration, 0, 1), ease = smooth(p);
    if (['flight', 'startled', 'takeoff'].includes(state)) {
      depth = mix(depth, .68, 1 - Math.exp(-dt * 6));
      x = mix(startX, endX, ease); y = Math.max(size * depth * .52 + 20, mix(startY, endY, ease) - Math.sin(p * Math.PI) * height * .07);
      bank = Math.sin(p * Math.PI * 2) * .11;
      if (state === 'takeoff' && p > .25) setPose(POSES.flight);
    } else if (state === 'landing') {
      depth = mix(depth, 1, 1 - Math.exp(-dt * 4));
      x = mix(startX, endX, ease); y = mix(startY, endY, ease);
      bank *= Math.exp(-dt * 8);
      if (p > .8) setPose(POSES.rest);
    } else {
      depth = mix(depth, 1, 1 - Math.exp(-dt * 8));
      y = standingY(); bank *= Math.exp(-dt * 8);
      if (state === 'forward' || state === 'backward') x = clamp(x + facing * (state === 'backward' ? -1 : 1) * dt * 13, width * .25, width * .75);
      if (state === 'groom') setPose(Math.sin(time * 7) > -.65 ? POSES.groom : POSES.rest);
      if (state === 'feed' || state === 'share') {
        if (drop) drop.amount = state === 'feed' ? 1 - ease : smooth(clamp(p * 1.7, 0, 1));
        if (state === 'share' && p > .72) setPose(POSES.rest);
        if (state === 'feed' && p > .9) setPose(POSES.rest);
      }
    }
    if (drop && !['feed', 'share'].includes(state)) { drop.life -= dt * .22; if (drop.life <= 0) drop = null; }
    if (elapsed >= duration) {
      if (state === 'landing') { const next = pending || 'rest'; pending = null; enter(next, 4.5); }
      else if (state === 'flight') { pending = 'groom'; enter('landing', 1.5); }
      else if (state === 'takeoff' || state === 'startled') enter('flight', 3.2);
      else if (state === 'rest') { source = 'Ambient animation'; enter('takeoff', 1.2); }
      else {
        source = 'Ambient animation';
        for (const button of previewButtons) button.setAttribute('aria-pressed', 'false');
        enter('rest', 3 + Math.random() * 2);
      }
    }
  }

  function ellipse(cx, cy, rx, ry, fill) {
    ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }
  function drawDrop() {
    if (!drop || drop.amount <= .01) return;
    const radius = size * .029 * drop.scale * Math.cbrt(drop.amount);
    const cy = ground() - radius * .5;
    ctx.save(); ctx.globalAlpha = clamp(drop.life, 0, 1);
    const g = ctx.createRadialGradient(drop.x - radius * .3, cy - radius * .4, 0, drop.x, cy, radius);
    g.addColorStop(0, '#fff7d4'); g.addColorStop(.25, '#ead397'); g.addColorStop(.7, '#b6843c'); g.addColorStop(1, '#634526');
    ellipse(drop.x, cy, radius, radius * .72, g);
    ellipse(drop.x - radius * .28, cy - radius * .35, radius * .22, radius * .12, '#fff7e5');
    ctx.restore();
  }
  function sprite(frame, alpha) {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    const cellW = atlas.naturalWidth / 3, cellH = atlas.naturalHeight / 2;
    const [pivotX, pivotY] = PIVOTS[frame];
    if (frame === POSES.flight) {
      // Split the raised wings at their hinge, keeping the torso and legs steady.
      const hingeY = 238, hingeX = 305, scale = size / 512;
      ctx.drawImage(atlas, 0, hingeY, cellW, cellH - hingeY, -pivotX * scale, (hingeY - pivotY) * scale, size, (512 - hingeY) * scale);
      for (let pass = 0; pass < 3; pass++) {
        ctx.save(); ctx.globalAlpha = alpha * (pass === 0 ? .7 : .18);
        ctx.translate((hingeX - pivotX) * scale, (hingeY - pivotY) * scale);
        ctx.scale(1, .2 + Math.abs(Math.sin(time * 145 + pass * .9)) * .8);
        ctx.drawImage(atlas, 0, 0, cellW, hingeY, -hingeX * scale, -hingeY * scale, size, hingeY * scale);
        ctx.restore();
      }
      return;
    }
    ctx.drawImage(atlas, frame % 3 * cellW, Math.floor(frame / 3) * cellH, cellW, cellH, -size * pivotX / 512, -size * pivotY / 512, size, size);
  }
  function draw() {
    ctx.clearRect(0, 0, width, height);
    const gy = ground();
    // A quiet optical stage: a soft pool of light, surface, depth, and contact shadow.
    const light = ctx.createRadialGradient(width * .53, height * .44, 0, width * .5, height * .5, width * .62);
    light.addColorStop(0, '#344138'); light.addColorStop(.5, '#19251e'); light.addColorStop(1, '#0a100d');
    ctx.fillStyle = light; ctx.fillRect(0, 0, width, height);
    const floor = ctx.createLinearGradient(0, gy, 0, height);
    floor.addColorStop(0, '#58614a'); floor.addColorStop(.014, '#2e392c'); floor.addColorStop(1, '#111a13');
    ctx.fillStyle = floor; ctx.fillRect(0, gy, width, height - gy);
    ctx.strokeStyle = 'rgba(220,226,195,.1)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
    const altitude = clamp((standingY() - y) / height, 0, 1);
    ctx.save(); ctx.filter = `blur(${3 + altitude * 16}px)`;
    ellipse(x, gy + 3, size * (.19 + altitude * .15), size * .015, `rgba(0,0,0,${.52 - altitude * .4})`);
    ctx.restore();
    drawDrop();
    if (ready) {
      ctx.save(); ctx.translate(x, y); ctx.scale(facing * depth, depth); ctx.rotate(bank);
      const airborne = ['flight', 'takeoff', 'startled'].includes(state) || state === 'landing' && elapsed / duration < .7;
      // Wing persistence is rendered independently of the body: no whole-fly flashing.
      if (airborne || state === 'sing') {
        ctx.save(); ctx.globalCompositeOperation = 'screen';
        for (let i = 0; i < 4; i++) {
          ctx.save(); ctx.translate(-size * .025, -size * .015);
          ctx.rotate(-.5 - i * .22 + Math.sin(time * 115 + i) * .11);
          ellipse(-size * .1, -size * .04, size * .17, size * (.017 + i * .006), `rgba(205,225,220,${.07 - i * .01})`);
          ctx.restore();
        }
        ctx.restore();
      }
      if (blend < 1) sprite(oldPose, 1 - smooth(blend));
      sprite(pose, smooth(blend));
      ctx.restore();
    } else {
      ctx.fillStyle = '#c4cbb7'; ctx.font = '14px Inter, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(failed ? 'The fly artwork could not load.' : 'Bringing the fly into focus…', width / 2, height / 2);
    }
  }
  function frame(stamp) {
    raf = 0;
    if (paused || !visible || document.hidden) return;
    const dt = Math.min((stamp - (previous || stamp)) / 1000, .04); previous = stamp;
    update(dt); draw(); raf = requestAnimationFrame(frame);
  }
  function wake() { previous = 0; if (!raf && !paused && visible && !document.hidden && ready) raf = requestAnimationFrame(frame); }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake();
  });
  const observer = new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) { cancelAnimationFrame(raf); raf = 0; } else wake();
  });
  observer.observe(box);
  new ResizeObserver(resize).observe(box);
  atlas.onload = () => { ready = true; box.dataset.artwork = 'ready'; draw(); wake(); };
  atlas.onerror = () => { failed = true; box.dataset.artwork = 'failed'; announce(); draw(); };
  resize(); announce();
  return { react, feed, poke, setSplatHandler: fn => { onPoke = fn; } };
}
