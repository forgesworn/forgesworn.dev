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
};

const DISPLAY_ORDER = ['l402', 'spatial', 'identity', 'agents', 'trust', 'crypto', 'compliance', 'protocol'];

// Repos with dedicated websites (presentation config, not in JSON)
const REPO_WEBSITES = {
  bray: 'https://bray.forgesworn.dev',
  '402-pub': 'https://402.pub',
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
  return `<div class="repo-card repo-card--entry" style="--stack-colour: ${colour}">
  <h3 class="repo-name">${escHtml(repo.name)}</h3>
  <p class="repo-desc">${escHtml(repo.description)}</p>
  ${installHtml}
  <div class="repo-links">
    <a class="repo-link" href="${escHtml(repo.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>
    ${websiteHtml}
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
  return `<div class="repo-card">
  <h3 class="repo-name">${escHtml(repo.name)}</h3>
  <p class="repo-desc">${escHtml(repo.description)}</p>
  <div class="repo-links">
    <a class="repo-link" href="${escHtml(repo.github)}" target="_blank" rel="noopener noreferrer">GitHub</a>${websiteHtml}
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

// Only run when executed directly (not when imported by tests)
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  build(process.argv[2]).catch(err => {
    console.error(err);
    process.exit(1);
  });
}
