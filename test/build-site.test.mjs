import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  numberWord,
  computeStats,
  buildHeroStatsHtml,
  buildStackMapCardsHtml,
  buildStackMapSvgHtml,
  buildStackSectionsHtml,
  buildRepoIndex,
  computeUseCaseStats,
  buildUseCasesHeroStatsHtml,
  buildUseCaseFiltersHtml,
  buildUseCaseSectionsHtml,
} from '../scripts/build-site.mjs';

// Minimal fixture: 2 categories, a few repos, some with npm null
const FIXTURE = {
  generated: '2026-03-27',
  totalPublicRepos: 4,
  categories: [
    {
      name: 'L402 / Machine Payments',
      slug: 'l402',
      description: 'Make APIs payable.',
      repos: [
        {
          name: 'toll-booth',
          github: 'https://github.com/forgesworn/toll-booth',
          npm: '@forgesworn/toll-booth',
          description: 'Any API becomes a Lightning toll booth.',
          tags: ['l402', 'lightning'],
          dependsOn: [],
          usedBy: ['toll-booth-announce'],
        },
        {
          name: 'toll-booth-announce',
          github: 'https://github.com/forgesworn/toll-booth-announce',
          npm: 'toll-booth-announce',
          description: 'Bridge between toll-booth and 402-announce.',
          tags: ['l402', 'nostr'],
          dependsOn: ['toll-booth'],
          usedBy: [],
        },
        {
          name: 'payment-methods',
          github: 'https://github.com/forgesworn/payment-methods',
          npm: null,
          description: 'Specifications for HTTP Payment Authentication methods.',
          tags: ['l402', 'spec'],
          dependsOn: [],
          usedBy: [],
        },
      ],
    },
    {
      name: 'Cryptographic Primitives',
      slug: 'crypto',
      description: 'Standalone cryptographic building blocks.',
      repos: [
        {
          name: 'ring-sig',
          github: 'https://github.com/forgesworn/ring-sig',
          npm: 'ring-sig',
          description: 'SAG and LSAG ring signatures.',
          tags: ['crypto', 'ring-signatures'],
          dependsOn: [],
          usedBy: [],
        },
      ],
    },
  ],
};

test('computeStats counts repos, stacks, and npm packages', () => {
  const stats = computeStats(FIXTURE);
  assert.equal(stats.repos, 4, 'repo count');
  assert.equal(stats.stacks, 2, 'stack (category) count');
  assert.equal(stats.npmPackages, 3, 'npm package count (nulls excluded)');
});

test('buildHeroStatsHtml includes correct numbers and stat-value class', () => {
  const html = buildHeroStatsHtml(FIXTURE);
  assert.ok(html.includes('class="stat-value"'), 'has stat-value class');
  assert.ok(html.includes('>4<'), 'repo count 4');
  assert.ok(html.includes('>2<'), 'stack count 2');
  assert.ok(html.includes('>3<'), 'npm count 3');
  assert.ok(html.includes('class="stat"'), 'has stat wrapper');
});

test('buildStackMapCardsHtml produces one card per category with data-stack', () => {
  const html = buildStackMapCardsHtml(FIXTURE);
  assert.ok(html.includes('data-stack="l402"'), 'l402 card present');
  assert.ok(html.includes('data-stack="crypto"'), 'crypto card present');
  assert.ok(html.includes('stack-card-accent'), 'has accent element');
  // Cards are real links to their section, so keyboard and click need no script
  assert.ok(html.includes('<a class="stack-card" href="#stack-l402"'), 'card is an anchor to its section');
  assert.ok(!html.includes('role="button"'), 'no fake button role');
});

test('buildStackMapCardsHtml prefers the plain-English line and falls back to the description', () => {
  const html = buildStackMapCardsHtml(FIXTURE);
  // l402 has presentation config with a plain line
  assert.ok(html.includes('Sell an API per request'), 'configured plain line used');
  // crypto too; a slug with no config would fall back to the first sentence
  const noConfig = { categories: [{ name: 'Mystery', slug: 'mystery', description: 'First sentence. Second sentence.', repos: [] }] };
  const fallback = buildStackMapCardsHtml(noConfig);
  assert.ok(fallback.includes('First sentence'), 'falls back to first sentence');
  assert.ok(!fallback.includes('Second sentence'), 'only the first sentence');
});

test('numberWord spells small counts and leaves large ones as digits', () => {
  assert.equal(numberWord(9), 'Nine');
  assert.equal(numberWord(11), 'Eleven');
  assert.equal(numberWord(20), 'Twenty');
  assert.equal(numberWord(21), '21');
});

test('buildStackMapSvgHtml returns SVG element with line elements', () => {
  const html = buildStackMapSvgHtml(FIXTURE);
  assert.ok(html.startsWith('<svg'), 'starts with SVG');
  assert.ok(html.includes('</svg>'), 'ends with SVG');
  assert.ok(html.includes('<line'), 'has line elements');
  assert.ok(html.includes('data-from='), 'lines have data-from');
  assert.ok(html.includes('data-to='), 'lines have data-to');
});

test('buildStackSectionsHtml produces one section per category', () => {
  const html = buildStackSectionsHtml(FIXTURE);
  // One section per category
  const sectionMatches = html.match(/<section/g);
  assert.ok(sectionMatches && sectionMatches.length >= 2, 'at least 2 sections');
  assert.ok(html.includes('id="stack-l402"'), 'section carries a linkable id');
  assert.ok(html.includes('id="stack-crypto"'), 'every category gets one');
});

test('buildStackSectionsHtml heads each section with a headline and the description as lede', () => {
  const html = buildStackSectionsHtml(FIXTURE);
  assert.ok(html.includes('<h2 class="section-title">Get paid per call'), 'configured headline is the h2');
  assert.ok(html.includes('<p class="section-lede">Make APIs payable.</p>'), 'description becomes the lede');
  assert.ok(html.includes('<span class="section-label">L402 / Machine Payments</span>'), 'category name is the eyebrow');
  assert.ok(html.includes('3 projects'), 'project count in the meta line');
  assert.ok(html.includes('2 on npm'), 'npm count in the meta line');
});

test('buildStackSectionsHtml renders language and npm chips from tags', () => {
  const data = {
    categories: [{
      name: 'X', slug: 'x', description: 'Desc.',
      repos: [
        { name: 'a-rs', github: 'https://github.com/forgesworn/a-rs', npm: null, description: 'Rust thing.', tags: ['rust'], dependsOn: [], usedBy: [] },
        { name: 'b', github: 'https://github.com/forgesworn/b', npm: 'b', description: 'npm thing.', tags: [], dependsOn: [], usedBy: [] },
      ],
    }],
  };
  const html = buildStackSectionsHtml(data);
  assert.ok(html.includes('<span class="repo-chip">Rust</span>'), 'language chip from tag');
  assert.ok(html.includes('repo-chip--npm'), 'npm chip when published');
  assert.ok(!html.includes('npm install null'), 'no install for unpublished');
});

test('buildStackSectionsHtml folds cards past the third and adds a Show all button', () => {
  const repos = Array.from({ length: 7 }, (_, i) => ({
    name: `r${i}`, github: `https://github.com/forgesworn/r${i}`, npm: null, description: 'd', tags: [], dependsOn: [], usedBy: [],
  }));
  const html = buildStackSectionsHtml({ categories: [{ name: 'X', slug: 'x', description: 'Desc.', repos }] });
  const folded = (html.match(/repo-card--fold/g) || []).length;
  assert.equal(folded, 4, 'seven repos, no entry point: three shown, four folded');
  assert.ok(html.includes('class="repo-fold"'), 'fold button present');
  assert.ok(html.includes('Show all 7 projects'), 'button names the full count');

  const small = buildStackSectionsHtml(FIXTURE);
  assert.ok(!small.includes('repo-fold'), 'no button when nothing is folded');
});

test('buildStackSectionsHtml includes entry point repo with install command', () => {
  const html = buildStackSectionsHtml(FIXTURE);
  // toll-booth is the entry point for l402 and has npm
  assert.ok(html.includes('toll-booth'), 'entry point repo name present');
  assert.ok(html.includes('npm install'), 'install command present');
  assert.ok(html.includes('@forgesworn/toll-booth'), 'npm package name in install command');
});

test('buildStackSectionsHtml includes GitHub links for all repos', () => {
  const html = buildStackSectionsHtml(FIXTURE);
  assert.ok(html.includes('https://github.com/forgesworn/toll-booth'), 'toll-booth github link');
  assert.ok(html.includes('https://github.com/forgesworn/ring-sig'), 'ring-sig github link');
  assert.ok(html.includes('https://github.com/forgesworn/payment-methods'), 'payment-methods github link');
});

test('buildStackSectionsHtml skips install command when npm is null', () => {
  // payment-methods has npm: null — its section should not have a copy button
  const html = buildStackSectionsHtml(FIXTURE);
  // ring-sig has npm, payment-methods does not
  // We just verify npm null repos do not leak "npm install null"
  assert.ok(!html.includes('npm install null'), 'no null npm install command');
});

// ─── Use-cases page fixtures & tests ───────────────────────────────────────────

const USE_CASES_FIXTURE = {
  generated: '2026-06-15',
  categories: [
    { slug: 'payments', name: 'Machine Payments', colour: '#e94560', description: 'Pay for APIs.' },
    { slug: 'crypto', name: 'Crypto Primitives', colour: '#f5a623', description: 'Building blocks.' },
  ],
  useCases: [
    {
      id: 'paying-agent',
      category: 'payments',
      title: 'An agent that pays',
      persona: 'A developer',
      problem: 'No human in the loop.',
      outcome: 'It pays per call.',
      steps: ['Discover the API', 'Pay the invoice', 'Cache the credential'],
      stack: [
        { repo: 'toll-booth', role: 'Gates the API' },
        { repo: 'made-up-repo', role: 'Not in the catalogue' },
      ],
      protocols: ['L402', 'Lightning'],
    },
    {
      id: 'anon-proof',
      category: 'crypto',
      title: 'Anonymous proof',
      persona: 'A whistleblower',
      problem: 'Needs anonymity.',
      outcome: 'Signs as a group.',
      steps: ['Form a ring', 'Sign the message'],
      stack: [{ repo: 'ring-sig', role: 'Ring signatures' }],
      protocols: ['LSAG'],
    },
  ],
};

test('buildRepoIndex maps repo names to github + npm from the catalogue', () => {
  const index = buildRepoIndex(FIXTURE);
  assert.equal(index['toll-booth'].github, 'https://github.com/forgesworn/toll-booth');
  assert.equal(index['ring-sig'].github, 'https://github.com/forgesworn/ring-sig');
  assert.equal(index['payment-methods'].npm, null, 'preserves null npm');
  assert.equal(index['made-up-repo'], undefined, 'unknown repos absent');
});

test('computeUseCaseStats counts use cases, categories, and unique repos', () => {
  const stats = computeUseCaseStats(USE_CASES_FIXTURE);
  assert.equal(stats.useCases, 2, 'use case count');
  assert.equal(stats.categories, 2, 'category count');
  assert.equal(stats.repos, 3, 'unique repos across all stacks (toll-booth, made-up-repo, ring-sig)');
});

test('buildUseCasesHeroStatsHtml includes counts and stat-value class', () => {
  const html = buildUseCasesHeroStatsHtml(USE_CASES_FIXTURE);
  assert.ok(html.includes('class="stat-value"'), 'has stat-value class');
  assert.ok(html.includes('>2<'), 'shows count of 2');
  assert.ok(html.includes('>3<'), 'shows unique repo count of 3');
});

test('buildUseCaseFiltersHtml produces an All pill plus one per category', () => {
  const html = buildUseCaseFiltersHtml(USE_CASES_FIXTURE);
  assert.ok(html.includes('data-filter="all"'), 'has All filter');
  assert.ok(html.includes('is-active'), 'All filter is active by default');
  assert.ok(html.includes('data-filter="payments"'), 'has payments filter');
  assert.ok(html.includes('data-filter="crypto"'), 'has crypto filter');
  assert.ok(html.includes('uc-filter-count'), 'shows per-filter counts');
});

test('buildUseCaseSectionsHtml renders one group per category with cards', () => {
  const index = buildRepoIndex(FIXTURE);
  const html = buildUseCaseSectionsHtml(USE_CASES_FIXTURE, index);
  const groupMatches = html.match(/class="uc-group"/g);
  assert.equal(groupMatches.length, 2, 'one group per category');
  assert.ok(html.includes('data-category="payments"'), 'payments group present');
  assert.ok(html.includes('data-category="crypto"'), 'crypto group present');
  assert.ok(html.includes('id="paying-agent"'), 'card carries its id');
  assert.ok(html.includes('<li>Discover the API</li>'), 'workflow steps rendered as list items');
  assert.ok(html.includes('A developer'), 'persona rendered');
  assert.ok(html.includes('L402'), 'protocols rendered');
});

test('buildUseCaseSectionsHtml links stack items in the catalogue and leaves unknown ones unlinked', () => {
  const index = buildRepoIndex(FIXTURE);
  const html = buildUseCaseSectionsHtml(USE_CASES_FIXTURE, index);
  // toll-booth is in the catalogue → linked anchor to its GitHub
  assert.ok(
    html.includes('<a class="uc-chip" href="https://github.com/forgesworn/toll-booth"'),
    'known repo chip links to GitHub',
  );
  // made-up-repo is not in the catalogue → rendered as a plain span, no link
  assert.ok(html.includes('<span class="uc-chip">'), 'unknown repo chip is an unlinked span');
  assert.ok(!html.includes('href="undefined"'), 'no broken hrefs for unknown repos');
});

test('buildUseCaseSectionsHtml tolerates an empty repo index', () => {
  const html = buildUseCaseSectionsHtml(USE_CASES_FIXTURE);
  assert.ok(html.includes('ring-sig'), 'still renders stack item names');
  assert.ok(!html.includes('<a class="uc-chip"'), 'no links without an index');
});
