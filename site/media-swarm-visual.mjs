// A bounded picture of local video measurements and fresh listener reports.
// Reported links stay visually distinct from transfers observed in this browser.
import { transferBytes as bytes } from './media-transfer-stats.mjs?v=20261025-playback-report';
const NS = 'http://www.w3.org/2000/svg';
export const MAX_VISUAL_PEERS = 10;
export const TRAFFIC_WINDOW_MS = 10_000;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const key = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const make = (name, attributes = {}, text) => {
  const node = document.createElementNS(NS, name);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
};

export function observedTopology(metrics) {
  const records = metrics?.topology?.connections;
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  return records.filter(item => item && typeof item.id === 'string' && /^[a-z0-9-]{1,32}$/i.test(item.id) &&
    item.state === 'connected' && !seen.has(item.id) && seen.add(item.id)).slice(0, MAX_VISUAL_PEERS)
    .map(item => ({ id: item.id, state: item.state, kind: item.kind === 'relay' ? 'relay' : 'direct',
      ...(key(item.peerId) ? { peerId: item.peerId } : {}),
      mediaBytesSent: number(item.mediaBytesSent), verifiedMediaBytesReceived: number(item.verifiedMediaBytesReceived) }));
}

function freshReport(member, now) {
  const report = member.telemetry;
  const expiresAt = member.telemetryExpiresAt ?? report?.expiresAt;
  if (!report || !key(report.peerId) || !Number.isSafeInteger(report.sampledAt) || report.sampledAt > now + 5000 ||
      report.sampledAt < now - 20_000 || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 20_000 ||
      expiresAt <= report.sampledAt || [report.originBytes, report.peerBytes, report.uploadedBytes].some(value => counter(value) === null)) return null;
  const connections = [], seen = new Set();
  for (const item of Array.isArray(report.connections) ? report.connections.slice(0, 20) : []) {
    if (!key(item?.peerId) || seen.has(item.peerId) || counter(item.sentBytes) === null || counter(item.receivedBytes) === null) continue;
    seen.add(item.peerId);
    connections.push({ peerId: item.peerId, sentBytes: item.sentBytes, receivedBytes: item.receivedBytes });
  }
  return { peerId: report.peerId, sampledAt: report.sampledAt, expiresAt,
    originBytes: report.originBytes, peerBytes: report.peerBytes, uploadedBytes: report.uploadedBytes, connections };
}

// Presence identifies a room member. Its optional telemetry claims an SDK key;
// duplicate claims are ambiguous and never assign video to another listener.
export function observedRoomTopology(metrics = {}, now = Date.now(), remembered = new Map()) {
  const peers = observedTopology(metrics), viewerId = key(metrics.viewerId);
  const supplied = Array.isArray(metrics.room?.members) ? metrics.room.members : [];
  const selfId = key(metrics.room?.id) ?? key(supplied.find(item => item?.isSelf)?.id);
  const membersById = new Map();
  for (const item of supplied.slice(0, 100)) {
    if (!key(item?.id) || membersById.has(item.id) || Number.isFinite(item.expiresAt) && item.expiresAt <= now) continue;
    membersById.set(item.id, { id: item.id, report: freshReport(item, now) });
  }
  const members = [...membersById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const roomAvailable = Boolean(Array.isArray(metrics.room?.members) &&
    (metrics.room.observed || metrics.room.ready || selfId || members.length));
  const claims = new Map(), ambiguous = new Set();
  for (const member of members) {
    const sdkKey = member.id === selfId ? viewerId : member.report?.peerId;
    if (!sdkKey) continue;
    if (claims.has(sdkKey) && claims.get(sdkKey) !== member.id) { ambiguous.add(sdkKey); continue; }
    claims.set(sdkKey, member.id);
  }
  for (const [sdkKey, memberId] of remembered) {
    const current = membersById.get(memberId);
    if (!current || ambiguous.has(sdkKey) || current.report && current.report.peerId !== sdkKey || memberId === selfId && sdkKey !== viewerId) remembered.delete(sdkKey);
  }
  for (const [sdkKey, memberId] of claims) if (!ambiguous.has(sdkKey)) remembered.set(sdkKey, memberId);
  if (selfId && viewerId && !ambiguous.has(viewerId)) remembered.set(viewerId, selfId);
  const resolveMember = sdkKey => ambiguous.has(sdkKey) ? null : remembered.get(sdkKey) ?? null;
  const self = { id: selfId ?? 'self', label: 'You', peerId: viewerId, roomMember: Boolean(selfId && membersById.has(selfId)) };
  if (roomAvailable && !metrics.active && !membersById.has(selfId)) self.label = 'You · not listening';
  const visible = [];
  if (roomAvailable) {
    members.forEach((member, index) => {
      const label = `Listener ${index + 1}`;
      if (member.id === selfId) { self.label = `You · ${label}`; return; }
      if (visible.length < MAX_VISUAL_PEERS) visible.push({ ...member, label, roomMember: true,
        peerId: member.report && !ambiguous.has(member.report.peerId) ? member.report.peerId : null, connected: false });
    });
  } else {
    remembered.clear();
    peers.forEach((peer, index) => visible.push({ id: `connection-${peer.id}`, label: `Listener ${index + 1}`,
      peerId: peer.peerId ?? null, roomMember: false, report: null, connected: true, connectionId: peer.id }));
  }
  const byId = new Map(visible.map(item => [item.id, item]));
  // Logical source loads include browser cache hits. New players supply the
  // separately observed network body count; null means timing is unavailable.
  const networkSource = Object.hasOwn(metrics, 'sourceNetworkBytes');
  const edges = [{ id: 'origin-self', kind: 'origin', from: 'origin', to: self.id, fromPeerId: null, toPeerId: viewerId,
    forward: { sourceId: networkSource ? 'local-network' : 'local-origin',
      value: counter(networkSource ? metrics.sourceNetworkBytes : metrics.originBytes), sampledAt: now }, reverse: null }];
  let unmappedConnections = 0;
  for (const peer of peers) {
    const memberId = roomAvailable ? resolveMember(peer.peerId) : `connection-${peer.id}`;
    const member = byId.get(memberId);
    if (!member) { unmappedConnections++; continue; }
    member.connected = true; member.connectionId = peer.id; member.peerId = peer.peerId ?? member.peerId;
    edges.push({ id: `native-${peer.id}`, kind: 'native-peer', from: self.id, to: member.id,
      fromPeerId: viewerId, toPeerId: peer.peerId ?? null, connectionId: peer.id, relay: peer.kind === 'relay',
      forward: { sourceId: `local-${peer.id}-sent`, value: peer.mediaBytesSent, sampledAt: now },
      reverse: { sourceId: `local-${peer.id}-received`, value: peer.verifiedMediaBytesReceived, sampledAt: now } });
  }
  const reportedPairs = new Map();
  for (const member of visible) {
    const report = member.report;
    if (!report || ambiguous.has(report.peerId) || resolveMember(report.peerId) !== member.id) continue;
    edges.push({ id: `origin-${member.id}`, kind: 'reported-origin', from: 'origin', to: member.id,
      fromPeerId: null, toPeerId: report.peerId,
      forward: { sourceId: `reported-origin-${member.id}-${report.peerId}`, value: report.originBytes, sampledAt: report.sampledAt }, reverse: null });
    for (const connection of report.connections) {
      const otherId = resolveMember(connection.peerId), other = byId.get(otherId);
      if (!other || otherId === member.id || otherId === self.id) continue;
      const [from, to] = [member.id, otherId].sort();
      const pairId = `reported-${from}-${to}`;
      let pair = reportedPairs.get(pairId);
      if (!pair) {
        if (reportedPairs.size >= 30) continue;
        pair = { id: pairId, kind: 'reported-peer', from, to, fromPeerId: null, toPeerId: null, forward: null, reverse: null };
        reportedPairs.set(pairId, pair);
      }
      // Prefer the receiving browser's verified count when both ends report.
      // Counters from the sender and receiver are never added together.
      const ownForward = member.id === from;
      const sentDirection = ownForward ? 'forward' : 'reverse', receivedDirection = ownForward ? 'reverse' : 'forward';
      const observation = (value, direction, verified) => ({ value, sampledAt: report.sampledAt,
        sourceId: `reported-${member.id}-${report.peerId}-${direction}`, verified });
      if (!pair[sentDirection]?.verified) pair[sentDirection] = observation(connection.sentBytes, 'sent', false);
      pair[receivedDirection] = observation(connection.receivedBytes, 'received', true);
      pair[ownForward ? 'fromPeerId' : 'toPeerId'] = report.peerId;
      pair[ownForward ? 'toPeerId' : 'fromPeerId'] ??= connection.peerId;
    }
  }
  edges.push(...reportedPairs.values());
  return { self, members: visible, edges, roomAvailable, roomMemberCount: members.length, unmappedConnections, ambiguousClaims: ambiguous.size,
    connectedPeers: peers.length };
}

// A rolling byte window. Repeated reports, counter resets and stale samples do
// not manufacture transfers; a new source starts with an observed baseline.
export function createTrafficWindow(windowMs = TRAFFIC_WINDOW_MS) {
  const records = new Map();
  const observe = (id, value, sampledAt, now) => {
    if (counter(value) === null || !Number.isFinite(sampledAt) || sampledAt > now + 5000) return { delta: 0, rate: 0 };
    let record = records.get(id), delta = 0;
    if (!record) { record = { value, sampledAt, intervals: [] }; records.set(id, record); }
    else if (sampledAt > record.sampledAt) {
      const duration = sampledAt - record.sampledAt;
      if (value < record.value) record.intervals = [];
      else if (duration <= windowMs && sampledAt > now - windowMs) {
        delta = value - record.value;
        record.intervals.push({ from: record.sampledAt, to: sampledAt, bytes: delta });
      }
      record.value = value; record.sampledAt = sampledAt;
    }
    record.intervals = record.intervals.filter(item => item.to > now - windowMs);
    const received = record.intervals.reduce((sum, item) => sum + item.bytes * Math.max(0, item.to - Math.max(item.from, now - windowMs)) / (item.to - item.from), 0);
    return { delta, rate: received * 1000 / windowMs };
  };
  return { observe, retain(ids) { for (const id of records.keys()) if (!ids.has(id)) records.delete(id); }, clear() { records.clear(); } };
}

export function peerDeliveryShare(originRate, peerRate) {
  if ([originRate, peerRate].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) return null;
  const total = number(originRate) + number(peerRate);
  return total > 0 ? number(peerRate) / total : null;
}

// The picture uses real CSS-pixel space. Extra listeners add rows rather than
// squeezing names and icons into a fixed, increasingly crowded canvas.
export function swarmLayout(availableWidth, peerCount) {
  const width = Math.max(240, Math.round(number(availableWidth))), count = Math.min(MAX_VISUAL_PEERS, Math.max(0, Math.floor(number(peerCount))));
  const compact = width < 600;
  const origin = { x: width / 2, y: compact ? 88 : 90, radius: 26 };
  let self, positions = [], height;
  if (compact) {
    if (!count) { self = { x: width / 2, y: 250, radius: 27 }; height = 340; }
    else if (count === 1) {
      self = { x: width / 3, y: 260, radius: 27 };
      positions = [{ x: width * 2 / 3, y: 260, radius: 18 }]; height = 350;
    } else {
      self = { x: width / 2, y: 235, radius: 27 };
      const columns = width >= 330 ? 3 : 2;
      for (let index = 0; index < count; index++) {
        const row = Math.floor(index / columns), rowCount = Math.min(columns, count - row * columns), column = index % columns;
        positions.push({ x: width * (column + 1) / (rowCount + 1), y: 390 + row * 120, radius: 18 });
      }
      height = positions.at(-1).y + 92;
    }
  } else {
    if (!count) {
      origin.x = width * .3; origin.y = 165;
      self = { x: width * .7, y: 165, radius: 27 }; height = 330;
    } else {
      const columns = width >= 1000 ? 5 : width >= 780 ? 4 : 3;
      const firstCount = Math.min(count + 1, columns), firstXs = Array.from({ length: firstCount }, (_, index) => width * (index + 1) / (firstCount + 1));
      const selfIndex = Math.floor((firstCount - 1) / 2);
      self = { x: firstXs[selfIndex], y: 290, radius: 27 };
      positions = firstXs.filter((_value, index) => index !== selfIndex).map(x => ({ x, y: 290, radius: 18 }));
      for (let index = positions.length; index < count; index++) {
        const remaining = index - (firstCount - 1), row = Math.floor(remaining / columns), rowCount = Math.min(columns, count - (firstCount - 1) - row * columns);
        positions.push({ x: width * (remaining % columns + 1) / (rowCount + 1), y: 440 + row * 130, radius: 18 });
      }
      height = Math.max(self.y, positions.at(-1).y) + 100;
    }
  }
  return { width, height, origin, self, positions };
}

function createStatistics(container) {
  let root = container.dataset.statistics ? document.getElementById(container.dataset.statistics) : null;
  const owned = !root;
  if (!root) {
    root = document.createElement('div'); root.className = 'swarm-statistics'; root.dataset.swarmStatistics = '';
    container.insertAdjacentElement('afterend', root);
  }
  let strengthSlot = root.querySelector('[data-swarm-strength-slot]');
  if (!strengthSlot) { strengthSlot = document.createElement('div'); strengthSlot.dataset.swarmStrengthSlot = ''; root.prepend(strengthSlot); }
  let linkSlot = root.querySelector('[data-swarm-link-statistics]');
  if (!linkSlot) {
    const details = document.createElement('details'), summary = document.createElement('summary');
    details.className = 'swarm-link-details'; summary.textContent = 'Connection details'; linkSlot = document.createElement('div');
    linkSlot.dataset.swarmLinkStatistics = ''; details.append(summary, linkSlot); root.append(details);
  }
  const strength = document.createElement('div'); strength.className = 'swarm-strength';
  strength.innerHTML = '<div class="swarm-strength-heading"><span>Your peer delivery</span><output data-swarm-strength-value>Waiting for video traffic</output></div><div class="swarm-strength-meter" data-swarm-strength-meter role="meter" aria-label="Share of loaded video from verified peers over the last ten seconds, including source cache loads" aria-valuemin="0" aria-valuemax="100"><span></span></div><p data-swarm-strength-note>This browser’s loaded video, including source cache loads, over the last 10 seconds.</p>';
  strengthSlot.replaceChildren(strength);
  const value = strength.querySelector('[data-swarm-strength-value]'), meter = strength.querySelector('[data-swarm-strength-meter]'), note = strength.querySelector('[data-swarm-strength-note]');
  const rows = new Map();
  return {
    strength(share, originRate, peerRate) {
      const percentage = share === null ? null : Math.round(share * 100);
      value.textContent = percentage === null ? 'Waiting for video traffic' : `${percentage}%`;
      meter.firstElementChild.style.width = `${percentage ?? 0}%`;
      if (percentage === null) meter.removeAttribute('aria-valuenow'); else meter.setAttribute('aria-valuenow', percentage);
      meter.setAttribute('aria-valuetext', percentage === null ? 'No recent loaded video measured' : `${percentage}% of loaded video from verified peers, over the last ten seconds`);
      note.textContent = share === null ? 'This browser’s loaded video, including cached source loads, over the last 10 seconds.' :
        `${bytes(peerRate * 10)} verified from peers / ${bytes((peerRate + originRate) * 10)} loaded here · includes source cache · last 10 seconds`;
    },
    links(model, readings, playing) {
      const live = new Set(model.edges.map(edge => edge.id)), names = new Map([['origin', 'Broadcast'], [model.self.id, model.self.label], ...model.members.map(member => [member.id, member.label])]);
      for (const [id, row] of rows) if (!live.has(id)) { row.element.remove(); rows.delete(id); }
      for (const edge of model.edges) {
        let row = rows.get(edge.id);
        if (!row) {
          const element = document.createElement('div'); element.className = 'swarm-link-row'; element.dataset.linkId = edge.id;
          const route = document.createElement('div'), name = document.createElement('strong'), scope = document.createElement('span');
          route.className = 'swarm-link-route'; route.append(name, scope);
          const forward = document.createElement('div'), reverse = document.createElement('div');
          element.append(route, forward, reverse); linkSlot.append(element); row = { element, name, scope, forward, reverse }; rows.set(edge.id, row);
        }
        row.name.textContent = `${names.get(edge.from)} ${edge.reverse ? '↔' : '→'} ${names.get(edge.to)}`;
        row.scope.textContent = edge.kind === 'origin' ? edge.forward.sourceId === 'local-network' ? 'Network response bodies measured here' : 'Loaded source · may be cached' :
          edge.kind === 'reported-origin' ? 'Listener report · loaded source may be cached' :
          edge.kind.startsWith('reported') ? 'Listener report' : 'Measured here';
        for (const direction of ['forward', 'reverse']) {
          const reading = readings.find(item => item.edge === edge && item.direction === direction), cell = row[direction];
          cell.hidden = !reading;
          if (!reading) continue;
          const rate = playing || edge.kind.startsWith('reported') ? reading.rate : 0;
          const known = edge[direction]?.value !== null;
          cell.textContent = known ? `${bytes(rate)}/s ${direction === 'forward' ? '→' : '←'}` : 'Measurement unavailable';
          cell.dataset.bytesPerSecond = known ? String(rate) : '';
        }
      }
    },
    destroy() { if (owned) root.remove(); else { strengthSlot.replaceChildren(); linkSlot.replaceChildren(); } },
  };
}

function drawSwarmVisual(container, context) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const svg = make('svg', { role: 'img', class: 'swarm-canvas', preserveAspectRatio: 'xMidYMid meet' });
  const title = make('title', {}, 'Your view of the listening room');
  const description = make('desc', {}, 'Short names identify the real room members. Solid links are measured here; dashed links are listener reports. Moving dots represent measured video batches. The broad glow around Broadcast follows the music and does not represent network traffic. Rates and delivery statistics are below the picture.');
  const style = make('style', {}, `
    .swarm-node text{font-family:Inter,system-ui,sans-serif;fill:#dfe6d6}
    .swarm-label{font-size:12px;font-weight:500;letter-spacing:-.12px}
    .swarm-node[data-swarm-node="origin"] .swarm-label{font-size:12px;fill:#d6c5a1;letter-spacing:.03em}
    .swarm-node[data-swarm-node="self"] .swarm-label{font-size:12px;fill:#d2ed91;font-weight:600}
    .swarm-link{fill:none;stroke-linecap:round}
  `);
  const links = make('g'), nodes = make('g'), particles = make('g', { 'aria-hidden': 'true' });
  function node(label, kind) {
    const radius = kind === 'self' ? 27 : kind === 'origin' ? 26 : 18;
    const group = make('g', { class: 'swarm-node', 'data-swarm-node': kind });
    const circle = make('circle', { r: radius, fill: kind === 'self' ? '#d2ed910a' : '#131911', stroke: kind === 'origin' ? '#bfa77c' : kind === 'self' ? '#d2ed91' : '#67765e', 'stroke-width': 1 });
    group.append(circle);
    if (kind === 'origin') group.append(make('path', { d: 'M-7 0a7 7 0 0 1 14 0 M-12 0a12 12 0 0 1 24 0 M0 4v6 M-3 10h6', fill: 'none', stroke: '#d6c5a1', 'stroke-width': 1.2, 'stroke-linecap': 'round' }));
    if (kind === 'listener') group.append(make('path', { d: 'M-6-5h12v8h-12z M-3 6h6', fill: 'none', stroke: '#b0bea5', 'stroke-width': 1 }));
    const labelY = kind === 'origin' ? -51 : kind === 'self' ? 4 : 44;
    const backing = make('rect', { y: labelY - 15, height: 23, rx: 7, fill: '#131a10' });
    const name = make('text', { class: 'swarm-label', y: labelY, 'text-anchor': 'middle' }, label);
    const detail = make('title', { class: 'swarm-sub' }, '');
    if (kind !== 'self') group.append(backing);
    group.append(name, detail); nodes.append(group);
    return { group, circle, name, backing, detail, radius };
  }
  function nameNode(record, label) {
    record.name.textContent = label;
    const width = Math.max(40, label.length * 6.8 + 14);
    record.backing.setAttribute('x', -width / 2); record.backing.setAttribute('width', width);
  }
  const hostNode = node('Broadcast', 'origin'), selfNode = node('You', 'self');
  nameNode(hostNode, 'Broadcast');
  const audio = make('g', { 'data-audio-pulse': '', 'data-energy': 0, 'data-beat': 0, 'data-active': 'false', 'aria-hidden': 'true' });
  const glow = make('circle', { 'data-audio-ring': 'glow', r: 54, fill: '#d6bd82', opacity: 0 });
  const ring = make('circle', { 'data-audio-ring': 'beat', r: 39, fill: 'none', stroke: '#d6bd82', 'stroke-width': 1, opacity: 0 });
  const echo = make('circle', { 'data-audio-ring': 'echo', r: 55, fill: 'none', stroke: '#d6bd82', 'stroke-width': .6, opacity: 0 });
  audio.append(glow, ring, echo); hostNode.group.prepend(audio);
  svg.append(title, description, style, links, particles, nodes);
  container.replaceChildren(svg); container.classList.remove('swarm-map-with-strength');
  const members = new Map(), edges = new Map(), activeFlights = new Set();
  let destroyed = false, animationFrame, playing = false, layoutSignature = '';
  const clamp = value => Math.max(0, Math.min(1, number(value)));
  function setAudioPulse({ energy = 0, beat = 0 } = {}) {
    const allowed = !destroyed && playing && !document.hidden && !reduced?.matches;
    energy = allowed ? clamp(energy) : 0; beat = allowed ? clamp(beat) : 0;
    audio.dataset.energy = String(energy); audio.dataset.beat = String(beat); audio.dataset.active = String(energy > 0 || beat > 0);
    glow.setAttribute('r', 53 + energy * 14); glow.setAttribute('opacity', energy * .065);
    ring.setAttribute('r', 35 + beat * 22); ring.setAttribute('opacity', beat * .24 + energy * .025);
    echo.setAttribute('r', 48 + beat * 18); echo.setAttribute('opacity', beat * .11);
  }
  function clearFlights(id) {
    for (const flight of activeFlights) if (id === undefined || flight.edgeId === id) { flight.dot.remove(); activeFlights.delete(flight); }
  }
  function stopMotion() {
    clearFlights(); setAudioPulse({});
    if (animationFrame !== undefined) { cancelAnimationFrame(animationFrame); animationFrame = undefined; }
  }
  function curve(from, to, bend) {
    const dx = to.x - from.x, dy = to.y - from.y, distance = Math.max(1, Math.hypot(dx, dy)), nx = -dy / distance, ny = dx / distance;
    const start = { x: from.x + dx / distance * (from.radius + 5), y: from.y + dy / distance * (from.radius + 5) };
    const end = { x: to.x - dx / distance * (to.radius + 5), y: to.y - dy / distance * (to.radius + 5) };
    const first = { x: start.x + (end.x - start.x) / 3 + nx * bend, y: start.y + (end.y - start.y) / 3 + ny * bend };
    const second = { x: start.x + (end.x - start.x) * 2 / 3 + nx * bend, y: start.y + (end.y - start.y) * 2 / 3 + ny * bend };
    return { start, end, first, second, d: `M${start.x} ${start.y} C${first.x} ${first.y},${second.x} ${second.y},${end.x} ${end.y}` };
  }
  function onCurve(shape, t) {
    return { x: (1 - t) ** 3 * shape.start.x + 3 * (1 - t) ** 2 * t * shape.first.x + 3 * (1 - t) * t ** 2 * shape.second.x + t ** 3 * shape.end.x,
      y: (1 - t) ** 3 * shape.start.y + 3 * (1 - t) ** 2 * t * shape.first.y + 3 * (1 - t) * t ** 2 * shape.second.y + t ** 3 * shape.end.y };
  }
  function sizeFlights() {
    const largest = Math.max(1, ...[...activeFlights].map(flight => flight.count));
    for (const flight of activeFlights) flight.dot.setAttribute('r', Math.max(1.1, 6 * Math.sqrt(flight.count / largest)));
  }
  function fly(shape, colour, count, source, edgeId) {
    if (destroyed || !playing || reduced?.matches || !number(count) || activeFlights.size >= 20 || document.hidden) return;
    const dot = make('circle', { r: 1.1, fill: colour, 'fill-opacity': .9 });
    Object.assign(dot.dataset, { flightSource: source, bytes: String(count), edgeId });
    particles.append(dot); activeFlights.add({ dot, shape, edgeId, count, start: performance.now() }); sizeFlights();
    if (animationFrame === undefined) animationFrame = requestAnimationFrame(animate);
  }
  function animate(now) {
    animationFrame = undefined;
    if (!playing || document.hidden || reduced?.matches) { stopMotion(); return; }
    for (const flight of activeFlights) {
      const t = Math.min(1, Math.max(0, (now - flight.start) / 1500)), point = onCurve(flight.shape, t);
      flight.dot.setAttribute('cx', point.x); flight.dot.setAttribute('cy', point.y);
      if (t >= 1) { flight.dot.remove(); activeFlights.delete(flight); }
    }
    if (activeFlights.size && !destroyed) { sizeFlights(); animationFrame = requestAnimationFrame(animate); }
  }
  function update(metrics = {}, silent = false) {
    if (destroyed) return;
    playing = Boolean(metrics.playing);
    const now = Date.now(), model = observedRoomTopology(metrics, now, context.claims), layout = swarmLayout(container.clientWidth, model.members.length);
    const signature = `${layout.width}/${layout.height}/${model.members.map(member => member.id).join('/')}`;
    if (layoutSignature !== signature) { clearFlights(); layoutSignature = signature; }
    svg.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`);
    container.style.setProperty('--swarm-height', `${layout.height}px`);
    const selfId = model.self.id, locations = new Map([['origin', layout.origin], [selfId, layout.self]]);
    hostNode.group.setAttribute('transform', `translate(${layout.origin.x} ${layout.origin.y})`);
    selfNode.group.setAttribute('transform', `translate(${layout.self.x} ${layout.self.y})`);
    selfNode.name.textContent = 'You'; selfNode.detail.textContent = model.self.label;
    if (model.self.roomMember) selfNode.group.dataset.roomMemberId = selfId; else delete selfNode.group.dataset.roomMemberId;
    selfNode.group.dataset.viewerId = model.self.peerId ?? '';
    const localPeers = observedTopology(metrics), liveMembers = new Set(model.members.map(member => member.id));
    for (const [id, record] of members) if (!liveMembers.has(id)) { record.group.remove(); members.delete(id); }
    model.members.forEach((member, index) => {
      const point = layout.positions[index]; locations.set(member.id, point);
      let record = members.get(member.id);
      if (!record) { record = node(member.label, 'listener'); members.set(member.id, record); }
      nameNode(record, member.label); record.group.setAttribute('transform', `translate(${point.x} ${point.y})`);
      record.circle.setAttribute('stroke', member.connected ? '#b9d98a' : member.report ? '#869cba' : '#59664f');
      record.circle.setAttribute('stroke-dasharray', member.connected ? '' : '2 4');
      record.circle.setAttribute('fill', member.connected ? '#b9d98a08' : '#131a10');
      record.detail.textContent = member.connected ? 'Connected to you' : member.report ? 'Listener report available' : 'In the room; no transfer report';
      if (member.roomMember) record.group.dataset.roomMemberId = member.id; else delete record.group.dataset.roomMemberId;
      if (member.connectionId) record.group.dataset.peerId = member.connectionId; else delete record.group.dataset.peerId;
      record.group.dataset.viewerId = member.peerId ?? ''; record.group.dataset.connected = String(member.connected);
      const local = localPeers.find(peer => peer.id === member.connectionId);
      record.group.dataset.mediaBytesSent = String(local?.mediaBytesSent ?? 0);
      record.group.dataset.verifiedMediaBytesReceived = String(local?.verifiedMediaBytesReceived ?? 0);
    });
    const readings = [], liveTraffic = new Set();
    for (const edge of model.edges) {
      if (!locations.has(edge.from) || !locations.has(edge.to)) continue;
      for (const direction of ['forward', 'reverse']) {
        const observation = edge[direction]; if (!observation) continue;
        liveTraffic.add(observation.sourceId);
        readings.push({ edge, direction, ...context.traffic.observe(observation.sourceId, observation.value, observation.sampledAt, now) });
      }
    }
    context.traffic.retain(liveTraffic);
    const maximumRate = Math.max(1, ...readings.map(item => playing || item.edge.kind.startsWith('reported') ? item.rate : 0));
    const liveEdges = new Set(model.edges.map(edge => edge.id));
    for (const [id, record] of edges) if (!liveEdges.has(id)) { clearFlights(id); record.group.remove(); edges.delete(id); }
    for (const edge of model.edges) {
      const from = locations.get(edge.from), to = locations.get(edge.to); if (!from || !to) continue;
      const reported = edge.kind.startsWith('reported');
      let record = edges.get(edge.id);
      if (!record) {
        const group = make('g'), route = make('path', { class: 'swarm-link' }); group.append(route); links.append(group);
        record = { group, route, paths: {} }; edges.set(edge.id, record);
      }
      Object.assign(record.group.dataset, { edgeId: edge.id, edgeKind: edge.kind, fromMemberId: edge.from, toMemberId: edge.to,
        fromPeerId: edge.fromPeerId ?? '', toPeerId: edge.toPeerId ?? '', attribution: reported ? 'listener-reported' : 'measured-here' });
      if (edge.connectionId) record.group.dataset.connectionId = edge.connectionId;
      let bend = 0;
      if (edge.kind === 'reported-origin') bend = (to.x < layout.origin.x ? 1 : -1) * Math.min(105, layout.width * .27);
      else if (edge.kind === 'reported-peer' && Math.abs(from.y - to.y) < 1) bend = Math.min(85, Math.abs(from.x - to.x) * .23);
      else if (edge.kind === 'native-peer' && Math.abs(from.y - to.y) < 1) bend = -Math.min(55, Math.abs(from.x - to.x) * .18);
      const routeShape = curve(from, to, bend);
      record.route.setAttribute('d', routeShape.d); record.route.setAttribute('stroke', edge.kind.includes('origin') ? '#b39e76' : '#899b79');
      record.route.setAttribute('stroke-width', .75); record.route.setAttribute('stroke-opacity', reported ? .12 : .22);
      record.route.setAttribute('stroke-dasharray', reported ? '3 7' : '');
      for (const direction of ['forward', 'reverse']) {
        const reading = readings.find(item => item.edge === edge && item.direction === direction); if (!reading) continue;
        const reverse = direction === 'reverse', source = edge.kind === 'native-peer' ? reverse ? 'peer-download' : 'peer-upload' :
          edge.kind === 'origin' ? 'origin' : edge.kind === 'reported-origin' ? 'reported-origin' : 'reported-peer';
        const colour = edge.kind.includes('origin') ? '#cfb78b' : reverse ? '#93aed0' : '#b9d98a';
        const shape = reverse ? curve(to, from, -bend - 3) : curve(from, to, bend + (edge.reverse ? 3 : 0));
        let path = record.paths[direction];
        if (!path) { path = make('path', { class: 'swarm-link' }); record.group.append(path); record.paths[direction] = path; }
        const rate = playing || reported ? reading.rate : 0, width = .7 + 3.3 * rate / maximumRate;
        path.setAttribute('d', shape.d); path.setAttribute('stroke', colour); path.setAttribute('stroke-width', width);
        path.setAttribute('stroke-opacity', rate > 0 ? reported ? .28 : .62 : 0);
        path.setAttribute('stroke-dasharray', reported ? '3 7' : edge.relay ? '2 4' : '');
        Object.assign(path.dataset, { direction: edge.kind === 'native-peer' ? reverse ? 'download' : 'upload' : direction,
          bytesPerSecond: String(rate), cumulativeBytes: String(edge[direction].value ?? '') });
        record.group.dataset[reverse ? 'receivedBps' : 'sentBps'] = String(rate);
        if (playing && !silent) fly(shape, colour, reading.delta, source, edge.id);
      }
    }
    if (!playing || document.hidden || reduced?.matches) stopMotion();
    const knownRoom = metrics.room?.observed === true, roomCount = counter(metrics.room?.listeners);
    container.dataset.inviting = String(knownRoom && roomCount === 0 && !playing);
    const originValue = counter(metrics.originBytes), peerValue = counter(metrics.peerBytes);
    let originRate = 0, peerRate = 0;
    if (playing && originValue !== null && peerValue !== null) {
      originRate = context.strength.observe('origin', originValue, now, now).rate;
      peerRate = context.strength.observe('peer', peerValue, now, now).rate;
    } else context.strength.clear();
    const share = playing && originValue !== null && peerValue !== null ? peerDeliveryShare(originRate, peerRate) : null;
    context.statistics.strength(share, originRate, peerRate); context.statistics.links(model, readings, playing);
    container.dataset.peerSharePercent = share === null ? '' : String(Math.round(share * 100));
    container.dataset.strengthScope = 'local-verified-video-share-10s';
    container.dataset.connectedPeers = String(model.connectedPeers); container.dataset.observedPeers = String(model.members.length);
    container.dataset.roomMembers = String(model.roomMemberCount); container.dataset.unmappedConnections = String(model.unmappedConnections);
    container.dataset.originBytes = String(number(metrics.originBytes)); container.dataset.peerBytes = String(number(metrics.peerBytes));
    container.dataset.uploadedBytes = String(number(metrics.uploadedBytes));
    svg.setAttribute('aria-label', `Broadcast, your browser and ${model.members.length} other observed listener${model.members.length === 1 ? '' : 's'}. Solid links are measured here; dashed links are listener reports. Rates and delivery statistics follow below.`);
  }
  return { update, setAudioPulse, stopMotion,
    destroy() { stopMotion(); destroyed = true; members.clear(); edges.clear(); container.replaceChildren(); } };
}

export function createSwarmVisual(container) {
  const statistics = createStatistics(container), context = { claims: new Map(), traffic: createTrafficWindow(), strength: createTrafficWindow(), statistics };
  const visual = drawSwarmVisual(container, context);
  let last = {}, lastWidth = container.clientWidth, suppressNext = false;
  visual.update(last, true);
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if (container.clientWidth === lastWidth || container.clientWidth === 0) return;
    lastWidth = container.clientWidth; visual.update(last, true);
  }) : null;
  resize?.observe(container);
  const visibility = () => { if (document.hidden) { visual.stopMotion(); suppressNext = true; } };
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const motion = () => { if (reduced?.matches) visual.stopMotion(); };
  document.addEventListener('visibilitychange', visibility); reduced?.addEventListener?.('change', motion);
  return {
    update(metrics) { last = metrics ?? {}; visual.update(last, suppressNext); suppressNext = false; },
    setAudioPulse(value) { visual.setAudioPulse(value); },
    destroy() { resize?.disconnect(); document.removeEventListener('visibilitychange', visibility); reduced?.removeEventListener?.('change', motion);
      visual.destroy(); statistics.destroy(); context.claims.clear(); context.traffic.clear(); context.strength.clear(); },
  };
}
