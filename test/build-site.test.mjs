import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeStats,
  buildHeroStatsHtml,
  buildStackMapCardsHtml,
  buildStackMapSvgHtml,
  buildStackSectionsHtml,
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
  // Verify tabindex and role accessibility attributes
  assert.ok(html.includes('tabindex="0"'), 'has tabindex');
  assert.ok(html.includes('role="button"'), 'has role button');
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
