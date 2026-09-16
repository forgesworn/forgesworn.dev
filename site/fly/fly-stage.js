import { motorSampleAt, PLAYBACK_SLOWDOWN } from './motor.js';
import { BodyController } from './body-controller.js?v=4';
import { createFlyBody } from './fly-body.js?v=4';
import { SceneDirector } from './scene-director.js?v=4';
const ZERO = [0, 0, 0, 0, 0, 0, 0];
const labels = { rest: 'Resting', forward: 'Exploring', backward: 'Backing away', turn: 'Turning', feed: 'Drinking the sugar', swallow: 'Swallowing', sing: 'Wing song', takeoff: 'Taking off', flight: 'Flying', landing: 'Landing', groom: 'Grooming', share: 'Bringing up a drop' };

export function createFlyStage({ canvas, box, status, pause, previewButtons, returnButton }) {
  const body = new BodyController(), motion = matchMedia('(prefers-reduced-motion: reduce)');
  const scene = new SceneDirector(); let ambient = true;
  let view = null, latest = null, playback = null, demo = null, onPoke = null, failed = false;
  let paused = motion.matches, visible = true, raf = 0, previous = 0, time = 0, elapsed = 0;
  let source = 'Animated behaviour', sample = ZERO, finishing = false, giftTime = 0;
  let pendingReport = false, pendingGift = false;
  function announce() {
    if (failed) {
      status.textContent = '3D view unavailable in this browser. Brain reports are still shown below.';
      box.dataset.motion = 'unavailable'; return;
    }
    const mode = demo === 'groom' ? 'groom' : giftTime > 0 ? 'share' : body.mode;
    const description = `${source} · ${labels[mode]}${paused ? ' · paused' : ''}`;
    if (status.textContent !== description) status.textContent = description;
    canvas.setAttribute('aria-label', `Articulated fruit fly. ${labels[mode]}. ${source}.`);
    box.dataset.motion = paused ? 'paused' : mode;
    box.dataset.motor = sample.slice(0, 6).map(n => Math.round(n * 100)).join(',');
    box.dataset.turnBalance = String(Math.round(sample[6] * 100));
    box.dataset.position = body.x.toFixed(5);
    box.dataset.altitude = body.z.toFixed(5);
    box.dataset.gaitPhase = body.phase.toFixed(5);
    box.dataset.activitySource = ambient ? scene.meal ? 'interaction' : 'ambient' : 'brain-or-preview';
    box.dataset.food = scene.food.toFixed(3); box.dataset.drop = scene.share.toFixed(3);
    const feedButton = document.querySelector('#feed-drop');
    if (feedButton) { feedButton.disabled = Boolean(scene.meal); feedButton.textContent = scene.meal ? 'Feeding…' : 'Feed a drop'; }
    pause.textContent = paused ? 'Play motion' : 'Pause motion'; pause.setAttribute('aria-pressed', String(paused));
  }
  function draw() {
    view?.pose(body, time, { groom: demo === 'groom' || ambient && scene.mode === 'groom',
      food: ambient ? scene.food : 0, share: ambient ? scene.share : giftTime > 0 ? Math.min(1, giftTime / 1.3) : 0,
      release: ambient ? scene.release : 0 });
    if (view) box.dataset.framed = String(view.framed());
    announce();
  }
  function clear() {
    playback = null; demo = null; elapsed = 0; finishing = false; giftTime = 0; sample = ZERO; body.reset();
    ambient = false; scene.meal = scene.home = null; scene.food = scene.share = scene.release = 0;
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
    if (latest) { playback = latest; if (paused) representative(latest); } else roam();
    draw(); wake();
  }
  function report(value, replay = true) {
    latest = value;
    if (!replay) return;
    // A quiet result is still visible in the report panel. It must not freeze
    // the visitor's exploring cycle just because no motor channel fired.
    if (value && !value.samples.some(s => s.slice(0, 6).some(Boolean))) return;
    if (value && scene.meal) pendingReport = true;
    else if (value && !demo) playLatest();
  }
  function roam() {
    body.reset(); ambient = true; scene.resume(body);
    source = 'Animated behaviour';
  }
  function feed(origin = 'Sugar drop · visual interaction', gift = false) {
    if (scene.meal) return;
    playback = null; demo = null; finishing = false; giftTime = 0; sample = ZERO;
    ambient = true; source = origin; scene.feed(body, gift);
    if (paused) scene.step(body, gift ? 2 : 2.2);
    draw(); wake();
  }
  function gift() {
    if (scene.meal) pendingGift = true;
    else feed('Reported corn gift · regurgitation illustration', true);
  }
  function recording(value, name) {
    clear(); demo = 'recording'; playback = value;
    source = `Recorded brain response · ${name} · ${PLAYBACK_SLOWDOWN}× slower`;
    if (paused) representative(value);
    draw(); wake();
  }
  function preview(mode) {
    clear(); demo = mode; source = 'Body demonstration · not brain activity';
    sample = mode === 'flight' ? [1,0,0,0,0,0,0] : mode === 'feed' ? [0,1,0,0,0,0,0] : mode === 'walk' ? [0,0,1,0,0,0,0] : ZERO;
    if (mode === 'share') giftTime = .001;
    if (paused) { body.step(sample, .3); if (giftTime) giftTime = 1; }
    for (const b of previewButtons) b.setAttribute('aria-pressed', String(b.dataset.flyPreview === mode));
    draw(); wake();
  }
  function update(dt) {
    time += dt; elapsed += dt;
    if (ambient) {
      const wasMeal = Boolean(scene.meal); scene.step(body, dt);
      if (wasMeal && !scene.meal) {
        source = 'Animated behaviour';
        if (pendingGift) { pendingGift = false; gift(); }
        else if (pendingReport) { pendingReport = false; playLatest(); }
      }
      return;
    }
    if (playback) {
      if (elapsed * 1000 < playback.windowMs * PLAYBACK_SLOWDOWN) sample = motorSampleAt(playback, elapsed);
      else { playback = null; demo = null; sample = ZERO; body.finish(); finishing = true; }
    } else if (demo && elapsed > 3.5) { demo = null; sample = ZERO; body.finish(); finishing = true; }
    if (giftTime) { giftTime += dt; if (giftTime > 3.5) { giftTime = 0; body.finish(); finishing = true; } }
    body.step(sample, dt);
    if (finishing && body.mode === 'rest') {
      finishing = false;
      for (const b of previewButtons) b.setAttribute('aria-pressed', 'false');
      roam();
    }
  }
  function frame(stamp) {
    raf = 0; if (paused || !visible || document.hidden) return;
    const dt = Math.min((stamp - (previous || stamp)) / 1000, .1); previous = stamp;
    update(dt); draw();
    if (ambient || playback || demo || finishing || giftTime) raf = requestAnimationFrame(frame);
  }
  function wake() { previous = 0; if (!raf && view && !paused && visible && !document.hidden && (ambient || playback || demo || finishing || giftTime)) raf = requestAnimationFrame(frame); }
  function setPaused(value) {
    paused = value; if (paused) { cancelAnimationFrame(raf); raf = 0; } else wake(); announce();
  }
  for (const b of previewButtons) b.addEventListener('click', () => preview(b.dataset.flyPreview));
  returnButton?.addEventListener('click', playLatest);
  pause.addEventListener('click', () => setPaused(!paused));
  motion.addEventListener('change', e => setPaused(e.matches));
  const poke = () => onPoke?.();
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake(); });
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (!visible) { cancelAnimationFrame(raf); raf = 0; } else wake();
  }).observe(box);
  function resize() { const r = box.getBoundingClientRect(); scene.limit = r.width < 600 ? .11 : .22; body.limitX = scene.limit; view?.resize(r.width, r.height); draw(); }
  new ResizeObserver(resize).observe(box);
  announce();
  createFlyBody(canvas).then(result => {
    view = result; resize(); box.dataset.artwork = 'ready'; box.dataset.renderer = 'articulated'; wake();
  }).catch(() => {
    failed = true; box.dataset.artwork = 'failed'; announce();
    canvas.style.background = 'center / contain no-repeat url(emblem-1024.png)';
    pause.disabled = true;
  });
  return { report, recording, gift, feed, poke, setSplatHandler: fn => { onPoke = fn; } };
}
