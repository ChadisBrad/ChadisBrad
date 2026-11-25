#!/usr/bin/env node
// Builds assets/email/s-tile.gif: the S from the profile card as a small animated tile for my
// email signature. Email can't show SVG (Gmail strips it), so this one is a GIF.
//
// Pipeline: render the frames with the card's engine, lay them out as one sprite sheet (HTML
// with an SVG per frame), screenshot the sheet with headless Edge, then let ffmpeg cut the
// sheet into frames and encode the GIF. Frame one faces the camera, so mail clients that only
// show the first frame (older desktop Outlook) still get a clean S.
//
// The GIF's URL is in my email signature. Don't move or rename it, or every signature already
// sent loses its image.
//
// Usage: node scripts/gen-tile.mjs [--out <file.gif>]
// Needs Microsoft Edge and ffmpeg (override their paths with the EDGE and FFMPEG env vars).
// This runs locally only; CI tests the frames and the sheet, not the GIF encoding.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderFrames, frameSvg, colourCss } from './gen-card.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 192 px square, shown at 96 px in the signature, so it stays sharp on high-density screens.
// No glow and 32 colours: at 96 px they look the same as the card's glow and full palette, and
// the GIF drops from about 600 KB to under 100 KB.
export const TILE = { px: 192, radius: 26, art: { cols: 23, rows: 13, cellW: 7.4, cellH: 13.2 } };
export const TILE_FRAMES = 40;
export const TILE_SECONDS = 8;
export const SHEET_COLS = 8;
export const TILE_COLOURS = 32;
export const TILE_OPTIONS = { art: TILE.art, focal: 3.3, moteCount: 6, glints: 1, seconds: TILE_SECONDS };

const BG = '#0b0b0c';

/** One frame as a standalone SVG tile: rounded dark square with the S centred. */
export function tileSvg(fr) {
  const { px, radius, art } = TILE;
  const ox = ((px - art.cols * art.cellW) / 2).toFixed(1);
  const oy = ((px - art.rows * art.cellH) / 2).toFixed(1);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">` +
    `<rect width="${px}" height="${px}" rx="${radius}" fill="${BG}"/>` +
    `<g class="art" transform="translate(${ox},${oy})" xml:space="preserve">${frameSvg(fr, art)}</g></svg>`;
}

/** All frames on one page, SHEET_COLS across, for a single screenshot. */
export function sheetHtml(frames) {
  const { px } = TILE;
  const rows = Math.ceil(frames.length / SHEET_COLS);
  const tiles = frames.map((fr, k) =>
    `<div style="position:absolute;left:${(k % SHEET_COLS) * px}px;top:${Math.floor(k / SHEET_COLS) * px}px">${tileSvg(fr)}</div>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;width:${SHEET_COLS * px}px;height:${rows * px}px;overflow:hidden}
.art text{font-family:Consolas,'Cascadia Mono',monospace;font-size:11.4px;font-weight:600;white-space:pre}
${colourCss()}
</style></head><body>
${tiles}
</body></html>`;
}

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.error) throw new Error(`${what}: could not start ${cmd} (${r.error.message}). Set the ${what.toUpperCase()} env var to its path.`);
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 800)}`);
  return r;
}

/** Renders the sheet, screenshots it and encodes the GIF. Returns the GIF's size in bytes. */
export function buildGif(out) {
  const edge = process.env.EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
  const frames = renderFrames(TILE_FRAMES, TILE_OPTIONS);
  const rows = Math.ceil(frames.length / SHEET_COLS);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 's-tile-'));
  const html = path.join(work, 'sheet.html');
  const png = path.join(work, 'sheet.png');
  fs.writeFileSync(html, sheetHtml(frames));

  run(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${SHEET_COLS * TILE.px},${rows * TILE.px}`,
    `--screenshot=${png}`, pathToFileURL(html).href], 'edge');
  if (!fs.existsSync(png)) throw new Error(`edge ran but wrote no screenshot at ${png}`);

  const fps = TILE_FRAMES / TILE_SECONDS;
  const filter = `untile=${SHEET_COLS}x${rows},trim=end_frame=${TILE_FRAMES},setpts=N/(${fps}*TB),split[a][b];` +
    `[a]palettegen=reserve_transparent=1:max_colors=${TILE_COLOURS}:stats_mode=full[p];[b][p]paletteuse=alpha_threshold=128:dither=none:diff_mode=rectangle`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  run(ffmpeg, ['-y', '-loglevel', 'error', '-i', png, '-filter_complex', filter, '-r', String(fps), '-loop', '0', out], 'ffmpeg');
  fs.rmSync(work, { recursive: true, force: true });
  return fs.statSync(out).size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : path.join(ROOT, 'assets', 'email', 's-tile.gif');
  const bytes = buildGif(out);
  console.log(`wrote ${path.relative(process.cwd(), out)} (${(bytes / 1024).toFixed(0)} KB, ${TILE_FRAMES} frames, ${TILE_SECONDS}s loop)`);
}
