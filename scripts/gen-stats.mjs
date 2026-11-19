#!/usr/bin/env node
// Builds assets/terminal.svg: a terminal-style profile card with a character-drawn portrait,
// stat tiles, a contribution heatmap and a monthly chart.
// Zero dependencies. Data comes from GitHub's GraphQL contribution calendar, which is the
// same calendar visitors see on the profile (private contributions show as counts only).
// The portrait is made once, offline, by scripts/make_portrait.py (art after JIN2, @jin_22ee).
//
// Usage:
//   GITHUB_TOKEN=... node scripts/gen-stats.mjs               (CI: fetches live data)
//   node scripts/gen-stats.mjs --from saved-response.json     (offline: a saved GraphQL response)
//   add --out <file> to write somewhere other than assets/terminal.svg

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

// ---------- data ----------

/** Turns a GraphQL response into weeks of {date, count}. Throws with the API's own error text. */
export function weeksFromResponse(json) {
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal || !Array.isArray(cal.weeks)) {
    const detail = JSON.stringify(json?.errors ?? json ?? null).slice(0, 300);
    throw new Error(`GraphQL response has no contribution calendar weeks: ${detail}`);
  }
  return cal.weeks.map((w) => w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount })));
}

/** Stats over consecutive days (oldest first). */
export function computeStats(days) {
  const total = days.reduce((s, d) => s + d.count, 0);
  const activeDays = days.filter((d) => d.count > 0).length;

  let longest = { len: 0, start: null, end: null };
  let run = 0;
  let runStart = null;
  for (const d of days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run += 1;
      if (run > longest.len) longest = { len: run, start: runStart, end: d.date };
    } else {
      run = 0;
    }
  }

  // Current streak: today counts if it has activity; an empty today doesn't break yesterday's run.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i -= 1;
  let current = 0;
  while (i >= 0 && days[i].count > 0) {
    current += 1;
    i -= 1;
  }

  const bestDay = days.reduce((b, d) => (d.count > b.count ? d : b), { date: null, count: 0 });
  const last30 = days.slice(-30).reduce((s, d) => s + d.count, 0);

  return {
    total,
    days: days.length,
    activeDays,
    longest,
    current,
    bestDay,
    last30,
    avgPerActiveDay: activeDays ? total / activeDays : 0,
    from: days[0]?.date ?? null,
    to: days.at(-1)?.date ?? null,
  };
}

/** Totals for the last `months` calendar months, ending with the month of the last day. */
export function monthlyTotals(days, months = 12) {
  if (!days.length) return [];
  const last = days.at(-1).date;
  let y = Number(last.slice(0, 4));
  let m = Number(last.slice(5, 7));
  const keys = [];
  for (let k = 0; k < months; k += 1) {
    keys.unshift(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const d of days) {
    const k = d.date.slice(0, 7);
    if (k in totals) totals[k] += d.count;
  }
  return keys.map((k) => ({ month: k, label: MONTHS[Number(k.slice(5, 7)) - 1], total: totals[k] }));
}

/** Quartile thresholds over active days, so shading follows this year's own spread. */
export function levelThresholds(days) {
  const counts = days.map((d) => d.count).filter((c) => c > 0).sort((a, b) => a - b);
  if (!counts.length) return [1, 1, 1];
  const q = (p) => counts[Math.floor(p * (counts.length - 1))];
  return [q(0.25), q(0.5), q(0.75)];
}

export function levelFor(count, [t1, t2, t3]) {
  if (count <= 0) return 0;
  if (count <= t1) return 1;
  if (count <= t2) return 2;
  if (count <= t3) return 3;
  return 4;
}

/** Checks a portrait made by make_portrait.py; throws with the reason if it's malformed. */
export function checkPortrait(p) {
  const ok =
    p && Number.isInteger(p.cols) && Number.isInteger(p.rows) && Array.isArray(p.chars) && Array.isArray(p.levels) &&
    p.chars.length === p.rows && p.levels.length === p.rows &&
    p.chars.every((r, i) => typeof r === 'string' && [...r].length === p.cols && [...p.levels[i]].length === p.cols);
  if (!ok) throw new Error('portrait.json is malformed: expected {cols, rows, chars[rows], levels[rows]} with every row cols wide');
  return p;
}

// ---------- formatting ----------

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export const fmtInt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const fmtDate = (iso, withYear = false) =>
  iso ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}${withYear ? ` ${iso.slice(0, 4)}` : ''}` : '-';
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;
const fx = (n) => (Math.round(n * 10) / 10).toString();

// ---------- rendering ----------

const C = {
  window: '#161b22',
  bg: '#0b0f14',
  panel: '#11161d',
  border: '#30363d',
  text: '#e6edf3',
  dim: '#8b949e',
  green: '#3fb950',
  blue: '#58a6ff',
  levels: ['#1c2129', '#0e4429', '#006d32', '#26a641', '#39d353'],
  // portrait levels 1..9, dark field to white sparkle
  art: [null, '#123821', '#17502b', '#1f6f38', '#238636', '#2ea043', '#3fb950', '#56d364', '#aff5b4', '#ffffff'],
};
const FONT = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;
const W = 860;
const PAD = 28;
const IW = W - PAD * 2;
const CELL_W = 5.25;
const CELL_H = 8.4;

function promptLine(x, y, user, cmd) {
  return `<text x="${x}" y="${y}" class="t"><tspan fill="${C.green}">${user}@github</tspan> <tspan fill="${C.blue}">~</tspan> <tspan fill="${C.dim}">$</tspan> ${escapeXml(cmd)}</text>`;
}

/** The character portrait: one <text> per row and colour, each letter placed on its own cell. */
function renderPortrait(p, x0, y0) {
  const out = [];
  for (let r = 0; r < p.rows; r += 1) {
    const chars = [...p.chars[r]];
    const levels = [...p.levels[r]];
    const byLevel = new Map();
    chars.forEach((ch, c) => {
      if (ch === ' ' || levels[c] === ' ') return;
      const lv = Math.min(9, Math.max(1, Number(levels[c]) || 1));
      if (!byLevel.has(lv)) byLevel.set(lv, { xs: [], s: '' });
      const g = byLevel.get(lv);
      g.xs.push(fx(x0 + c * CELL_W));
      g.s += ch;
    });
    if (!byLevel.size) continue;
    const y = fx(y0 + (r + 1) * CELL_H);
    out.push(`<g class="pr" style="animation-delay:${r * 22}ms">`);
    for (const [lv, g] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      out.push(`<text x="${g.xs.join(' ')}" y="${y}" class="a${lv}">${escapeXml(g.s)}</text>`);
    }
    out.push('</g>');
  }
  return out.join('\n');
}

/**
 * @param {{weeks: {date:string,count:number}[][], config: {login:string, promptUser:string, name?:string, whoami:string[]}, portrait?: object}} input
 * @returns {string} SVG markup
 */
export function renderSvg({ weeks, config, portrait }) {
  const days = weeks.flat();
  const stats = computeStats(days);
  const monthly = monthlyTotals(days);
  const thresholds = levelThresholds(days);
  const user = escapeXml(config.promptUser);
  const out = [];
  const defs = [];
  let y = 36;

  // ---- whoami: portrait panel + identity + stat tiles ----
  y += 34;
  out.push(promptLine(PAD, y, user, 'whoami'));
  const top = y + 16;

  const pw = portrait ? portrait.cols * CELL_W + 24 : 0;
  const ph = portrait ? portrait.rows * CELL_H + 24 : 0;
  if (portrait) {
    defs.push(
      `<radialGradient id="halo" cx="50%" cy="50%" r="55%"><stop offset="0" stop-color="${C.green}" stop-opacity=".16"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></radialGradient>`,
    );
    out.push(
      `<rect x="${PAD}" y="${top}" width="${fx(pw)}" height="${fx(ph)}" rx="10" fill="${C.panel}" stroke="${C.border}"/>`,
      `<rect x="${PAD}" y="${top}" width="${fx(pw)}" height="${fx(ph)}" rx="10" fill="url(#halo)"/>`,
      `<g class="art" filter="url(#glow)">`,
      renderPortrait(portrait, PAD + 12, top + 10),
      `</g>`,
    );
  }

  const rx = portrait ? PAD + pw + 22 : PAD;
  const rw = W - PAD - rx;
  const name = escapeXml(config.name ?? config.promptUser);
  out.push(
    `<text x="${fx(rx)}" y="${top + 30}" class="name">${name}</text>`,
    `<circle cx="${fx(rx + 4)}" cy="${top + 49}" r="3.5" fill="${C.green}" class="pulse"/>`,
    `<text x="${fx(rx + 14)}" y="${top + 53}" class="s">@${escapeXml(config.login)}${config.status ? ` · ${escapeXml(config.status)}` : ''}</text>`,
  );
  let wy = top + 80;
  for (const line of config.whoami ?? []) {
    out.push(`<text x="${fx(rx)}" y="${wy}" class="w">${escapeXml(line)}</text>`);
    wy += 19;
  }

  const tiles = [
    ['contributions', fmtInt(stats.total), 'last 12 months'],
    ['active_days', fmtInt(stats.activeDays), `${Math.round((100 * stats.activeDays) / Math.max(stats.days, 1))}% of days`],
    ['best_day', fmtInt(stats.bestDay.count), fmtDate(stats.bestDay.date, true)],
    ['longest_streak', plural(stats.longest.len, 'day'), stats.longest.len ? `${fmtDate(stats.longest.start)} – ${fmtDate(stats.longest.end)}` : '-'],
    ['last_30_days', fmtInt(stats.last30), 'contributions'],
    ['avg_per_active_day', stats.avgPerActiveDay.toFixed(1), 'contributions'],
  ];
  const gap = 10;
  const tw = (rw - gap) / 2;
  const th = 52;
  const tilesTop = Math.max(wy + 2, top + 112);
  tiles.forEach(([label, value, sub], k) => {
    const tx = rx + (k % 2) * (tw + gap);
    const ty = tilesTop + Math.floor(k / 2) * (th + gap);
    out.push(
      `<g class="tile" style="animation-delay:${250 + k * 70}ms">`,
      `<rect x="${fx(tx)}" y="${ty}" width="${fx(tw)}" height="${th}" rx="8" fill="${C.panel}" stroke="${C.border}"/>`,
      `<text x="${fx(tx + 12)}" y="${ty + 19}" class="s">$ ${escapeXml(label)}</text>`,
      `<text x="${fx(tx + 12)}" y="${ty + 42}" class="v">${escapeXml(value)}</text>`,
      `<text x="${fx(tx + tw - 12)}" y="${ty + 42}" class="s" text-anchor="end">${escapeXml(sub)}</text>`,
      `</g>`,
    );
  });
  y = Math.max(top + ph, tilesTop + 3 * th + 2 * gap);

  // ---- heatmap ----
  y += 36;
  out.push(promptLine(PAD, y, user, './contributions.sh'));
  const pitch = Math.min(15, Math.floor((IW + 3) / Math.max(weeks.length, 1)));
  const cell = pitch - 3;
  const labelY = y + 24;
  const gridTop = labelY + 8;
  let lastLabelX = -Infinity;
  let lastMonth = null;
  weeks.forEach((week, col) => {
    const x = PAD + col * pitch;
    const month = week[0]?.date.slice(5, 7);
    if (month && month !== lastMonth) {
      if (x - lastLabelX >= 32 && col < weeks.length - 1) {
        out.push(`<text x="${x}" y="${labelY}" class="s">${MONTHS[Number(month) - 1]}</text>`);
        lastLabelX = x;
      }
      lastMonth = month;
    }
    for (const d of week) {
      const row = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      const lvl = levelFor(d.count, thresholds);
      out.push(
        `<rect class="c" style="animation-delay:${600 + col * 12}ms" x="${x}" y="${gridTop + row * pitch}" width="${cell}" height="${cell}" rx="2" fill="${C.levels[lvl]}"><title>${d.count} on ${fmtDate(d.date, true)}</title></rect>`,
      );
    }
  });
  y = gridTop + 7 * pitch - 3 + 24;
  out.push(`<text x="${PAD}" y="${y}" class="s">${fmtInt(stats.total)} contributions in the last year</text>`);
  const legendX = W - PAD - (5 * 15 + 70);
  out.push(`<text x="${legendX}" y="${y}" class="s">less</text>`);
  C.levels.forEach((col, k) => {
    out.push(`<rect x="${legendX + 34 + k * 15}" y="${y - 10}" width="12" height="12" rx="2" fill="${col}"/>`);
  });
  out.push(`<text x="${legendX + 34 + 5 * 15 + 4}" y="${y}" class="s">more</text>`);

  // ---- monthly bars ----
  y += 36;
  out.push(promptLine(PAD, y, user, './monthly --chart'));
  const chartH = 70;
  const barGap = 10;
  const bw = (IW - barGap * (monthly.length - 1)) / Math.max(monthly.length, 1);
  const max = Math.max(1, ...monthly.map((m) => m.total));
  const base = y + 22 + chartH;
  defs.push(
    `<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.levels[4]}"/><stop offset="1" stop-color="${C.levels[2]}"/></linearGradient>`,
  );
  monthly.forEach((m, k) => {
    const bx = PAD + k * (bw + barGap);
    const bh = m.total ? Math.max(3, (m.total / max) * (chartH - 14)) : 0;
    if (bh) {
      out.push(
        `<rect class="bar" x="${fx(bx)}" y="${fx(base - bh)}" width="${fx(bw)}" height="${fx(bh)}" rx="3" fill="url(#bar)"/>`,
        `<text x="${fx(bx + bw / 2)}" y="${fx(base - bh - 6)}" class="s" text-anchor="middle">${fmtInt(m.total)}</text>`,
      );
    } else {
      out.push(`<rect x="${fx(bx)}" y="${base - 1}" width="${fx(bw)}" height="1" fill="${C.border}"/>`);
    }
    out.push(`<text x="${fx(bx + bw / 2)}" y="${base + 18}" class="s" text-anchor="middle">${m.label}</text>`);
  });
  y = base + 18;

  // ---- closing prompt ----
  y += 34;
  out.push(
    `<text x="${PAD}" y="${y}" class="t"><tspan fill="${C.green}">${user}@github</tspan> <tspan fill="${C.blue}">~</tspan> <tspan fill="${C.dim}">$</tspan></text>`,
    `<rect class="cur" x="${PAD + (config.promptUser.length + 12) * 8.1}" y="${y - 13}" width="9" height="17" fill="${C.text}"/>`,
    `<text x="${W - PAD}" y="${y}" class="s" text-anchor="end">updated ${fmtDate(stats.to, true)} · GitHub contribution calendar${portrait ? ' · art after JIN2 (@jin_22ee)' : ''}</text>`,
  );
  const H = y + 26;

  const title = `${config.promptUser}@github: ~`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="ttl">
<title id="ttl">${escapeXml(`${config.login}: ${fmtInt(stats.total)} contributions in the last year, ${stats.activeDays} active days, best day ${stats.bestDay.count}`)}</title>
<defs>
<filter id="glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="soft" x="-10%" y="-30%" width="120%" height="160%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<pattern id="dots" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".8" fill="#ffffff" fill-opacity=".045"/></pattern>
<linearGradient id="rule" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${C.green}" stop-opacity="0"/><stop offset=".5" stop-color="${C.green}" stop-opacity=".7"/><stop offset="1" stop-color="${C.green}" stop-opacity="0"/></linearGradient>
${defs.join('\n')}
</defs>
<style>
text{font-family:${FONT};font-size:11px;fill:${C.dim}}
.t{font-size:14px;fill:${C.text}}
.s{font-size:11px;fill:${C.dim}}
.w{font-size:13px;fill:${C.text}}
.name{font-size:30px;font-weight:700;fill:${C.text};letter-spacing:-.5px}
.v{font-size:21px;font-weight:700;fill:${C.green};filter:url(#soft)}
.art text{font-size:8.6px;font-weight:600}
${C.art.map((col, lv) => (col ? `.art .a${lv}{fill:${col}}` : '')).join('')}
.pr{animation:fade .5s ease-out backwards}
.c{animation:fade .5s ease-out backwards}
.tile{animation:fade .6s ease-out backwards}
.bar{transform-box:fill-box;transform-origin:50% 100%;animation:grow .8s ease-out}
.cur{animation:blink 1.1s steps(1) infinite}
.pulse{animation:pulse 2.4s ease-in-out infinite}
@keyframes fade{from{opacity:0}}
@keyframes grow{from{transform:scaleY(0)}}
@keyframes blink{50%{opacity:0}}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.pr,.c,.tile,.bar,.cur,.pulse{animation:none}}
</style>
<clipPath id="win"><rect width="${W}" height="${H}" rx="12"/></clipPath>
<g clip-path="url(#win)">
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<rect width="${W}" height="${H}" fill="url(#dots)"/>
<rect width="${W}" height="36" fill="${C.window}"/>
<rect x="0" y="35.5" width="${W}" height="1" fill="url(#rule)"/>
<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>
<text x="${W / 2}" y="22" class="s" text-anchor="middle">${escapeXml(title)}</text>
${out.join('\n')}
</g>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.border}"/>
</svg>
`;
}

// ---------- main ----------

async function fetchCalendar(login, token) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'profile-terminal-card',
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub GraphQL returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(`GitHub GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'profile.config.json'), 'utf8'));
  const portrait = config.portrait
    ? checkPortrait(JSON.parse(fs.readFileSync(path.join(ROOT, config.portrait), 'utf8')))
    : undefined;
  const from = arg('--from');
  let json;
  if (from) {
    json = JSON.parse(fs.readFileSync(from, 'utf8'));
  } else {
    const token = process.env.GITHUB_TOKEN;
    if (!token) throw new Error('GITHUB_TOKEN is not set (needed to read the contribution calendar); or pass --from <saved-response.json>');
    json = await fetchCalendar(config.login, token);
  }
  const weeks = weeksFromResponse(json);
  const outFile = arg('--out') ?? path.join(ROOT, 'assets', 'terminal.svg');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, renderSvg({ weeks, config, portrait }));
  const s = computeStats(weeks.flat());
  console.log(`wrote ${path.relative(process.cwd(), outFile)}: ${s.total} contributions, ${s.activeDays} active days, ${s.from} to ${s.to}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`gen-stats failed: ${err.message}`);
    process.exit(1);
  });
}
