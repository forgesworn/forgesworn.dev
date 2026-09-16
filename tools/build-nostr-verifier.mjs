// Offline build from exact installed versions. Set FLY_BUILD_NODE_MODULES if needed.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const modules = resolve(process.env.FLY_BUILD_NODE_MODULES || 'node_modules');
const require = createRequire(resolve(modules, '../package.json'));
const versions = { esbuild: '0.28.2', '@noble/curves': '2.0.1' };
for (const [name, expected] of Object.entries(versions)) {
  const pkg = JSON.parse(await readFile(resolve(modules, name, 'package.json'), 'utf8'));
  if (pkg.version !== expected) throw new Error(`Expected ${name}@${expected}`);
}
const { outputFiles } = await require('esbuild').build({
  entryPoints: ['tools/nostr-verify-entry.mjs'], bundle: true, write: false,
  nodePaths: [modules], format: 'esm', platform: 'browser', target: 'es2022', minify: true,
});
const output = outputFiles[0].contents;
await mkdir('site/fly/vendor', { recursive: true });
await writeFile('site/fly/vendor/nostr-verify.js', output);
const curves = resolve(modules, '@noble/curves');
const hashes = resolve(curves, 'node_modules/@noble/hashes');
const hashesPackage = JSON.parse(await readFile(resolve(hashes, 'package.json'), 'utf8'));
if (hashesPackage.version !== '2.0.1') throw new Error('Expected @noble/hashes@2.0.1');
await writeFile('site/fly/vendor/THIRD_PARTY_NOTICES.txt',
  '@noble/curves 2.0.1\n' + await readFile(resolve(curves, 'LICENSE'), 'utf8') +
  '\n@noble/hashes 2.0.1\n' + await readFile(resolve(hashes, 'LICENSE'), 'utf8'));
await writeFile('site/fly/vendor/BUILD.json', JSON.stringify({
  builder: 'esbuild@0.28.2', dependencies: { '@noble/curves': '2.0.1', '@noble/hashes': '2.0.1' },
  source: 'tools/nostr-verify-entry.mjs', sha256: createHash('sha256').update(output).digest('hex'),
}, null, 2) + '\n');
console.log(`Built Nostr signature verifier: ${output.length} bytes`);
