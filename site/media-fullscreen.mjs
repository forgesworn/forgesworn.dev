// Fullscreen changes presentation only. The existing player and its session
// remain mounted, including when Escape or a native mobile control exits.
export function attachFullscreen({ container, video, button, onError = () => {} }) {
  if (!container || !video || !button) return () => {};
  const doc = container.ownerDocument;
  let owned = false;
  const active = () => {
    const element = doc.fullscreenElement ?? doc.webkitFullscreenElement;
    return Boolean(element && (element === container || container.contains(element)) || video.webkitDisplayingFullscreen);
  };
  const update = () => {
    const wasOwned = owned;
    owned = active();
    button.textContent = owned ? 'Back to stats' : 'Full screen';
    button.setAttribute('aria-pressed', String(owned));
    if (wasOwned && !owned) button.focus({ preventScroll: true });
  };
  const toggle = async () => {
    try {
      if (active()) {
        if (doc.fullscreenElement && doc.exitFullscreen) await doc.exitFullscreen();
        else if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
        else if (video.webkitExitFullscreen) video.webkitExitFullscreen();
      } else if (container.requestFullscreen) await container.requestFullscreen();
      else if (container.webkitRequestFullscreen) await container.webkitRequestFullscreen();
      else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
      else throw new Error('Fullscreen unavailable');
      update();
    } catch { onError('Full screen is unavailable in this browser.'); }
  };
  const click = () => { void toggle(); };
  const docEvents = ['fullscreenchange', 'webkitfullscreenchange'];
  const videoEvents = ['webkitbeginfullscreen', 'webkitendfullscreen'];
  for (const name of docEvents) doc.addEventListener(name, update);
  for (const name of videoEvents) video.addEventListener(name, update);
  button.addEventListener('click', click);
  button.hidden = !(container.requestFullscreen || container.webkitRequestFullscreen || video.webkitEnterFullscreen);
  update();
  return () => {
    for (const name of docEvents) doc.removeEventListener(name, update);
    for (const name of videoEvents) video.removeEventListener(name, update);
    button.removeEventListener('click', click);
  };
}
