import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLabTurnOperator, LAB_TURN_LIMITS } from '../scripts/media-lab-turn.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function eventually(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await wait(20); }
  assert.fail('The bounded fixture deadline expired.');
}

async function fixture(t, { stall = false, stubborn = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'forgesworn-lab-turn-test-'));
  const binary = path.join(root, 'operator'), record = path.join(root, 'record.jsonl');
  t.after(async () => {
    try {
      for (const item of (await readFile(record, 'utf8')).trim().split('\n').map(JSON.parse)) {
        try { process.kill(process.platform === 'win32' ? item.pid : -item.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs'),net=require('node:net'),dgram=require('node:dgram');
const args=process.argv.slice(2),configuration=args[0]==='-c'?args[1]:null;
const text=configuration?fs.readFileSync(configuration,'utf8'):'';
const config=Object.fromEntries(text.trim().split('\\n').map(line=>{const at=line.indexOf('=');return at<0?[line,true]:[line.slice(0,at),line.slice(at+1)];}));
const port=configuration?Number(config['listening-port']):Number(args[args.indexOf('--listen')+1].split(':')[1]);
const secret=configuration?config['static-auth-secret']:process.env.SPRY_TURN_SECRET;
const descendant=${stubborn}?require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}):null;
fs.appendFileSync(${JSON.stringify(record)},JSON.stringify({pid:process.pid,descendant:descendant?.pid,configuration,config,secret,args})+'\\n',{mode:0o600});
console.log('PRIVATE_CHILD_OUTPUT',secret);console.error('PRIVATE_CHILD_OUTPUT',secret);
if(${stubborn})process.on('SIGTERM',()=>{});
if(${stall})setInterval(()=>{},1000);
else{net.createServer(socket=>socket.end()).listen(port,'127.0.0.1');const udp=dgram.createSocket('udp4');
udp.on('message',(request,peer)=>{const reply=Buffer.from(request);reply.writeUInt16BE(0x0101,0);udp.send(reply,peer.port,peer.address);});udp.bind(port,'127.0.0.1');}
`, { mode: 0o700 });
  return { binary, record };
}

test('both lab operators isolate REST viewers and apply matching loopback quotas', { timeout: 10_000 }, async t => {
  for (const engine of ['spry', 'coturn']) {
    const f = await fixture(t);
    const operator = await startLabTurnOperator({ engine, spry: f.binary, coturn: f.binary, transport: 'tcp' });
    t.after(() => operator.stop());
    const record = JSON.parse((await readFile(f.record, 'utf8')).trim());
    assert(alive(record.pid));
    assert.equal(operator.runtime.engine, engine);
    assert.equal(operator.runtime.iceTransportPolicy, 'relay');
    const [a, b] = operator.runtime.iceServersByViewer.map(([entry]) => entry);
    assert.notEqual(a.username, b.username);
    for (const viewer of [a, b]) {
      assert.match(viewer.urls[0], /^turn:127\.0\.0\.1:\d+\?transport=tcp$/);
      assert.equal(viewer.credential, createHmac('sha1', record.secret).update(viewer.username).digest('base64'));
      assert(Math.abs(Number(viewer.username.split(':')[0]) - Date.now() / 1000 - 600) < 3);
    }
    if (engine === 'coturn') {
      assert.equal((await stat(record.configuration)).mode & 0o777, 0o600);
      assert.equal(record.config['listening-ip'], '127.0.0.1'); assert.equal(record.config['relay-ip'], '127.0.0.1');
      assert.equal(Number(record.config['max-bps']), LAB_TURN_LIMITS.bytesPerSecond);
      assert.equal(Number(record.config['total-quota']), LAB_TURN_LIMITS.allocations);
      assert.equal(Number(record.config['user-quota']), LAB_TURN_LIMITS.perUser);
      assert(record.config['allow-loopback-peers'] && record.config['no-tls'] && record.config['no-dtls']);
      assert(!record.args.some(value => value.includes(record.secret)));
    } else {
      assert(record.args.includes('--allow-loopback-peers'));
      assert.equal(record.args[record.args.indexOf('--bytes-per-second') + 1], String(LAB_TURN_LIMITS.bytesPerSecond));
    }
    await operator.stop(); await operator.stop();
    assert(!alive(record.pid));
    if (record.configuration) await assert.rejects(stat(record.configuration), { code: 'ENOENT' });
  }
});

test('cancellation kills a stalled native process group and removes private coturn configuration', { timeout: 10_000 }, async t => {
  const f = await fixture(t, { stall: true, stubborn: true }), cancellation = new AbortController();
  const starting = startLabTurnOperator({ engine: 'coturn', coturn: f.binary, signal: cancellation.signal, stopGraceMs: 100 });
  const rejected = assert.rejects(starting, /cancelled/);
  await eventually(async () => { try { await readFile(f.record); return true; } catch { return false; } });
  const record = JSON.parse((await readFile(f.record, 'utf8')).trim());
  cancellation.abort(); await rejected;
  await eventually(() => !alive(record.pid) && !alive(record.descendant));
  await assert.rejects(stat(record.configuration), { code: 'ENOENT' });
});

test('a successful lab operator expires even if its owner forgets to stop it', { timeout: 6000 }, async t => {
  const f = await fixture(t);
  const operator = await startLabTurnOperator({ engine: 'spry', spry: f.binary, maxDurationMs: 100 });
  t.after(() => operator.stop());
  await eventually(() => !alive(operator.process.pid)); await operator.stop();
});
