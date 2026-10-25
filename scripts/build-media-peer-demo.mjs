#!/usr/bin/env node
// Bundle an exact public RelaySwarm revision without modifying its checkout.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SOURCE = '8d3b759fdb3358fbda2f002df51f42421990198f';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../', import.meta.url));

export async function buildPeerDemo(checkout) {
  const scratch = await mkdtemp(join(tmpdir(), 'forgesworn-media-peer-'));
  try {
    const archive = execFileSync('git', ['archive', SOURCE, 'src', 'core', 'package.json', 'package-lock.json', 'LICENSE'],
      { cwd: checkout, maxBuffer: 16 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const packageJson = JSON.parse(await readFile(join(scratch, 'package.json'), 'utf8'));
    const lock = await readFile(join(scratch, 'package-lock.json'));
    if (!lock.equals(await readFile(join(checkout, 'package-lock.json')))) {
      throw new Error('The source checkout dependencies do not match the pinned public revision.');
    }
    await symlink(join(checkout, 'node_modules'), join(scratch, 'node_modules'), 'dir');
    const { build } = await import(pathToFileURL(join(checkout, 'node_modules/esbuild/lib/main.js')).href);
    const entry = `export const relayswarmBuild = Object.freeze(${JSON.stringify({ version: packageJson.version, sourceCommit: SOURCE })});
export { createHlsSwarm } from './src/browser/hls-swarm.mjs';
export { commitmentContent, commitmentPieceSize, KIND_SEGMENT_COMMITMENT, segmentMediaContext } from './src/browser/segment-commitment.mjs';
export { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools/pure';
export { matchFilter } from 'nostr-tools/filter';\n`;
    await writeFile(join(scratch, 'entry.mjs'), entry);
    const built = await build({ entryPoints: ['entry.mjs'], absWorkingDir: scratch, bundle: true,
      platform: 'browser', format: 'esm', minify: true, write: false, sourcemap: false,
      preserveSymlinks: true, metafile: true, logLevel: 'silent',
      banner: { js: `/*! RelaySwarm ${packageJson.version}; public source ${SOURCE}. See media-peer-demo.NOTICE.txt. */` } });
    const bytes = built.outputFiles[0].contents;
    // The host supplies this explicit companion URL; bundlers must not infer
    // an adjacent source file from the single bundled SDK entry point.
    const worker = await build({ entryPoints: ['src/browser/core-transfer-worker-runtime.mjs'], absWorkingDir: scratch,
      bundle: true, platform: 'browser', format: 'esm', minify: true, write: false, sourcemap: false,
      preserveSymlinks: true, metafile: true, logLevel: 'silent',
      banner: { js: `/*! RelaySwarm ${packageJson.version} transfer worker; public source ${SOURCE}. See media-peer-demo.NOTICE.txt. */` } });
    const workerBytes = worker.outputFiles[0].contents;
    const packages = new Set();
    for (const file of [...Object.keys(built.metafile.inputs), ...Object.keys(worker.metafile.inputs)]) {
      const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file);
      if (match) packages.add(match[1]);
    }
    const dependencies = [];
    const notices = [`RelaySwarm ${packageJson.version}\nhttps://github.com/forgesworn/relayswarm/tree/${SOURCE}\n`,
      await readFile(join(scratch, 'LICENSE'), 'utf8')];
    for (const name of [...packages].sort()) {
      const directory = join(checkout, 'node_modules', name);
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      const installed = JSON.parse(lock).packages[`node_modules/${name}`];
      if (!installed || installed.version !== metadata.version) throw new Error('Installed bundle dependency does not match its lockfile.');
      const files = (await readdir(directory)).filter(file => /^(?:licen[cs]e|copying)(?:\.[a-z]+)?$/i.test(file));
      if (!files.length) throw new Error('A bundled dependency has no discoverable licence notice.');
      dependencies.push({ name, version: metadata.version, licence: metadata.license });
      notices.push(`\n\n===== ${name} ${metadata.version} =====\n`);
      for (const file of files.sort()) notices.push(await readFile(join(directory, file), 'utf8'));
    }
    const directory = join(root, 'site/vendor');
    await mkdir(directory, { recursive: true });
    const wasm = await readFile(join(scratch, 'src/browser/relayswarm-core.wasm'));
    if (wasm.length > 1024 * 1024 || !WebAssembly.validate(wasm)) throw new Error('The pinned browser core is not a bounded valid WASM module.');
    // Resolve the pinned lockfile offline to collect notices. This neither
    // builds Rust nor creates a target directory; it reuses installed sources.
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--offline', '--locked', '--filter-platform', 'wasm32-unknown-unknown', '--format-version', '1'],
      { cwd: join(scratch, 'core'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
    const packagesById = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
    const nodesById = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
    const wasmRoot = metadata.packages.find(pkg => pkg.name === 'relayswarm-wasm');
    if (!wasmRoot) throw new Error('The pinned source has no browser core package.');
    const included = new Set();
    const visit = id => { if (included.has(id)) return; included.add(id); for (const dep of nodesById.get(id)?.deps ?? []) visit(dep.pkg); };
    visit(wasmRoot.id);
    const wasmDependencies = [], wasmNotices = [`RelaySwarm Rust/WebAssembly core\nhttps://github.com/forgesworn/relayswarm/tree/${SOURCE}\n`, await readFile(join(scratch, 'LICENSE'), 'utf8')];
    for (const pkg of [...included].map(id => packagesById.get(id)).filter(pkg => pkg.source).sort((a, b) => a.name.localeCompare(b.name))) {
      const dependencyDirectory = dirname(pkg.manifest_path);
      const files = (await readdir(dependencyDirectory)).filter(file => /^(?:licen[cs]e|copying|notice)(?:[.-][a-z0-9_.-]+)?$/i.test(file));
      if (!pkg.license || !files.length) throw new Error('A browser core dependency has no licence notice.');
      wasmDependencies.push({ name: pkg.name, version: pkg.version, licence: pkg.license });
      wasmNotices.push(`\n\n===== ${pkg.name} ${pkg.version} (${pkg.license}) =====\n`);
      for (const file of files.sort()) wasmNotices.push(await readFile(join(dependencyDirectory, file), 'utf8'));
    }
    await writeFile(join(directory, 'relayswarm-core.wasm'), wasm);
    await writeFile(join(directory, 'relayswarm-core.NOTICE.txt'), wasmNotices.join('\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''));
    await writeFile(join(directory, 'media-peer-demo.js'), bytes);
    await writeFile(join(directory, 'relayswarm-transfer-worker.js'), workerBytes);
    await writeFile(join(directory, 'media-peer-demo.NOTICE.txt'), notices.join('\n'));
    const receipt = { schema: 1, project: 'https://github.com/forgesworn/relayswarm', sourceCommit: SOURCE,
      version: packageJson.version, sourceArchiveSha256: sha(archive), packageLockSha256: sha(lock),
      bundle: 'media-peer-demo.js', bundleSha256: sha(bytes), bundleBytes: bytes.length,
      transferWorker: { file: 'relayswarm-transfer-worker.js', bytes: workerBytes.length, sha256: sha(workerBytes),
        source: 'src/browser/core-transfer-worker-runtime.mjs' },
      sourceMap: false, originalSourceModified: false, dependencies,
      coreWasm: { file: 'relayswarm-core.wasm', bytes: wasm.length, sha256: sha(wasm), source: 'src/browser/relayswarm-core.wasm',
        rustBuildPerformed: false, dependencies: wasmDependencies } };
    await writeFile(join(directory, 'media-peer-demo.build.json'), JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/build-media-peer-demo.mjs /path/to/relayswarm');
  console.log(JSON.stringify(await buildPeerDemo(resolve(process.argv[2])), null, 2));
}
