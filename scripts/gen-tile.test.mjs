// Run: node --test scripts/gen-tile.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFrames } from './gen-card.mjs';
import { CHARS } from './ascii3d.mjs';
import { TILE, TILE_FRAMES, TILE_OPTIONS, SHEET_COLS, tileSvg, sheetHtml } from './gen-tile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frames = renderFrames(4, TILE_OPTIONS);

test('the S fills the tile and keeps clear of its edges', () => {
  const { cols, rows } = TILE.art;
  for (const fr of frames) {
    const body = fr.char.reduce((n, c) => n + (c ? 1 : 0), 0);
    assert.ok(body > cols * rows * 0.25, `only ${body} cells drawn`);
    for (let x = 0; x < cols; x++) {
      for (const y of [0, rows - 1]) {
        const c = fr.char[y * cols + x];
        assert.ok(c === 0 || '*+.'.includes(CHARS[c]), `letter touches the edge at ${x},${y}`);
      }
    }
  }
});

test('the sprite sheet has one tile per frame, laid out in rows', () => {
  const html = sheetHtml(frames);
  assert.equal((html.match(/<svg /g) ?? []).length, frames.length);
  assert.match(html, new RegExp(`left:${(SHEET_COLS - 1) * TILE.px}px|left:${(frames.length - 1) * TILE.px}px`));
});

test('a tile loads nothing from outside', () => {
  const svg = tileSvg(frames[0]);
  assert.doesNotMatch(svg, /href=|url\(|@import|<image|<script/);
});

test('the published GIF is square, loops, and is light enough for a signature', () => {
  const gif = fs.readFileSync(path.join(ROOT, 'assets', 'email', 's-tile.gif'));
  assert.equal(gif.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.equal(gif.readUInt16LE(6), TILE.px, 'width');
  assert.equal(gif.readUInt16LE(8), TILE.px, 'height');
  assert.ok(gif.includes(Buffer.from('NETSCAPE2.0')), 'no loop extension, so it would play once and stop');
  assert.ok(gif.length < 150 * 1024, `GIF is ${(gif.length / 1024).toFixed(0)} KB`);
  assert.ok(TILE_FRAMES >= 24, 'too few frames for smooth motion');
});
