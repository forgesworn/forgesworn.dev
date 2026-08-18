import { scan } from './shotguard.mjs';

// Synthetic identity terms. The real ones live outside the repo, because this
// repository is public and a test fixture is just as readable as source.
const OPSEC = [
  [/\bFirstname\b/i, 'real first name'],
  [/private-host\.example/i, 'private domain'],
  [/\/Users\/[a-z]+\//i, 'local filesystem path'],
];

const bech = '023456789acdefghjklmnpqrstuvwxyz';
const fake = (n) => Array.from({length:n}, (_,i) => bech[(i*7+3) % bech.length]).join('');

const cases = [
  ['clean marketing copy',            'Flash firmware, provision masters, approve requests. No account, no server.', false],
  ['an nsec',                          'Your key: nsec1' + fake(58), true],
  ['an encrypted nsec',                'Backup: ncryptsec1' + fake(40), true],
  ['a bunker URI with a secret',       'bunker://' + 'a'.repeat(64) + '?relay=wss://r.example&secret=Xy7fQ2mLp0aB', true],
  ['a bare 64-hex value',              'vault key ' + 'a1b2c3d4'.repeat(8), true],
  ['an OpenAI key',                    'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx', true],
  ['a GitHub token',                   'token ghp_abcdefghijklmnopqrstuvwxyz0123', true],
  ['a labelled PIN',                   'PIN: 481925', true],
  ['a labelled seed phrase',           'recovery phrase: abandon ability able about', true],
  ['a redacted identity term',         'Built by Firstname for the family', true],
  ['a local path',                     'Loaded from /Users/someone/Projects/sapwood', true],
  ['a private domain',                 'See private-host.example for the demo', true],
  ['an npub (public, must PASS)',      'npub1' + fake(58) + ' is your public identity', false],
  ['a relay URL (public, must PASS)',  'Connected to wss://relay.damus.io', false],
  ['a git sha (short, must PASS)',     'build 8f3c3cc on main', false],
];

const PUBKEY = 'b'.repeat(64);
cases.push(['a known-public pubkey, allowlisted (must PASS)', 'pubkey ' + PUBKEY, false, { allow: [PUBKEY] }]);
cases.push(['the same pubkey NOT allowlisted (must block)',   'pubkey ' + PUBKEY, true]);

let bad = 0;
for (const [name, text, shouldFlag, opts] of cases) {
  const hits = scan(text, { ...(opts || {}), opsec: OPSEC });
  const flagged = hits.length > 0;
  const ok = flagged === shouldFlag;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${shouldFlag ? 'must block' : 'must pass '}  ${name.padEnd(34)} ${flagged ? '-> ' + hits.map(h=>h.label).join('; ') : ''}`);
}
console.log(bad ? `\n${bad} FAILURES` : '\nall guard cases behave correctly');
process.exit(bad ? 1 : 0);
