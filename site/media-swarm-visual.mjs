// A bounded picture of local video measurements and fresh listener reports.
// Reported links stay visually distinct from transfers observed in this browser.
import { transferBytes as bytes } from './media-transfer-stats.mjs';
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
  const edges = [{ id: 'origin-self', kind: 'origin', from: 'origin', to: self.id, fromPeerId: null, toPeerId: viewerId,
    forward: { sourceId: 'local-origin', value: counter(metrics.originBytes), sampledAt: now }, reverse: null }];
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

function drawSwarmVisual(container, context) {
  const reduced = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const narrow = container.clientWidth < 600;
  const svg = make('svg', { viewBox: narrow ? '0 0 520 390' : '0 0 960 355', role: 'img',
    'aria-label': 'The media host and your browser. No listener reports yet.', class: 'swarm-canvas', preserveAspectRatio: 'xMidYMid meet' });
  const title = make('title', {}, 'Your view of the listening room');
  const description = make('desc', {}, 'Solid links show video measured in this browser. Dashed links are fresh reports from other listeners. Width shows the observed rate; moving points show new byte batches, not packet counts.');
  const style = make('style', {}, `
    .swarm-node text{font-family:Inter,system-ui,sans-serif;fill:#e8e6de;letter-spacing:-.2px}
    .swarm-node .swarm-sub{fill:#9ba79a;font-size:${narrow ? 14 : 11}px;letter-spacing:0}
    .swarm-node .swarm-label{font-size:${narrow ? 18 : 15}px;font-weight:600}
    .swarm-link{fill:none;stroke-linecap:round}
    .swarm-rate{font-family:Inter,system-ui,sans-serif;font-size:${narrow ? 12 : 10}px;fill:#b6c5ae;paint-order:stroke;stroke:#151c12;stroke-width:4;stroke-linejoin:round}
    .swarm-node-enter{animation:swarm-enter .4s ease-out}
    .swarm-inviting .swarm-halo{animation:swarm-invite 3.4s ease-in-out infinite;transform-box:fill-box;transform-origin:center}
    @keyframes swarm-enter{from{opacity:0}to{opacity:1}}
    @keyframes swarm-invite{0%,100%{opacity:.35;transform:scale(.94)}50%{opacity:1;transform:scale(1.07)}}
    @media(prefers-reduced-motion:reduce){.swarm-node-enter,.swarm-inviting .swarm-halo{animation:none}}
  `);
  const links = make('g'), nodes = make('g'), particles = make('g', { 'aria-hidden': 'true' });
  const origin = narrow ? { x: 78, y: 70 } : { x: 110, y: 165 }, self = narrow ? { x: 348, y: 70 } : { x: 445, y: 165 };
  const points = narrow ? [{ x: 348, y: 280 }, { x: 78, y: 280 }] :
    [{ x: 760, y: 165 }, { x: 785, y: 48 }, { x: 785, y: 278 }, { x: 650, y: 48 }, { x: 650, y: 278 }];
  function layout(count) {
    if (count <= points.length) return { points, height: narrow ? 390 : 385 };
    const rows = Math.ceil(count / 2), firstY = narrow ? 220 : 45, gap = narrow ? 115 : 120;
    const columns = narrow ? [130, 390] : [660, 840];
    return { points: Array.from({ length: count }, (_, index) => ({ x: columns[index % 2], y: firstY + Math.floor(index / 2) * gap })),
      height: Math.max(narrow ? 390 : 385, firstY + (rows - 1) * gap + 110) };
  }
  function curve(from, to, offset = 0) {
    const dx = to.x - from.x, dy = to.y - from.y, distance = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / distance, ny = dx / distance;
    const start = { x: from.x + dx / distance * (from === self ? 43 : 29), y: from.y + dy / distance * (from === self ? 43 : 29) };
    const end = { x: to.x - dx / distance * (to === self ? 43 : 29), y: to.y - dy / distance * (to === self ? 43 : 29) };
    const first = { x: start.x + (end.x - start.x) / 3 + nx * offset, y: start.y + (end.y - start.y) / 3 + ny * offset };
    const second = { x: start.x + (end.x - start.x) * 2 / 3 + nx * offset, y: start.y + (end.y - start.y) * 2 / 3 + ny * offset };
    return { start, end, first, second, d: `M${start.x} ${start.y} C${first.x} ${first.y},${second.x} ${second.y},${end.x} ${end.y}` };
  }
  function onCurve(value, t) {
    return { x: (1 - t) ** 3 * value.start.x + 3 * (1 - t) ** 2 * t * value.first.x + 3 * (1 - t) * t ** 2 * value.second.x + t ** 3 * value.end.x,
      y: (1 - t) ** 3 * value.start.y + 3 * (1 - t) ** 2 * t * value.first.y + 3 * (1 - t) * t ** 2 * value.second.y + t ** 3 * value.end.y };
  }
  function node(point, label, central = false, host = false) {
    const group = make('g', { class: 'swarm-node', transform: `translate(${point.x} ${point.y})` });
    const circle = make('circle', { r: central ? 35 : 24, fill: central ? '#c7f36b0d' : '#151a1b',
      stroke: central ? '#c7f36b' : '#697468', 'stroke-width': central ? 1.5 : 1 });
    group.append(circle);
    if (central) group.append(make('circle', { class: 'swarm-halo', r: 45, fill: 'none', stroke: '#c7f36b', 'stroke-opacity': .12 }));
    group.append(make('path', { d: host ? 'M-8-7h16v5h-16z M-8 2h16v5h-16z' : 'M-11-8h22v15h-22z M-6 12h12 M0 7v5',
      fill: 'none', stroke: central ? '#c7f36b' : '#c5ccc4', 'stroke-width': 1.2 }));
    group.append(make('rect', { x: -106, y: central ? 55 : 36, width: 212, height: 48, rx: 8, fill: '#151c12', 'fill-opacity': .94 }));
    const name = make('text', { class: 'swarm-label', y: central ? 73 : 53, 'text-anchor': 'middle' }, label);
    const detail = make('text', { class: 'swarm-sub', y: central ? 92 : 72, 'text-anchor': 'middle' }, '');
    group.append(name, detail); nodes.append(group);
    return { group, name, detail, circle, point };
  }
  const hostNode = node(origin, 'Media host', false, true), selfNode = node(self, 'You', true);
  hostNode.group.dataset.swarmNode = 'origin'; selfNode.group.dataset.swarmNode = 'self';
  const emptyLabel = make('text', { x: narrow ? 260 : 760, y: narrow ? 270 : 157, fill: '#969f92', 'font-size': narrow ? 17 : 14,
    'font-family': 'Inter,system-ui,sans-serif', 'text-anchor': 'middle' }, 'The next listener could be here.');
  const emptySub = make('text', { x: narrow ? 260 : 760, y: narrow ? 296 : 180, fill: '#6d7d6b', 'font-size': narrow ? 14 : 11,
    'font-family': 'Inter,system-ui,sans-serif', 'text-anchor': 'middle' }, 'Room presence and real video transfers.');
  nodes.append(emptyLabel, emptySub);
  svg.append(title, description, style, links, particles, nodes);
  const strength = document.createElement('div'); strength.className = 'swarm-strength';
  strength.innerHTML = '<div class="swarm-strength-heading"><span>Your peer delivery</span><output data-swarm-strength-value>Waiting for video traffic</output></div><div class="swarm-strength-meter" data-swarm-strength-meter role="meter" aria-label="Share of video received here from verified peers over the last ten seconds" aria-valuemin="0" aria-valuemax="100"><span></span></div><p data-swarm-strength-note>Only this browser’s received video, over the last 10 seconds.</p>';
  const strengthValue = strength.querySelector('[data-swarm-strength-value]'), strengthMeter = strength.querySelector('[data-swarm-strength-meter]'),
    strengthFill = strengthMeter.firstElementChild, strengthNote = strength.querySelector('[data-swarm-strength-note]');
  container.classList.add('swarm-map-with-strength'); container.replaceChildren(svg, strength);
  const members = new Map(), edges = new Map(), activeFlights = new Set();
  let destroyed = false, animationFrame;
  function clearFlights(id) {
    for (const flight of activeFlights) if (id === undefined || flight.edgeId === id) { flight.dot.remove(); activeFlights.delete(flight); }
  }
  function sizeFlights() {
    const largest = Math.max(1, ...[...activeFlights].map(flight => flight.count));
    for (const flight of activeFlights) flight.dot.setAttribute('r', Math.max(1.1, 7 * Math.sqrt(flight.count / largest)));
  }
  function fly(shape, colour, count, source, edgeId) {
    if (destroyed || reduced?.matches || !number(count) || activeFlights.size >= 20 || document.hidden) return;
    const dot = make('circle', { r: 1.1, fill: colour, 'fill-opacity': .95 });
    Object.assign(dot.dataset, { flightSource: source, bytes: String(count), edgeId });
    particles.append(dot); activeFlights.add({ dot, shape, edgeId, count, start: performance.now() }); sizeFlights();
    if (animationFrame === undefined) animationFrame = requestAnimationFrame(animate);
  }
  function animate(now) {
    animationFrame = undefined;
    for (const flight of activeFlights) {
      const t = Math.min(1, Math.max(0, (now - flight.start) / 1100)), point = onCurve(flight.shape, t);
      flight.dot.setAttribute('cx', point.x); flight.dot.setAttribute('cy', point.y);
      if (t >= 1) { flight.dot.remove(); activeFlights.delete(flight); }
    }
    if (activeFlights.size && !destroyed) { sizeFlights(); animationFrame = requestAnimationFrame(animate); }
  }
  function update(metrics = {}, silent = false) {
    if (destroyed) return;
    const now = Date.now(), model = observedRoomTopology(metrics, now, context.claims), currentLayout = layout(model.members.length);
    const selfId = model.self.id, locations = new Map([['origin', origin], [selfId, self]]);
    svg.setAttribute('viewBox', `0 0 ${narrow ? 520 : 960} ${currentLayout.height}`);
    selfNode.name.textContent = model.self.label;
    if (model.self.roomMember) selfNode.group.dataset.roomMemberId = selfId; else delete selfNode.group.dataset.roomMemberId;
    selfNode.group.dataset.viewerId = model.self.peerId ?? '';
    const liveMembers = new Set(model.members.map(member => member.id));
    for (const [id, record] of members) if (!liveMembers.has(id)) { record.group.remove(); members.delete(id); }
    model.members.forEach((member, index) => {
      const point = currentLayout.points[index]; locations.set(member.id, point);
      let record = members.get(member.id);
      if (!record) { record = node(point, member.label); record.group.classList.add('swarm-node-enter'); members.set(member.id, record); }
      record.point = point; record.group.setAttribute('transform', `translate(${point.x} ${point.y})`);
      record.name.textContent = member.label;
      record.circle.setAttribute('stroke', member.connected ? '#c7f36b' : member.report ? '#a1bfff' : '#65715f');
      record.circle.setAttribute('stroke-dasharray', member.connected ? '' : '3 5');
      record.circle.setAttribute('fill', member.connected ? '#c7f36b0b' : 'none');
      record.detail.textContent = member.connected ? 'Connected to you' : member.report ? 'Reporting video' : 'In the room · no report';
      record.group.dataset.swarmNode = 'listener';
      if (member.roomMember) record.group.dataset.roomMemberId = member.id; else delete record.group.dataset.roomMemberId;
      if (member.connectionId) record.group.dataset.peerId = member.connectionId; else delete record.group.dataset.peerId;
      record.group.dataset.viewerId = member.peerId ?? '';
      record.group.dataset.connected = String(member.connected);
      const local = observedTopology(metrics).find(peer => peer.id === member.connectionId);
      record.group.dataset.mediaBytesSent = String(local?.mediaBytesSent ?? 0);
      record.group.dataset.verifiedMediaBytesReceived = String(local?.verifiedMediaBytesReceived ?? 0);
    });
    const readings = [], liveTraffic = new Set();
    for (const edge of model.edges) {
      if (!locations.has(edge.from) || !locations.has(edge.to)) continue;
      for (const direction of ['forward', 'reverse']) {
        const observation = edge[direction]; if (!observation) continue;
        liveTraffic.add(observation.sourceId);
        const value = context.traffic.observe(observation.sourceId, observation.value, observation.sampledAt, now);
        readings.push({ edge, direction, ...value });
      }
    }
    context.traffic.retain(liveTraffic);
    const maximumRate = Math.max(1, ...readings.map(value => metrics.playing || value.edge.kind.startsWith('reported') ? value.rate : 0));
    const liveEdges = new Set(model.edges.map(edge => edge.id));
    for (const [id, record] of edges) if (!liveEdges.has(id)) { clearFlights(id); record.group.remove(); edges.delete(id); }
    for (const edge of model.edges) {
      const from = locations.get(edge.from), to = locations.get(edge.to); if (!from || !to) continue;
      let record = edges.get(edge.id);
      if (!record) { const group = make('g'); links.append(group); record = { group, paths: {} }; edges.set(edge.id, record); }
      Object.assign(record.group.dataset, { edgeId: edge.id, edgeKind: edge.kind, fromMemberId: edge.from, toMemberId: edge.to,
        fromPeerId: edge.fromPeerId ?? '', toPeerId: edge.toPeerId ?? '' });
      if (edge.connectionId) record.group.dataset.connectionId = edge.connectionId;
      record.group.dataset.attribution = edge.kind.startsWith('reported') ? 'listener-reported' : 'measured-here';
      for (const direction of ['forward', 'reverse']) {
        const reading = readings.find(value => value.edge === edge && value.direction === direction);
        if (!reading) continue;
        const reverse = direction === 'reverse', source = edge.kind === 'native-peer' ? reverse ? 'peer-download' : 'peer-upload' :
          edge.kind === 'origin' ? 'origin' : edge.kind === 'reported-origin' ? 'reported-origin' : 'reported-peer';
        const colour = edge.kind.includes('origin') ? '#d6c5a1' : reverse ? '#a1bfff' : '#c7f36b';
        const reported = edge.kind.startsWith('reported'), shape = curve(reverse ? to : from, reverse ? from : to,
          edge.kind === 'reported-origin' ? -46 : edge.reverse ? 13 : 0);
        let part = record.paths[direction];
        if (!part) {
          const path = make('path', { class: 'swarm-link' }), label = make('text', { class: 'swarm-rate', 'text-anchor': 'middle' });
          record.group.append(path, label); part = { path, label }; record.paths[direction] = part;
        }
        const rate = metrics.playing || reported ? reading.rate : 0, width = 1 + 5 * rate / maximumRate;
        part.path.setAttribute('d', shape.d); part.path.setAttribute('stroke', colour); part.path.setAttribute('stroke-width', width);
        part.path.setAttribute('stroke-opacity', rate > 0 ? reported ? .55 : .9 : .25);
        part.path.setAttribute('stroke-dasharray', reported ? '4 6' : edge.relay ? '2 4' : '');
        Object.assign(part.path.dataset, { direction: edge.kind === 'native-peer' ? reverse ? 'download' : 'upload' : direction,
          bytesPerSecond: String(rate), cumulativeBytes: String(edge[direction].value ?? '') });
        record.group.dataset[reverse ? 'receivedBps' : 'sentBps'] = String(rate);
        const middle = onCurve(shape, reverse ? .58 : .42);
        part.label.setAttribute('x', middle.x); part.label.setAttribute('y', middle.y + (reverse ? 13 : -7));
        part.label.textContent = `${bytes(rate)}/s${reported ? ' · reported' : ''}`;
        if ((metrics.playing || reported) && !silent) fly(shape, colour, reading.delta, source, edge.id);
      }
    }
    if (!metrics.playing) for (const [id] of edges) if (!model.edges.find(edge => edge.id === id)?.kind.startsWith('reported')) clearFlights(id);
    emptyLabel.style.display = emptySub.style.display = model.members.length ? 'none' : '';
    selfNode.detail.textContent = !metrics.active ? 'Ready to listen' : !metrics.playing ? 'Paused' : metrics.enabled && metrics.serving ? 'Listening & sharing' : 'Listening';
    const knownRoom = metrics.room?.observed === true, roomCount = counter(metrics.room?.listeners);
    const inviting = knownRoom && roomCount === 0 && !metrics.playing;
    selfNode.group.classList.toggle('swarm-inviting', inviting);
    emptyLabel.textContent = inviting ? 'Be the first to start the room.' : knownRoom && roomCount > 0 && !metrics.active ?
      `${roomCount} ${roomCount === 1 ? 'listener' : 'listeners'} · Join the room` : 'The next listener could be here.';
    emptySub.textContent = inviting ? 'Press Play. Your browser starts the shared stream.' : 'Room presence and real video transfers.';
    hostNode.detail.textContent = `${bytes(metrics.originBytes ?? (metrics.active ? null : 0))} to you`;
    const originValue = counter(metrics.originBytes), peerValue = counter(metrics.peerBytes);
    let originRate = 0, peerRate = 0;
    if (metrics.playing && originValue !== null && peerValue !== null) {
      originRate = context.strength.observe('origin', originValue, now, now).rate;
      peerRate = context.strength.observe('peer', peerValue, now, now).rate;
    } else context.strength.clear();
    const share = metrics.playing && originValue !== null && peerValue !== null ? peerDeliveryShare(originRate, peerRate) : null;
    const percentage = share === null ? null : Math.round(share * 100);
    strengthValue.textContent = percentage === null ? 'Waiting for video traffic' : `${percentage}%`;
    strengthFill.style.width = `${percentage ?? 0}%`;
    if (percentage === null) strengthMeter.removeAttribute('aria-valuenow'); else strengthMeter.setAttribute('aria-valuenow', percentage);
    strengthMeter.setAttribute('aria-valuetext', percentage === null ? 'No recent received video measured' : `${percentage}% of received video from verified peers, over the last ten seconds`);
    strengthNote.textContent = share === null ? 'Only this browser’s received video, over the last 10 seconds.' :
      `${bytes(peerRate * 10)} verified from peers / ${bytes((peerRate + originRate) * 10)} received here · last 10 seconds`;
    container.dataset.peerSharePercent = percentage === null ? '' : String(percentage);
    container.dataset.strengthScope = 'local-verified-video-share-10s';
    container.dataset.connectedPeers = String(model.connectedPeers);
    container.dataset.observedPeers = String(model.members.length);
    container.dataset.roomMembers = String(model.roomMemberCount);
    container.dataset.inviting = String(inviting);
    container.dataset.unmappedConnections = String(model.unmappedConnections);
    container.dataset.originBytes = String(number(metrics.originBytes));
    container.dataset.peerBytes = String(number(metrics.peerBytes));
    container.dataset.uploadedBytes = String(number(metrics.uploadedBytes));
    svg.setAttribute('aria-label', `The media host, your browser and ${model.members.length} other observed listener${model.members.length === 1 ? '' : 's'}. Solid links are local measurements; dashed links are listener reports. ${number(metrics.peerBytes)} verified peer bytes received; ${number(metrics.uploadedBytes)} video bytes uploaded.`);
  }
  const destroy = () => {
    destroyed = true;
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    activeFlights.clear(); members.clear(); edges.clear(); container.replaceChildren();
  };
  return { update, destroy };
}

export function createSwarmVisual(container) {
  const context = { claims: new Map(), traffic: createTrafficWindow(), strength: createTrafficWindow() };
  let visual = drawSwarmVisual(container, context), last = {}, narrow = container.clientWidth < 600;
  visual.update(last, true);
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const next = container.clientWidth < 600;
    if (next === narrow || container.clientWidth === 0) return;
    narrow = next;
    visual.destroy(); visual = drawSwarmVisual(container, context);
    visual.update(last, true);
  }) : null;
  observer?.observe(container);
  return {
    update(metrics) { last = metrics ?? {}; visual.update(last); },
    destroy() { observer?.disconnect(); visual.destroy(); context.claims.clear(); context.traffic.clear(); context.strength.clear(); },
  };
}
