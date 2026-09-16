import { motorSampleAt, PLAYBACK_SLOWDOWN } from './motor.js';
import { BodyController } from './body-controller.js';
import { createFlyBody } from './fly-body.js';
const ZERO = [0, 0, 0, 0, 0, 0, 0];
const labels = { rest: 'Resting', forward: 'Walking', backward: 'Backing away', turn: 'Turning', feed: 'Feeding', sing: 'Wing song', takeoff: 'Taking off', flight: 'Flying', landing: 'Landing', groom: 'Grooming', share: 'Regurgitating a drop' };

export function createFlyStage({ canvas, box, status, pause, previewButtons, returnButton }) {
  const body = new BodyController(), motion = matchMedia('(prefers-reduced-motion: reduce)');
  let view = null, latest = null, playback = null, demo = null, onPoke = null;
  let paused = motion.matches, visible = true, raf = 0, previous = 0, time = 0, elapsed = 0;
  let source = 'Waiting for a motor report', sample = ZERO, finishing = false, giftTime = 0;
  let completion = 'Brain replay complete · waiting for the next report';
  function announce() {
    const mode = demo === 'groom' ? 'groom' : giftTime > 0 ? 'share' : body.mode;
    status.textContent = `${source} · ${labels[mode]}${paused ? ' · paused' : ''}`;
    canvas.setAttribute('aria-label', `Articulated fruit fly. ${labels[mode]}. ${source}.`);
    box.dataset.motion = paused ? 'paused' : mode;
    box.dataset.motor = sample.slice(0, 6).map(n => Math.round(n * 100)).join(',');
    box.dataset.turnBalance = String(Math.round(sample[6] * 100));
    box.dataset.position = body.x.toFixed(5);
    box.dataset.altitude = body.z.toFixed(5);
    box.dataset.gaitPhase = body.phase.toFixed(5);
    pause.textContent = paused ? 'Play motion' : 'Pause motion'; pause.setAttribute('aria-pressed', String(paused));
  }
  function draw() {
    view?.pose(body, time, { groom: demo === 'groom', share: giftTime > 0 ? Math.min(1, giftTime / 1.3) : 0 });
    if (view) box.dataset.framed = String(view.framed());
    announce();
  }
  function clear() {
    playback = null; demo = null; elapsed = 0; finishing = false; giftTime = 0; sample = ZERO; body.reset();
    completion = 'Brain replay complete · waiting for the next report';
    for (const b of previewButtons) b.setAttribute('aria-pressed', 'false');
  }
  function representative(report) {
    const index = report.samples.findIndex(s => s.slice(0, 6).some(Boolean));
    sample = (report.samples[Math.max(0, index)] || ZERO).map(n => n / 100);
    body.step(sample, .3);
  }
  function playLatest() {
    clear();
    source = latest ? `Brain replay · ${PLAYBACK_SLOWDOWN}× slower` : 'No motor telemetry in the latest report';
    if (latest) { playback = latest; if (paused) representative(latest); }
    draw(); wake();
  }
  function report(value) { latest = value; if (!demo) playLatest(); }
  function gift() { if (demo) return; clear(); source = 'Reported gift · illustrated regurgitation'; completion = 'Gift illustration complete · waiting for a motor report'; giftTime = .001; draw(); wake(); }
  function recording(value, name) {
    clear(); demo = 'recording'; playback = value;
    source = `Recorded brain response · ${name} · ${PLAYBACK_SLOWDOWN}× slower`;
    completion = 'Recorded brain replay complete · use Replay latest brain report for live activity';
    if (paused) representative(value);
    draw(); wake();
  }
  function preview(mode) {
    clear(); demo = mode; source = 'Body demonstration · not brain activity';
    completion = 'Body demonstration complete · not brain activity';
    sample = mode === 'flight' ? [1,0,0,0,0,0,0] : mode === 'feed' ? [0,1,0,0,0,0,0] : mode === 'walk' ? [0,0,1,0,0,0,0] : ZERO;
    if (mode === 'share') giftTime = .001;
    if (paused) { body.step(sample, .3); if (giftTime) giftTime = 1; }
    for (const b of previewButtons) b.setAttribute('aria-pressed', String(b.dataset.flyPreview === mode));
    draw(); wake();
  }
  function update(dt) {
    time += dt; elapsed += dt;
    if (playback) {
      if (elapsed * 1000 < playback.windowMs * PLAYBACK_SLOWDOWN) sample = motorSampleAt(playback, elapsed);
      else { playback = null; demo = null; sample = ZERO; body.finish(); finishing = true; }
    } else if (demo && elapsed > 3.5) { demo = null; sample = ZERO; body.finish(); finishing = true; }
    if (giftTime) { giftTime += dt; if (giftTime > 3.5) { giftTime = 0; body.finish(); finishing = true; } }
    body.step(sample, dt);
    if (finishing && body.mode === 'rest') {
      finishing = false; source = completion;
      for (const b of previewButtons) b.setAttribute('aria-pressed', 'false');
    }
  }
  function frame(stamp) {
    raf = 0; if (paused || !visible || document.hidden) return;
    const dt = Math.min((stamp - (previous || stamp)) / 1000, .1); previous = stamp;
    update(dt); draw();
    if (playback || demo || finishing || giftTime) raf = requestAnimationFrame(frame);
  }
  function wake() { previous = 0; if (!raf && view && !paused && visible && !document.hidden && (playback || demo || finishing || giftTime)) raf = requestAnimationFrame(frame); }
  function setPaused(value) {
    paused = value; if (paused) { cancelAnimationFrame(raf); raf = 0; } else wake(); announce();
  }
  for (const b of previewButtons) b.addEventListener('click', () => preview(b.dataset.flyPreview));
  returnButton?.addEventListener('click', playLatest);
  pause.addEventListener('click', () => setPaused(!paused));
  motion.addEventListener('change', e => setPaused(e.matches));
  const poke = () => onPoke?.();
  canvas.addEventListener('pointerdown', e => { if (e.button === 0 && e.isPrimary) poke(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake(); });
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) { cancelAnimationFrame(raf); raf = 0; } else wake();
  }).observe(box);
  function resize() { const r = box.getBoundingClientRect(); view?.resize(r.width, r.height); draw(); }
  new ResizeObserver(resize).observe(box);
  announce();
  createFlyBody(canvas).then(result => {
    view = result; resize(); box.dataset.artwork = 'ready'; box.dataset.renderer = 'articulated'; wake();
  }).catch(() => {
    box.dataset.artwork = 'failed'; status.textContent = '3D view unavailable in this browser. Brain reports are still shown below.';
    canvas.style.background = 'center / contain no-repeat url(emblem-1024.png)';
    pause.disabled = true;
  });
  return { report, recording, gift, poke, setSplatHandler: fn => { onPoke = fn; } };
}
