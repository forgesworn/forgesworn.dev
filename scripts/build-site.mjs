/**
 * build-site.mjs
 * Reads forgesworn-repos.json + site/template.html, replaces marker comments
 * with generated HTML, and writes site/index.html. Likewise
 * forgesworn-use-cases.json + site/use-cases-template.html -> site/use-cases.html.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Presentation config — not in the JSON (presentation concern).
//   colour      the stack's accent
//   entryPoint  the repo a newcomer should start with
//   headline    the plain-English promise that heads the stack's section
//   plain       the one-line "what it lets you do" on the ecosystem map card
const CATEGORY_CONFIG = {
  l402:       { colour: '#e94560', entryPoint: 'toll-booth',         headline: 'Get paid per call, in sats, by people or machines.',    plain: 'Sell an API per request, connect to a wallet, carry bearer notes.' },
  identity:   { colour: '#16c79a', entryPoint: 'nsec-tree',          headline: 'Your keys, your names, your rules.',                    plain: 'Hardware signers, unlinkable personas, spoken verification, wardship.' },
  storage:    { colour: '#2a9d8f', entryPoint: 'wildbloom',          headline: 'Files that outlive the server they started on.',        plain: 'Encrypted, content-addressed storage across machines you control.' },
  live:       { colour: '#f472b6', entryPoint: 'kithmoot',           headline: 'Calls and streams with nobody in the middle.',          plain: 'Video rooms and live streams signalled over Nostr relays.' },
  spatial:    { colour: '#b5e04a', entryPoint: 'rendezvous-kit',     headline: 'Find each other without being tracked.',                plain: 'Fair meeting points, geohashes, and an offline Bluetooth mesh.' },
  agents:     { colour: '#00b4d8', entryPoint: 'bray',               headline: 'An AI agent with a name, a wallet and a web of trust.', plain: 'A Nostr MCP server that gives agents a sovereign identity.' },
  trust:      { colour: '#9b59b6', entryPoint: 'nostr-attestations', headline: 'Prove what matters, hide the rest.',                    plain: 'Anonymous vouches, attestations and votes.' },
  crypto:     { colour: '#f5a623', entryPoint: 'ring-sig',           headline: 'The maths under everything else.',                      plain: 'Ring signatures, range proofs, secret sharing, private equality.' },
  compliance: { colour: '#e17055', entryPoint: 'jurisdiction-kit',   headline: 'Know which rules apply where.',                         plain: 'Professional registries and jurisdiction data for 28 countries.' },
  protocol:   { colour: '#6c5ce7', entryPoint: 'nip-drafts',         headline: 'Specs anyone can implement twice.',                     plain: 'Nostr protocol drafts, conformance suites, Gopher over relays.' },
  tooling:    { colour: '#4a9eff', entryPoint: 'anvil',              headline: 'Ship it so nobody can tamper with it in transit.',      plain: 'Reproducible, attested npm releases and live demos.' },
};

const DISPLAY_ORDER = ['l402', 'identity', 'storage', 'live', 'spatial', 'agents', 'trust', 'crypto', 'compliance', 'protocol', 'tooling'];

// Repos with dedicated websites (presentation config, not in JSON)
const REPO_WEBSITES = {
  bray: 'https://bray.forgesworn.dev',
  '402-pub': 'https://402.pub',
  bark: 'https://bark.forgesworn.dev',
  cambium: 'https://cambium.forgesworn.dev',
  'canary-kit': 'https://canary.trotters.cc',
  'farrier-kit': 'https://farrier-kit.forgesworn.dev',
  gopherkind: 'https://gopherkind.com',
  'heartwood-esp32': 'https://heartwood.forgesworn.dev',
  kithmoot: 'https://kithmoot.forgesworn.dev',
  'nostr-veil': 'https://forgesworn.github.io/nostr-veil/',
  'nwc-kit': 'https://nwc-kit.forgesworn.dev',
  'rendezvous-kit': 'https://forgesworn.github.io/rendezvous-kit/',
  sapwood: 'https://sapwood.forgesworn.dev',
  signet: 'https://mysignet.app',
  wildbloom: 'https://wildbloom.forgesworn.dev',
};

// Repos with a live demo (presentation config, not in JSON)
const REPO_DEMOS = {
  'toll-booth': 'https://jokes.trotters.dev',
};

// Repos with architecture documentation (presentation config, not in JSON)
const REPO_DOCS = {
  heartwood: 'https://github.com/forgesworn/heartwood/blob/main/docs/ECOSYSTEM.md',
  bark: 'https://github.com/forgesworn/bark/blob/main/ARCHITECTURE.md',
  sapwood: 'https://github.com/forgesworn/sapwood/blob/main/ARCHITECTURE.md',
  'nsec-tree': 'https://github.com/forgesworn/nsec-tree/blob/main/ARCHITECTURE.md',
  'canary-kit': 'https://github.com/forgesworn/canary-kit/blob/main/WALKTHROUGH.md',
};

// Tags that name an implementation language other than TypeScript, shown as a
// chip so a reader can tell a Rust crate from an npm package at a glance.
const LANGUAGE_TAGS = { rust: 'Rust', python: 'Python', kotlin: 'Kotlin', swift: 'Swift', go: 'Go', java: 'Java' };

// On phones a stack shows its entry point plus this many more cards before
// folding the rest behind a "Show all" button. Desktop shows everything.
const FOLD_AFTER = 3;

// SVG connection definitions: [from, to, style]
const SVG_CONNECTIONS = [
  ['crypto',     'identity',  'solid'],
  ['crypto',     'trust',     'solid'],
  ['crypto',     'l402',      'dashed'],
  ['identity',   'l402',      'dashed'],
  ['identity',   'spatial',   'dashed'],
  ['identity',   'agents',    'solid'],
  ['identity',   'live',      'dashed'],
  ['identity',   'storage',   'dashed'],
  ['trust',      'identity',  'dashed'],
  ['compliance', 'identity',  'solid'],
];

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
];

// ─── Exported functions ────────────────────────────────────────────────────────

/**
 * "Eleven" for 11; digits beyond twenty.
 */
export function numberWord(n) {
  const word = NUMBER_WORDS[n];
  return word ? word[0].toUpperCase() + word.slice(1) : String(n);
}

/**
 * Returns { repos, stacks, npmPackages }
 */
export function computeStats(data) {
  let repos = 0;
  let npmPackages = 0;
  for (const cat of data.categories) {
    repos += cat.repos.length;
    npmPackages += cat.repos.filter(r => r.npm !== null).length;
  }
  return {
    repos,
    stacks: data.categories.length,
    npmPackages,
  };
}

/**
 * Returns HTML for <!-- HERO_STATS -->
 */
export function buildHeroStatsHtml(data) {
  const { repos, stacks, npmPackages } = computeStats(data);
  const stat = (value, label) =>
    `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
  return [
    stat(repos, 'open-source projects'),
    stat(stacks, 'focus areas'),
    stat(npmPackages, 'npm packages'),
  ].join('\n');
}

/**
 * Returns HTML for <!-- STACK_MAP_CARDS -->
 */
export function buildStackMapCardsHtml(data) {
  const catsBySlug = Object.fromEntries(data.categories.map(c => [c.slug, c]));
  return orderedSlugs(data)
    .map(slug => {
      const cat = catsBySlug[slug];
      const cfg = CATEGORY_CONFIG[slug] || {};
      const colour = cfg.colour || '#888';
      const repoCount = cat.repos.length;
      // Plain-English line if we have one; otherwise the first sentence of the description.
      const shortDesc = cfg.plain || cat.description.split('.')[0];
      return `<a class="stack-card" href="#stack-${escHtml(slug)}" data-stack="${escHtml(slug)}" style="--stack-colour: ${colour}">
  <div class="stack-card-accent"></div>
  <div class="stack-card-body">
    <div class="stack-card-header">
      <span class="stack-card-name">${escHtml(cat.name)}</span>
      <span class="stack-card-count">${repoCount}</span>
    </div>
    <p class="stack-card-desc">${escHtml(shortDesc)}</p>
  </div>
</a>`;
    })
    .join('\n');
}

/**
 * Returns HTML for <!-- STACK_MAP_SVG -->
 */
export function buildStackMapSvgHtml(data) {
  const slugSet = new Set(data.categories.map(c => c.slug));
  const lines = SVG_CONNECTIONS
    .filter(([from, to]) => slugSet.has(from) && slugSet.has(to))
    .map(([from, to, style]) => {
      const cfg = CATEGORY_CONFIG[from] || {};
      const colour = cfg.colour || '#888';
      const dashAttr = style === 'dashed' ? ' stroke-dasharray="6 4"' : '';
      return `  <line data-from="${from}" data-to="${to}" x1="0" y1="0" x2="0" y2="0" stroke="${colour}" stroke-width="2" stroke-opacity="0.6"${dashAttr}/>`;
    });
  return `<svg class="stack-map-svg" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">\n${lines.join('\n')}\n</svg>`;
}

/**
 * Returns HTML for <!-- STACK_SECTIONS -->
 */
export function buildStackSectionsHtml(data) {
  const catsBySlug = Object.fromEntries(data.categories.map(c => [c.slug, c]));
  return orderedSlugs(data)
    .map(slug => buildCategorySection(catsBySlug[slug], slug))
    .join('\n\n');
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * DISPLAY_ORDER first, then any category the JSON has that this file does not
 * know about yet, so a new category is never silently dropped from the page.
 */
function orderedSlugs(data) {
  const known = DISPLAY_ORDER.filter(slug => data.categories.some(c => c.slug === slug));
  const unknown = data.categories.map(c => c.slug).filter(slug => !DISPLAY_ORDER.includes(slug));
  return [...known, ...unknown];
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function repoLanguage(repo) {
  for (const tag of repo.tags || []) {
    if (LANGUAGE_TAGS[tag]) return LANGUAGE_TAGS[tag];
  }
  return null;
}

function buildRepoChips(repo) {
  const chips = [];
  const lang = repoLanguage(repo);
  if (lang) chips.push(`<span class="repo-chip">${escHtml(lang)}</span>`);
  if (repo.npm) chips.push(`<span class="repo-chip repo-chip--npm" title="${escHtml(repo.npm)}">npm</span>`);
  return chips.length ? `<div class="repo-chips">${chips.join('')}</div>` : '';
}

function buildRepoLinks(repo, extraClass = '') {
  const cls = `repo-link${extraClass}`;
  const links = [`<a class="${cls}" href="${escHtml(repo.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>`];
  const website = REPO_WEBSITES[repo.name];
  if (website) links.push(`<a class="${cls} repo-link--site" href="${escHtml(website)}" target="_blank" rel="noopener noreferrer">Website</a>`);
  const demo = REPO_DEMOS[repo.name];
  if (demo) links.push(`<a class="${cls} repo-link--demo" href="${escHtml(demo)}" target="_blank" rel="noopener noreferrer">Live demo</a>`);
  const docs = REPO_DOCS[repo.name];
  if (docs) links.push(`<a class="${cls} repo-link--docs" href="${escHtml(docs)}" target="_blank" rel="noopener noreferrer">Docs</a>`);
  return links.join('\n    ');
}

/**
 * Build a section element for one category.
 */
function buildCategorySection(cat, slug) {
  const cfg = CATEGORY_CONFIG[slug] || {};
  const colour = cfg.colour || '#888';
  const entryPointName = cfg.entryPoint || null;
  const entryRepo = entryPointName ? cat.repos.find(r => r.name === entryPointName) : null;
  const otherRepos = cat.repos.filter(r => r !== entryRepo);
  const npmCount = cat.repos.filter(r => r.npm).length;
  const headline = cfg.headline || cat.description.split('.')[0] + '.';

  const metaParts = [`${cat.repos.length} ${cat.repos.length === 1 ? 'project' : 'projects'}`];
  if (npmCount) metaParts.push(`${npmCount} on npm`);

  const headHtml = `<div class="stack-head">
  <span class="section-label">${escHtml(cat.name)}</span>
  <span class="stack-meta">${escHtml(metaParts.join(' · '))}</span>
  <a class="stack-up" href="#ecosystem">All stacks &uarr;</a>
</div>
<h2 class="section-title">${escHtml(headline)}</h2>
<p class="section-lede">${escHtml(cat.description)}</p>`;

  const entryCardHtml = entryRepo ? buildEntryRepoCard(entryRepo, colour) : '';

  const otherCardsHtml = otherRepos.length
    ? `<div class="repo-grid">\n${otherRepos.map((r, i) => buildRepoCard(r, i >= FOLD_AFTER)).join('\n')}\n</div>`
    : '';

  const foldHtml = otherRepos.length > FOLD_AFTER
    ? `<button class="repo-fold" type="button" aria-expanded="false" data-label-open="Show all ${cat.repos.length} projects" data-label-close="Show fewer">Show all ${cat.repos.length} projects</button>`
    : '';

  const flowChain = buildFlowChain(cat);
  const flowHtml = flowChain
    ? `<div class="flow-chain"><span class="flow-label">Typical flow</span>${flowChain.map(escHtml).join(' <span class="flow-arrow">→</span> ')}</div>`
    : '';

  return `<section class="stack-section" id="stack-${escHtml(slug)}" data-stack="${escHtml(slug)}" style="--stack-colour: ${colour}">
${headHtml}
${entryCardHtml}
${otherCardsHtml}
${foldHtml}
${flowHtml}
</section>`;
}

/**
 * Build the highlighted entry point card for a category.
 */
function buildEntryRepoCard(repo, colour) {
  const installCmd = repo.npm ? `npm install ${repo.npm}` : null;
  const installHtml = installCmd
    ? `<div class="install-block">
    <code class="install-cmd">${escHtml(installCmd)}</code>
    <button class="copy-btn" data-copy="${escHtml(installCmd)}" aria-label="Copy install command">Copy</button>
  </div>`
    : '';
  return `<div class="repo-card repo-card--entry" style="--stack-colour: ${colour}">
  <span class="entry-label">Start here</span>
  <div class="repo-card-head">
    <h3 class="repo-name">${escHtml(repo.name)}</h3>
    ${buildRepoChips(repo)}
  </div>
  <p class="repo-desc">${escHtml(repo.description)}</p>
  ${installHtml}
  <div class="repo-links">
    ${buildRepoLinks(repo)}
  </div>
</div>`;
}

/**
 * Build a standard repo card. Folded cards are hidden on phones until the
 * section's "Show all" button is pressed; desktop ignores the class.
 */
function buildRepoCard(repo, folded = false) {
  return `<div class="repo-card${folded ? ' repo-card--fold' : ''}">
  <div class="repo-card-head">
    <h3 class="repo-name">${escHtml(repo.name)}</h3>
    ${buildRepoChips(repo)}
  </div>
  <p class="repo-desc">${escHtml(repo.description)}</p>
  <div class="repo-links">
    ${buildRepoLinks(repo)}
  </div>
</div>`;
}

/**
 * Build a flow chain for a category from usedBy relationships within the category.
 * Returns an array of repo names in chain order, or null if no chain.
 */
export function buildFlowChain(category) {
  const names = new Set(category.repos.map(r => r.name));
  // Build adjacency: from -> to (A usedBy B means A -> B)
  const children = {};   // name -> [name]
  const inDegree = {};   // name -> count
  for (const r of category.repos) {
    inDegree[r.name] = inDegree[r.name] || 0;
    children[r.name] = children[r.name] || [];
    for (const dep of r.usedBy) {
      if (names.has(dep)) {
        children[r.name].push(dep);
        inDegree[dep] = (inDegree[dep] || 0) + 1;
      }
    }
  }

  // Roots: repos with no incoming edges and at least one outgoing edge
  const roots = category.repos
    .filter(r => (inDegree[r.name] || 0) === 0 && (children[r.name] || []).length > 0)
    .map(r => r.name);

  if (roots.length === 0) return null;

  // Follow the longest linear chain from the first root
  const chain = [roots[0]];
  let current = roots[0];
  const visited = new Set(chain);
  while (true) {
    const next = (children[current] || []).find(n => !visited.has(n));
    if (!next) break;
    chain.push(next);
    visited.add(next);
    current = next;
  }

  return chain.length >= 2 ? chain : null;
}

// ─── Use-cases page ──────────────────────────────────────────────────────────

const USE_CASE_FALLBACK_COLOUR = '#888';

/**
 * Build a lookup of repo name -> { github, npm } from the catalogue data so the
 * use-cases page can link each stack item back to its repo without duplicating URLs.
 */
export function buildRepoIndex(catalogueData) {
  const index = {};
  for (const cat of catalogueData.categories) {
    for (const repo of cat.repos) {
      index[repo.name] = { github: repo.github, npm: repo.npm };
    }
  }
  return index;
}

/**
 * Returns { useCases, categories, repos } counts for the use-cases hero.
 */
export function computeUseCaseStats(useCasesData) {
  const repos = new Set();
  for (const uc of useCasesData.useCases) {
    for (const item of uc.stack) repos.add(item.repo);
  }
  return {
    useCases: useCasesData.useCases.length,
    categories: useCasesData.categories.length,
    repos: repos.size,
  };
}

/**
 * Returns HTML for <!-- USE_CASES_HERO_STATS -->
 */
export function buildUseCasesHeroStatsHtml(useCasesData) {
  const { useCases, categories, repos } = computeUseCaseStats(useCasesData);
  const stat = (value, label) =>
    `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`;
  return [
    stat(useCases, 'end-to-end workflows'),
    stat(categories, 'problem domains'),
    stat(repos, 'building blocks used'),
  ].join('\n');
}

/**
 * Returns HTML for <!-- USE_CASE_FILTERS -->
 */
export function buildUseCaseFiltersHtml(useCasesData) {
  const counts = {};
  for (const uc of useCasesData.useCases) {
    counts[uc.category] = (counts[uc.category] || 0) + 1;
  }
  const pill = (slug, label, count, colour) =>
    `<button class="uc-filter" data-filter="${escHtml(slug)}"${colour ? ` style="--uc-colour: ${colour}"` : ''} type="button">${escHtml(label)} <span class="uc-filter-count">${count}</span></button>`;
  const all = `<button class="uc-filter is-active" data-filter="all" type="button">All <span class="uc-filter-count">${useCasesData.useCases.length}</span></button>`;
  const cats = useCasesData.categories
    .filter(c => counts[c.slug])
    .map(c => pill(c.slug, c.name, counts[c.slug], c.colour));
  return [all, ...cats].join('\n');
}

/**
 * Build one use-case card.
 */
function buildUseCaseCard(uc, colour, repoIndex) {
  const steps = uc.steps.map(s => `      <li>${escHtml(s)}</li>`).join('\n');

  const stack = uc.stack
    .map(item => {
      const meta = repoIndex[item.repo];
      const inner = `<span class="uc-chip-name">${escHtml(item.repo)}</span><span class="uc-chip-role">${escHtml(item.role)}</span>`;
      return meta && meta.github
        ? `      <a class="uc-chip" href="${escHtml(meta.github)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `      <span class="uc-chip">${inner}</span>`;
    })
    .join('\n');

  const protos = (uc.protocols || [])
    .map(p => `      <span class="uc-proto">${escHtml(p)}</span>`)
    .join('\n');

  return `<article class="uc-card" data-category="${escHtml(uc.category)}" id="${escHtml(uc.id)}" style="--uc-colour: ${colour}">
  <div class="uc-card-accent"></div>
  <span class="uc-persona">${escHtml(uc.persona)}</span>
  <h3 class="uc-title">${escHtml(uc.title)}</h3>
  <p class="uc-problem">${escHtml(uc.problem)}</p>
  <p class="uc-outcome">${escHtml(uc.outcome)}</p>
  <div class="uc-label">Workflow</div>
  <ol class="uc-steps">
${steps}
  </ol>
  <div class="uc-label">Built with</div>
  <div class="uc-stack">
${stack}
  </div>
  <div class="uc-protos">
${protos}
  </div>
</article>`;
}

/**
 * Returns HTML for <!-- USE_CASE_SECTIONS -->
 */
export function buildUseCaseSectionsHtml(useCasesData, repoIndex = {}) {
  const byCat = {};
  for (const uc of useCasesData.useCases) {
    (byCat[uc.category] = byCat[uc.category] || []).push(uc);
  }
  return useCasesData.categories
    .filter(cat => byCat[cat.slug] && byCat[cat.slug].length)
    .map(cat => {
      const colour = cat.colour || USE_CASE_FALLBACK_COLOUR;
      const cards = byCat[cat.slug].map(uc => buildUseCaseCard(uc, colour, repoIndex)).join('\n');
      return `<section class="uc-group" data-category="${escHtml(cat.slug)}" style="--uc-colour: ${colour}">
  <div class="uc-group-head">
    <span class="section-label" style="color: ${colour}">${escHtml(cat.name)}</span>
    <p class="uc-group-desc">${escHtml(cat.description)}</p>
  </div>
  <div class="uc-grid">
${cards}
  </div>
</section>`;
    })
    .join('\n\n');
}

// ─── Main build function ───────────────────────────────────────────────────────

export async function build(jsonPath, useCasesJsonPath) {
  const resolvedJson = jsonPath || join(ROOT, 'forgesworn-repos.json');
  const resolvedUseCases = useCasesJsonPath || join(ROOT, 'forgesworn-use-cases.json');
  const templatePath = join(ROOT, 'site', 'template.html');
  const outputPath = join(ROOT, 'site', 'index.html');

  const data = JSON.parse(readFileSync(resolvedJson, 'utf8'));
  const useCasesData = JSON.parse(readFileSync(resolvedUseCases, 'utf8'));
  let template = readFileSync(templatePath, 'utf8');

  template = template.replace('<!-- HERO_STATS -->', buildHeroStatsHtml(data));
  template = template.replace('<!-- STACK_MAP_CARDS -->', buildStackMapCardsHtml(data));
  template = template.replace('<!-- STACK_MAP_SVG -->', buildStackMapSvgHtml(data));
  template = template.replace('<!-- STACK_SECTIONS -->', buildStackSectionsHtml(data));
  template = template.replaceAll('<!-- STACK_COUNT_WORD -->', numberWord(data.categories.length));
  template = template.replaceAll('<!-- REPO_COUNT -->', String(computeStats(data).repos));
  template = template.replaceAll('<!-- USE_CASE_COUNT -->', String(useCasesData.useCases.length));

  writeFileSync(outputPath, template, 'utf8');

  const { repos, stacks, npmPackages } = computeStats(data);
  console.log(`Built site/index.html -- ${repos} repos, ${stacks} categories, ${npmPackages} npm packages`);
}

/**
 * Build site/use-cases.html from the use-cases JSON + the catalogue (for repo links).
 */
export async function buildUseCasesPage(catalogueJsonPath, useCasesJsonPath) {
  const resolvedCatalogue = catalogueJsonPath || join(ROOT, 'forgesworn-repos.json');
  const resolvedUseCases = useCasesJsonPath || join(ROOT, 'forgesworn-use-cases.json');
  const templatePath = join(ROOT, 'site', 'use-cases-template.html');
  const outputPath = join(ROOT, 'site', 'use-cases.html');

  const catalogueData = JSON.parse(readFileSync(resolvedCatalogue, 'utf8'));
  const useCasesData = JSON.parse(readFileSync(resolvedUseCases, 'utf8'));
  const repoIndex = buildRepoIndex(catalogueData);

  let template = readFileSync(templatePath, 'utf8');
  template = template.replace('<!-- USE_CASES_HERO_STATS -->', buildUseCasesHeroStatsHtml(useCasesData));
  template = template.replace('<!-- USE_CASE_FILTERS -->', buildUseCaseFiltersHtml(useCasesData));
  template = template.replace('<!-- USE_CASE_SECTIONS -->', buildUseCaseSectionsHtml(useCasesData, repoIndex));
  template = template.replaceAll('<!-- USE_CASE_COUNT -->', String(useCasesData.useCases.length));

  writeFileSync(outputPath, template, 'utf8');

  const { useCases, categories } = computeUseCaseStats(useCasesData);
  console.log(`Built site/use-cases.html -- ${useCases} use cases, ${categories} categories`);
}

// Only run when executed directly (not when imported by tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  Promise.all([build(process.argv[2]), buildUseCasesPage(process.argv[2])]).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
