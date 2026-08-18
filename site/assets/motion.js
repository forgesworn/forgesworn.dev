/*
 * Motion for forgesworn.dev.
 *
 * Everything here is an enhancement layered on top of a page that already
 * works without it. The inline script at the end of the document owns the
 * baseline reveal (an IntersectionObserver that adds `.visible`); if this
 * file or its vendored anime.js fails to load, that baseline still runs and
 * nothing is left hidden.
 *
 * Three jobs, none of which the CSS can do on its own:
 *   1. counting the hero stats up from zero
 *   2. drawing the stack-map connectors as the map arrives
 *   3. cascading grids of more than eight cards, where the CSS delay ladder
 *      runs out and every card past the eighth fires at once
 *
 * Load order matters: this runs before the inline script so that job 3 can
 * claim its containers before the observer sees them.
 */
(function () {
  'use strict';

  if (!window.anime) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var animate = anime.animate;
  var stagger = anime.stagger;
  var onScroll = anime.onScroll;

  // Play an animation once, the first time its target scrolls into view, then
  // leave it alone.
  //
  // The animation is deliberately NOT handed to the observer as `autoplay`.
  // A scroll-linked animation is paused by anime when its target leaves the
  // viewport, so scrolling past a section at reading speed strands the
  // cascade at whatever opacity each card had reached and it never recovers.
  // Triggering playback and then letting the animation run on its own clock
  // is the difference between "reveals as you arrive" and "half the grid is
  // permanently at 60% opacity".
  //
  // Enter when the target's top has risen 60px above the viewport's bottom
  // edge, so a section is committed to being on screen before it starts.
  function playOnceInView(target, animation) {
    onScroll({
      target: target,
      enter: { target: 'top', container: 'bottom-=60' },
      repeat: false,
      onEnter: function () { animation.play(); }
    });
  }

  /* ---------------------------------------------------------------
     1. Hero stats
     The numbers are written into the markup by scripts/build-site.mjs, so
     they are read back out of the DOM rather than hardcoded here: whatever
     the catalogue says is what counts up.
     --------------------------------------------------------------- */
  function countUp() {
    document.querySelectorAll('.hero-stats .stat-value').forEach(function (el, i) {
      var target = parseInt(el.textContent.trim(), 10);
      if (!isFinite(target)) return;
      var counter = { n: 0 };
      el.textContent = '0';
      animate(counter, {
        n: target,
        duration: 1400,
        delay: 260 + i * 90,
        ease: 'out(3)',
        onUpdate: function () { el.textContent = String(Math.round(counter.n)); },
        // Land exactly on the catalogue's number rather than a rounded tween.
        onComplete: function () { el.textContent = String(target); }
      });
    });
  }

  /* ---------------------------------------------------------------
     2. Stack-map connectors
     The lines are positioned by updateSvgLines() in the inline script, which
     runs on load and on resize, so their geometry is not known until then.
     Each line is drawn once, and the dash attributes are stripped afterwards
     so a later resize repositions a clean, fully drawn line.
     --------------------------------------------------------------- */
  function drawConnectors() {
    var svg = document.querySelector('.stack-map-svg');
    var map = document.querySelector('.stack-map');
    if (!svg || !map) return;

    var lines = Array.prototype.slice.call(svg.querySelectorAll('line[data-from][data-to]'));
    if (!lines.length) return;

    lines.forEach(function (line) {
      var len = line.getTotalLength();
      if (!len) return;
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
    });

    playOnceInView(map, animate(lines, {
      strokeDashoffset: 0,
      duration: 900,
      delay: stagger(70),
      ease: 'inOut(2)',
      autoplay: false,
      onComplete: function () {
        lines.forEach(function (line) {
          line.style.strokeDasharray = '';
          line.style.strokeDashoffset = '';
        });
      }
    }));
  }

  /* ---------------------------------------------------------------
     3. Long grids
     .reveal-stagger's CSS ladder only reaches :nth-child(8); the ecosystem
     and tool grids are far longer, so everything past the eighth card lands
     with no delay at all. Those containers are claimed here and animated
     properly. Shorter ones are left to the CSS, which already handles them.
     --------------------------------------------------------------- */
  var CSS_LADDER_LENGTH = 8;

  function cascadeLongGrids() {
    document.querySelectorAll('.reveal-stagger').forEach(function (grid) {
      var children = Array.prototype.slice.call(grid.children);

      // The stack map's connector layer is an absolutely positioned overlay
      // sitting on top of its grid, not a cell in it. Sliding it with the
      // cards would drag every line off the boxes it joins, so overlays are
      // left out of the cascade.
      var cards = children.filter(function (el) {
        return getComputedStyle(el).position !== 'absolute';
      });
      var overlays = children.filter(function (el) { return cards.indexOf(el) === -1; });

      if (cards.length <= CSS_LADDER_LENGTH) return;

      // Taking the class off keeps the inline script's observer away from
      // this container, so the two never animate the same cards.
      grid.classList.remove('reveal-stagger');
      grid.classList.add('motion-cascade');

      // .motion-cascade hides every child. Anything not in the cascade has to
      // be handed back its visibility here, or it stays hidden for good.
      overlays.forEach(function (el) {
        el.style.opacity = '1';
        el.style.transform = 'none';
      });

      playOnceInView(grid, animate(cards, {
        opacity: [0, 1],
        y: [16, 0],
        duration: 620,
        delay: stagger(55),
        ease: 'out(3)',
        autoplay: false
      }));
    });
  }

  cascadeLongGrids();
  countUp();

  // updateSvgLines() is bound to window load, so the geometry is only settled
  // after it. Queue behind it rather than racing it.
  if (document.readyState === 'complete') drawConnectors();
  else window.addEventListener('load', function () { setTimeout(drawConnectors, 0); });
})();
