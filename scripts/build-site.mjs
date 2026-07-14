/**
 * build-site.mjs
 * Reads forgesworn-repos.json + site/template.html,
 * replaces marker comments with generated HTML, writes site/index.html.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Presentation config — not in the JSON (presentation concern)
const CATEGORY_CONFIG = {
  l402:       { colour: '#e94560', entryPoint: 'toll-booth' },
  spatial:    { colour: '#0f3460', entryPoint: 'rendezvous-kit' },
  identity:   { colour: '#16c79a', entryPoint: 'nsec-tree' },
  agents:     { colour: '#00b4d8', entryPoint: 'bray' },
  trust:      { colour: '#9b59b6', entryPoint: 'nostr-attestations' },
  crypto:     { colour: '#f5a623', entryPoint: 'ring-sig' },
  compliance: { colour: '#e17055', entryPoint: 'jurisdiction-kit' },
  protocol:   { colour: '#6c5ce7', entryPoint: 'nip-drafts' },
  tooling:    { colour: '#4a9eff', entryPoint: 'anvil' },
};

const DISPLAY_ORDER = ['l402', 'spatial', 'identity', 'agents', 'trust', 'crypto', 'compliance', 'protocol', 'tooling'];

// Repos with dedicated websites (presentation config, not in JSON)
const REPO_WEBSITES = {
  bray: 'https://bray.forgesworn.dev',
  '402-pub': 'https://402.pub',
  cambium: 'https://cambium.forgesworn.dev',
  sapwood: 'https://sapwood.forgesworn.dev',
  signet: 'https://mysignet.app',
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

// SVG connection definitions: [from, to, style]
const SVG_CONNECTIONS = [
  ['crypto',     'identity',  'solid'],
  ['crypto',     'trust',     'solid'],
  ['crypto',     'l402',      'dashed'],
  ['identity',   'l402',      'dashed'],
  ['identity',   'spatial',   'dashed'],
  ['identity',   'agents',    'solid'],
  ['trust',      'identity',  'dashed'],
  ['compliance', 'identity',  'solid'],
];

// ─── Exported functions ────────────────────────────────────────────────────────

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
  return DISPLAY_ORDER
    .filter(slug => catsBySlug[slug])
    .map(slug => {
      const cat = catsBySlug[slug];
      const cfg = CATEGORY_CONFIG[slug] || {};
      const colour = cfg.colour || '#888';
      const repoCount = cat.repos.length;
      // One-line description: first sentence of the category description
      const shortDesc = cat.description.split('.')[0];
      return `<div class="stack-card" data-stack="${escHtml(slug)}" style="--stack-colour: ${colour}" tabindex="0" role="button">
  <div class="stack-card-accent"></div>
  <div class="stack-card-body">
    <div class="stack-card-header">
      <span class="stack-card-name">${escHtml(cat.name)}</span>
      <span class="stack-card-count">${repoCount}</span>
    </div>
    <p class="stack-card-desc">${escHtml(shortDesc)}</p>
  </div>
</div>`;
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
  return DISPLAY_ORDER
    .filter(slug => catsBySlug[slug])
    .map(slug => buildCategorySection(catsBySlug[slug], slug))
    .join('\n\n');
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  const labelHtml = `<div class="section-label" style="color: ${colour}">${escHtml(cat.name)}</div>`;
  const descHtml = `<h2 class="section-title">${escHtml(cat.description)}</h2>`;

  const entryCardHtml = entryRepo ? buildEntryRepoCard(entryRepo, colour) : '';

  const otherCardsHtml = otherRepos.length
    ? `<div class="repo-grid">\n${otherRepos.map(r => buildRepoCard(r)).join('\n')}\n</div>`
    : '';

  const flowChain = buildFlowChain(cat);
  const flowHtml = flowChain
    ? `<div class="flow-chain">${flowChain.map(escHtml).join(' <span class="flow-arrow">\u2192</span> ')}</div>`
    : '';

  return `<section class="stack-section" data-stack="${escHtml(slug)}" style="--stack-colour: ${colour}">
${labelHtml}
${descHtml}
${entryCardHtml}
${otherCardsHtml}
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
  const website = REPO_WEBSITES[repo.name];
  const websiteHtml = website
    ? `<a class="repo-link repo-link--site" href="${escHtml(website)}" target="_blank" rel="noopener noreferrer">Website</a>`
    : '';
  const demo = REPO_DEMOS[repo.name];
  const demoHtml = demo
    ? `<a class="repo-link repo-link--demo" href="${escHtml(demo)}" target="_blank" rel="noopener noreferrer">Live demo</a>`
    : '';
  const docs = REPO_DOCS[repo.name];
  const docsHtml = docs
    ? `<a class="repo-link repo-link--docs" href="${escHtml(docs)}" target="_blank" rel="noopener noreferrer">Docs</a>`
    : '';
  return `<div class="repo-card repo-card--entry" style="--stack-colour: ${colour}">
  <h3 class="repo-name">${escHtml(repo.name)}</h3>
  <p class="repo-desc">${escHtml(repo.description)}</p>
  ${installHtml}
  <div class="repo-links">
    <a class="repo-link" href="${escHtml(repo.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>
    ${websiteHtml}
    ${demoHtml}
    ${docsHtml}
  </div>
</div>`;
}

/**
 * Build a standard repo card.
 */
function buildRepoCard(repo) {
  const website = REPO_WEBSITES[repo.name];
  const websiteHtml = website
    ? `\n  <a class="repo-link repo-link--site" href="${escHtml(website)}" target="_blank" rel="noopener noreferrer">Website</a>`
    : '';
  const demo = REPO_DEMOS[repo.name];
  const demoHtml = demo
    ? `\n  <a class="repo-link repo-link--demo" href="${escHtml(demo)}" target="_blank" rel="noopener noreferrer">Live demo</a>`
    : '';
  const docs = REPO_DOCS[repo.name];
  const docsHtml = docs
    ? `\n  <a class="repo-link repo-link--docs" href="${escHtml(docs)}" target="_blank" rel="noopener noreferrer">Docs</a>`
    : '';
  return `<div class="repo-card">
  <h3 class="repo-name">${escHtml(repo.name)}</h3>
  <p class="repo-desc">${escHtml(repo.description)}</p>
  <div class="repo-links">
    <a class="repo-link" href="${escHtml(repo.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>${websiteHtml}${demoHtml}${docsHtml}
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

export async function build(jsonPath) {
  const resolvedJson = jsonPath || join(ROOT, 'forgesworn-repos.json');
  const templatePath = join(ROOT, 'site', 'template.html');
  const outputPath = join(ROOT, 'site', 'index.html');

  const data = JSON.parse(readFileSync(resolvedJson, 'utf8'));
  let template = readFileSync(templatePath, 'utf8');

  template = template.replace('<!-- HERO_STATS -->', buildHeroStatsHtml(data));
  template = template.replace('<!-- STACK_MAP_CARDS -->', buildStackMapCardsHtml(data));
  template = template.replace('<!-- STACK_MAP_SVG -->', buildStackMapSvgHtml(data));
  template = template.replace('<!-- STACK_SECTIONS -->', buildStackSectionsHtml(data));

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

  writeFileSync(outputPath, template, 'utf8');

  const { useCases, categories } = computeUseCaseStats(useCasesData);
  console.log(`Built site/use-cases.html -- ${useCases} use cases, ${categories} categories`);
}

// Only run when executed directly (not when imported by tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  Promise.all([build(process.argv[2]), buildUseCasesPage()]).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
