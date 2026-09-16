// Offline build of the QR encoder from exact installed versions. Set FLY_BUILD_NODE_MODULES if needed.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const modules = resolve(process.env.FLY_BUILD_NODE_MODULES || 'node_modules');
const require = createRequire(resolve(modules, '../package.json'));
const versions = { esbuild: '0.28.2', uqr: '0.1.3' };
for (const [name, expected] of Object.entries(versions)) {
  const pkg = JSON.parse(await readFile(resolve(modules, name, 'package.json'), 'utf8'));
  if (pkg.version !== expected) throw new Error(`Expected ${name}@${expected}`);
}
const { outputFiles } = await require('esbuild').build({
  entryPoints: ['tools/qr-entry.mjs'], bundle: true, write: false,
  nodePaths: [modules], format: 'esm', platform: 'browser', target: 'es2022', minify: true,
});
const output = outputFiles[0].contents;
await mkdir('site/fly/vendor', { recursive: true });
await writeFile('site/fly/vendor/qr.js', output);
await writeFile('site/fly/vendor/THIRD_PARTY_NOTICES-qr.txt', 'uqr 0.1.3\n' + await readFile(resolve(modules, 'uqr/LICENSE'), 'utf8'));
await writeFile('site/fly/vendor/BUILD-qr.json', JSON.stringify({
  builder: 'esbuild@0.28.2', dependencies: { uqr: '0.1.3' },
  source: 'tools/qr-entry.mjs', sha256: createHash('sha256').update(output).digest('hex'),
}, null, 2) + '\n');
console.log(`Built QR encoder: ${output.length} bytes`);
