/**
 * check-catalogue-drift.mjs
 * Compares forgesworn-repos.json against the live GitHub org so the
 * catalogue cannot rot silently. Fails (exit 1) when:
 *   - a public non-fork org repo is neither catalogued nor excluded
 *   - a catalogued repo is no longer public (private, renamed, deleted)
 *   - the recorded totals disagree with the live counts
 *
 * Usage: node scripts/check-catalogue-drift.mjs [path-to-catalogue.json]
 * Set GITHUB_TOKEN to raise the API rate limit (optional).
 */

import { readFileSync } from 'node:fs';

const ORG = 'forgesworn';
const cataloguePath = process.argv[2] || 'forgesworn-repos.json';

async function fetchOrgRepos() {
  const headers = { 'User-Agent': 'forgesworn-catalogue-drift-check' };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const repos = [];
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/orgs/${ORG}/repos?type=public&per_page=100&page=${page}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status} for page ${page}`);
    }
    const batch = await res.json();
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

const catalogue = JSON.parse(readFileSync(cataloguePath, 'utf8'));
const catalogued = catalogue.categories.flatMap(c => c.repos.map(r => r.name));
const excluded = catalogue.excludedPublicRepos.map(r => r.name);

const live = await fetchOrgRepos();
const liveNames = new Set(live.map(r => r.name));
const liveNonFork = live.filter(r => !r.fork).map(r => r.name);

const knownNames = new Set([...catalogued, ...excluded]);
const missingFromCatalogue = liveNonFork.filter(name => !knownNames.has(name));
const goneFromOrg = catalogued.filter(name => !liveNames.has(name));

const problems = [];
if (missingFromCatalogue.length) {
  problems.push(
    `Public repos missing from the catalogue (add them or list them in excludedPublicRepos):\n` +
    missingFromCatalogue.map(n => `  - ${n}`).join('\n'),
  );
}
if (goneFromOrg.length) {
  problems.push(
    `Catalogued repos that are no longer public on GitHub (remove or fix):\n` +
    goneFromOrg.map(n => `  - ${n}`).join('\n'),
  );
}
if (catalogue.totalPublicRepos !== live.length) {
  problems.push(
    `totalPublicRepos is ${catalogue.totalPublicRepos} but the org has ${live.length} public repos.`,
  );
}
if (catalogue.catalogedProjectRepos !== catalogued.length) {
  problems.push(
    `catalogedProjectRepos is ${catalogue.catalogedProjectRepos} but the catalogue lists ${catalogued.length} repos.`,
  );
}

if (problems.length) {
  console.error(`Catalogue drift detected (${cataloguePath} vs github.com/${ORG}):\n`);
  console.error(problems.join('\n\n'));
  process.exit(1);
}

console.log(
  `Catalogue in sync: ${catalogued.length} catalogued + ${excluded.length} excluded ` +
  `covers all ${liveNonFork.length} public non-fork repos (${live.length} public total).`,
);
