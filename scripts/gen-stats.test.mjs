import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStats,
  monthlyTotals,
  levelThresholds,
  levelFor,
  escapeXml,
  fmtInt,
  weeksFromResponse,
  renderSvg,
  checkPortrait,
} from './gen-stats.mjs';

// Consecutive days from a start date with the given counts.
function series(start, counts) {
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return counts.map((count, i) => ({ date: new Date(t0 + i * 86400000).toISOString().slice(0, 10), count }));
}

test('keeps yesterday\'s streak alive when today has no contributions yet', () => {
  const s = computeStats(series('2026-11-15', [0, 2, 3, 1, 0]));
  assert.equal(s.current, 3);
});

test('a missed day resets the current streak', () => {
  const s = computeStats(series('2026-11-15', [4, 4, 0, 0, 1]));
  assert.equal(s.current, 1);
});

test('finds the longest streak and the dates it ran', () => {
  const s = computeStats(series('2026-03-01', [1, 1, 0, 2, 2, 2, 0, 1]));
  assert.deepEqual(s.longest, { len: 3, start: '2026-03-04', end: '2026-03-06' });
});

test('reports zero averages for an empty year instead of NaN', () => {
  const s = computeStats(series('2026-01-01', [0, 0, 0]));
  assert.equal(s.avgPerActiveDay, 0);
  assert.equal(s.total, 0);
  assert.equal(s.bestDay.count, 0);
});

test('sums each calendar month and drops days older than the 12-month window', () => {
  const days = [
    ...series('2025-11-28', [5, 5, 5]), // Nov 2025: outside a 12-month window ending Nov 2026
    ...series('2025-12-01', [1, 2]),
    ...series('2026-11-01', [7]),
  ];
  const m = monthlyTotals(days);
  assert.equal(m.length, 12);
  assert.equal(m[0].month, '2025-12');
  assert.equal(m[0].total, 3);
  assert.equal(m.at(-1).month, '2026-11');
  assert.equal(m.at(-1).total, 7);
  assert.equal(m.reduce((s, x) => s + x.total, 0), 10);
});

test('shades the busiest day darkest and empty days lightest', () => {
  const days = series('2026-01-01', [0, 1, 2, 3, 4, 5, 6, 7, 40]);
  const t = levelThresholds(days);
  assert.equal(levelFor(40, t), 4);
  assert.equal(levelFor(0, t), 0);
  assert.equal(levelFor(1, t), 1);
});

test('escapes markup characters in profile text so the SVG stays valid', () => {
  assert.equal(escapeXml(`<b>"Tom" & 'Jerry'</b>`), '&lt;b&gt;&quot;Tom&quot; &amp; &apos;Jerry&apos;&lt;/b&gt;');
});

test('formats thousands with commas', () => {
  assert.equal(fmtInt(1255), '1,255');
  assert.equal(fmtInt(999), '999');
  assert.equal(fmtInt(1234567), '1,234,567');
});

test('refuses a GraphQL response with no calendar and quotes the API error', () => {
  assert.throws(
    () => weeksFromResponse({ errors: [{ message: 'Could not resolve to a User' }] }),
    /Could not resolve to a User/,
  );
});

test('refuses a calendar with no weeks instead of crashing on it', () => {
  assert.throws(
    () => weeksFromResponse({ data: { user: { contributionsCollection: { contributionCalendar: { totalContributions: 3 } } } } }),
    /no contribution calendar weeks/,
  );
});

test('renders a well-formed card with the year total and escaped whoami text', () => {
  const weeks = [series('2026-11-15', [0, 3, 0, 9, 1, 0, 2])];
  const svg = renderSvg({
    weeks,
    config: { login: 'someone', promptUser: 'me', whoami: ['builds <things> & ships'] },
  });
  assert.match(svg, /^<svg[^>]+viewBox="0 0 860 \d+"/);
  assert.match(svg, /15 contributions in the last year/);
  assert.match(svg, /builds &lt;things&gt; &amp; ships/);
  assert.doesNotMatch(svg, /NaN|undefined/);
  assert.equal((svg.match(/<rect class="c"/g) ?? []).length, 7);
});

const tinyPortrait = { credit: 'after JIN2 (@jin_22ee)', cols: 4, rows: 2, chars: ['<&> ', ' ab*'], levels: ['567 ', ' 129'] };

test('draws each portrait letter on its own cell and escapes markup letters', () => {
  const svg = renderSvg({
    weeks: [series('2026-11-15', [1, 2, 3])],
    config: { login: 'someone', promptUser: 'me', whoami: [] },
    portrait: tinyPortrait,
  });
  assert.match(svg, />&lt;</);
  assert.match(svg, />&amp;</);
  assert.doesNotMatch(svg, /><&>/);
  // the white sparkle (level 9) and the credit both appear
  assert.match(svg, /class="a9">\*</);
  assert.match(svg, /\.art \.a9\{fill:#ffffff\}/);
  assert.match(svg, /art after JIN2/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('renders without a portrait and drops the art credit', () => {
  const svg = renderSvg({ weeks: [series('2026-11-15', [1])], config: { login: 'x', promptUser: 'me', whoami: ['hi'] } });
  assert.doesNotMatch(svg, /JIN2/);
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('refuses a portrait whose rows are the wrong width', () => {
  assert.equal(checkPortrait(tinyPortrait), tinyPortrait);
  assert.throws(() => checkPortrait({ ...tinyPortrait, chars: ['<&>', ' ab*'] }), /malformed/);
  assert.throws(() => checkPortrait({ cols: 1 }), /malformed/);
});
