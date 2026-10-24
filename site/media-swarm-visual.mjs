// A local view of real connections. No invented peers, global viewer count,
// packet animation timer or remote-to-remote links.
import { transferBytes as bytes } from './media-transfer-stats.mjs';
const NS = 'http://www.w3.org/2000/svg';
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const make = (name, attributes = {}, text) => {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
};

export function observedTopology(metrics) {
  const records = metrics?.topology?.connections;
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  return records.filter(item => item && typeof item.id === 'string' && /^[a-z0-9-]{1,32}$/i.test(item.id) &&
    ['connected', 'connecting', 'new'].includes(item.state) && !seen.has(item.id) && seen.add(item.id)).slice(0, 5)
    .map(item => ({ id: item.id, state: item.state, kind: item.kind === 'relay' ? 'relay' : 'direct',
      mediaBytesSent: number(item.mediaBytesSent), verifiedMediaBytesReceived: number(item.verifiedMediaBytesReceived) }));
}

function drawSwarmVisual(container) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const narrow = container.clientWidth < 600;
  const svg = make('svg', { viewBox: narrow ? '0 0 520 390' : '0 0 960 355', role: 'img', 'aria-label': 'The media host and your browser. No peer connections yet.',
    class: 'swarm-canvas', preserveAspectRatio: 'xMidYMid meet' });
  const title = make('title', {}, 'Your part of the swarm');
  const description = make('desc', {}, 'Only peer connections observed by this browser are shown. Moving points represent media sent or verified media received, not connection messages.');
  const style = make('style', {}, `
    .swarm-node text{font-family:Inter,system-ui,sans-serif;fill:#e8e6de;letter-spacing:-.2px}
    .swarm-node .swarm-sub{fill:#96999e;font-size:${narrow ? 15 : 12}px;letter-spacing:0}
    .swarm-node .swarm-label{font-size:${narrow ? 19 : 16}px;font-weight:600}
    .swarm-link{fill:none;stroke:#64706b;stroke-width:1.25;opacity:.6}
    .swarm-peer-link{stroke:#c7f36b;opacity:.45}
    .swarm-connecting{stroke-dasharray:3 7;opacity:.3}
    .swarm-node-enter{animation:swarm-enter .55s ease-out}
    @keyframes swarm-enter{from{opacity:0}to{opacity:1}}
    @media(prefers-reduced-motion:reduce){.swarm-node-enter{animation:none}}
  `);
  const links = make('g'), nodes = make('g'), particles = make('g', { 'aria-hidden': 'true' });
  const origin = narrow ? { x: 78, y: 80 } : { x: 125, y: 165 }, self = narrow ? { x: 348, y: 80 } : { x: 430, y: 165 };
  const path = (from, to) => `M${from.x} ${from.y} C${(from.x + to.x) / 2} ${from.y},${(from.x + to.x) / 2} ${to.y},${to.x} ${to.y}`;
  const originPath = make('path', { d: path(origin, self), class: 'swarm-link' });
  const originTag = make('text', { x: (origin.x + self.x) / 2, y: origin.y - 19, 'text-anchor': 'middle', fill: '#96999e', 'font-size': narrow ? 14 : 11,
    'font-family': 'Inter,system-ui,sans-serif' }, 'HLS fallback');
  links.append(originPath, originTag);

  function node(point, label, subtitle, central = false) {
    const group = make('g', { class: 'swarm-node', transform: `translate(${point.x} ${point.y})` });
    group.append(make('circle', { r: central ? 37 : 24, fill: central ? '#c7f36b0d' : '#151a1b',
      stroke: central ? '#c7f36b' : '#535d5c', 'stroke-width': central ? 1.5 : 1 }));
    if (central) {
      group.append(make('circle', { r: 48, fill: 'none', stroke: '#c7f36b', 'stroke-opacity': .12 }));
      group.append(make('path', { d: 'M-13-10h26v17h-26z M-7 13h14 M0 7v6', stroke: '#c7f36b',
        fill: 'none', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    } else {
      group.append(make('path', { d: 'M-8-7h16v5h-16z M-8 2h16v5h-16z', fill: 'none', stroke: '#c5ccc4', 'stroke-width': 1.1 }));
    }
    const name = make('text', { class: 'swarm-label', y: central ? 76 : 53, 'text-anchor': 'middle' }, label);
    const detail = make('text', { class: 'swarm-sub', y: central ? 96 : 73, 'text-anchor': 'middle' }, subtitle);
    group.append(name, detail);
    nodes.append(group);
    return { group, detail };
  }
  const hostNode = node(origin, 'Media host', 'Original 4K mix');
  const selfNode = node(self, 'You', 'Ready to listen', true);
  const emptyLabel = make('text', { x: narrow ? 260 : 752, y: narrow ? 280 : 160, fill: '#96999e', 'font-size': narrow ? 18 : 14,
    'font-family': 'Inter,system-ui,sans-serif', 'text-anchor': 'middle' }, 'The next listener could be here.');
  const emptySub = make('text', { x: narrow ? 260 : 752, y: narrow ? 306 : 183, fill: '#6d7577', 'font-size': narrow ? 15 : 12,
    'font-family': 'Inter,system-ui,sans-serif', 'text-anchor': 'middle' }, 'Real connections appear as they happen.');
  nodes.append(emptyLabel, emptySub);
  svg.append(title, description, style, links, particles, nodes);
  container.replaceChildren(svg);
  const connected = new Map(), positions = narrow ? [{ x: 348, y: 282 }, { x: 78, y: 282 }, { x: 470, y: 200 }, { x: 210, y: 220 }, { x: 210, y: 325 }] :
    [{ x: 740, y: 164 }, { x: 818, y: 60 }, { x: 818, y: 262 }, { x: 652, y: 45 }, { x: 652, y: 275 }];
  let previousOrigin = 0, destroyed = false, animationFrame;
  const activeFlights = new Set();

  function fly(from, to, colour, count, source) {
    if (destroyed || reduced?.matches || !number(count) || activeFlights.size >= 16 || globalThis.document?.hidden) return;
    // One point represents a measured batch, never an invented packet count.
    const dot = make('circle', { r: 3.2, fill: colour, 'fill-opacity': .95 });
    dot.dataset.flightSource = source;
    dot.dataset.bytes = String(count);
    particles.append(dot);
    const flight = { dot, from, to, start: performance.now() };
    activeFlights.add(flight);
    if (animationFrame === undefined) animationFrame = requestAnimationFrame(animate);
  }
  function animate(now) {
    animationFrame = undefined;
    for (const flight of activeFlights) {
      const t = Math.min(1, Math.max(0, (now - flight.start) / 1100));
      const p = flight.from, q = flight.to, mid = (p.x + q.x) / 2;
      const x = (1 - t) ** 3 * p.x + 3 * (1 - t) ** 2 * t * mid + 3 * (1 - t) * t ** 2 * mid + t ** 3 * q.x;
      const y = (1 - t) ** 3 * p.y + 3 * (1 - t) ** 2 * t * p.y + 3 * (1 - t) * t ** 2 * q.y + t ** 3 * q.y;
      flight.dot.setAttribute('cx', x); flight.dot.setAttribute('cy', y);
      if (t >= 1) { flight.dot.remove(); activeFlights.delete(flight); }
    }
    if (activeFlights.size && !destroyed) animationFrame = requestAnimationFrame(animate);
  }
  function update(metrics = {}, silent = false) {
    if (destroyed) return;
    const peers = observedTopology(metrics);
    const liveIds = new Set(peers.map(peer => peer.id));
    for (const [id, record] of connected) if (!liveIds.has(id)) { record.group.remove(); record.link.remove(); connected.delete(id); }
    for (const peer of peers) {
      let record = connected.get(peer.id);
      if (!record) {
        const used = new Set([...connected.values()].map(item => item.slot));
        const slot = positions.findIndex((_item, i) => !used.has(i));
        const point = positions[slot];
        const link = make('path', { d: path(self, point), class: 'swarm-link swarm-peer-link' });
        links.append(link);
        const part = node(point, `Listener ${peer.id.replace(/^peer-/, '')}`, 'Connecting');
        part.group.classList.add('swarm-node-enter');
        part.group.dataset.peerId = peer.id;
        record = { ...part, link, point, slot, sent: 0, received: 0 };
        connected.set(peer.id, record);
      }
      record.link.classList.toggle('swarm-connecting', peer.state !== 'connected');
      record.link.setAttribute('stroke-dasharray', peer.kind === 'relay' ? '2 5' : '');
      record.detail.textContent = peer.state !== 'connected' ? 'Connecting' : `${bytes(peer.mediaBytesSent)} to them · ${bytes(peer.verifiedMediaBytesReceived)} to you`;
      record.group.dataset.mediaBytesSent = String(peer.mediaBytesSent);
      record.group.dataset.verifiedMediaBytesReceived = String(peer.verifiedMediaBytesReceived);
      if (metrics.playing && !silent) {
        fly(self, record.point, '#c7f36b', peer.mediaBytesSent - record.sent, 'peer-upload');
        fly(record.point, self, '#a1bfff', peer.verifiedMediaBytesReceived - record.received, 'peer-download');
      }
      record.sent = peer.mediaBytesSent; record.received = peer.verifiedMediaBytesReceived;
    }
    const originBytes = number(metrics.originBytes);
    if (metrics.playing && !silent) fly(origin, self, '#d6c5a1', originBytes - previousOrigin, 'origin');
    previousOrigin = originBytes;
    emptyLabel.hidden = emptySub.hidden = peers.length > 0;
    emptyLabel.style.display = emptySub.style.display = peers.length ? 'none' : '';
    selfNode.detail.textContent = !metrics.active ? 'Ready to listen' : !metrics.playing ? 'Paused' : metrics.enabled && metrics.serving ? 'Listening & sharing' : 'Listening';
    hostNode.detail.textContent = `${bytes(metrics.originBytes ?? (metrics.active ? null : 0))} to you`;
    originTag.textContent = !metrics.active ? 'Starts the stream' : peers.length ? 'Origin fallback' : 'HLS delivery';
    svg.setAttribute('aria-label', `The media host, your browser and ${peers.length} observed peer connection${peers.length === 1 ? '' : 's'}. ${number(metrics.peerBytes)} verified peer bytes received; ${number(metrics.uploadedBytes)} video bytes uploaded.`);
    container.dataset.connectedPeers = String(peers.filter(peer => peer.state === 'connected').length);
    container.dataset.observedPeers = String(peers.length);
    container.dataset.originBytes = String(originBytes);
    container.dataset.peerBytes = String(number(metrics.peerBytes));
    container.dataset.uploadedBytes = String(number(metrics.uploadedBytes));
  }
  const destroy = () => {
    destroyed = true;
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    activeFlights.clear(); connected.clear(); container.replaceChildren();
  };
  update();
  return { update, destroy };
}

export function createSwarmVisual(container) {
  let visual = drawSwarmVisual(container), last = {}, narrow = container.clientWidth < 600;
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const next = container.clientWidth < 600;
    if (next === narrow || container.clientWidth === 0) return;
    narrow = next;
    visual.destroy(); visual = drawSwarmVisual(container);
    // A layout change must not replay historical traffic as new transfers.
    visual.update(last, true);
  }) : null;
  observer?.observe(container);
  return {
    update(metrics) { last = metrics ?? {}; visual.update(last); },
    destroy() { observer?.disconnect(); visual.destroy(); },
  };
}
