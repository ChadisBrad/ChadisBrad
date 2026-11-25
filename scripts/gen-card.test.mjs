// Run: node --test scripts/gen-card.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCard, readConfig, renderFrames, frameSvg, esc, FRAMES, ART } from './gen-card.mjs';
import { CHARS } from './ascii3d.mjs';

const cfg = readConfig();
const svg = buildCard(cfg);

test('the card shows every line from profile.config.json', () => {
  assert.ok(svg.includes(esc(cfg.name)));
  assert.ok(svg.includes(esc(cfg.tagline)));
  for (const [label, value] of cfg.facts) {
    assert.ok(svg.includes(`>${esc(label)}<`), `missing label ${label}`);
    assert.ok(svg.includes(`>${esc(value)}<`), `missing value ${value}`);
  }
});

test('the card has one group per animation frame and a reduced-motion fallback', () => {
  const groups = svg.match(/<g class="f f\d+">/g) ?? [];
  assert.equal(groups.length, FRAMES);
  assert.match(svg, /prefers-reduced-motion:reduce/);
});

test('the card loads nothing from outside, so GitHub shows it as is', () => {
  assert.doesNotMatch(svg, /href=/);
  assert.doesNotMatch(svg, /url\((?!#)/);
  assert.doesNotMatch(svg, /@import|<image|<script/);
});

test('the card stays small enough for GitHub image proxying', () => {
  assert.ok(Buffer.byteLength(svg) < 400 * 1024, `card is ${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB`);
});

test('every ampersand and angle bracket in the art is escaped', () => {
  const body = svg.slice(svg.indexOf('<g class="art"'));
  assert.doesNotMatch(body, /&(?!amp;|lt;|gt;|quot;)/);
  const texts = body.match(/<text[^>]*>[\s\S]*?<\/text>/g) ?? [];
  for (const t of texts) {
    const inner = t.replace(/^<text[^>]*>/, '').replace(/<\/text>$/, '').replace(/<\/?tspan[^>]*>/g, '');
    assert.doesNotMatch(inner, /[<>]/);
  }
});

test('the S is drawn in every frame and stays inside the art area', () => {
  const frames = renderFrames(6);
  for (const fr of frames) {
    const body = fr.char.reduce((n, c) => n + (c ? 1 : 0), 0);
    assert.ok(body > ART.cols * ART.rows * 0.2, `only ${body} cells drawn`);
    // the outer ring of cells stays clear of the letter itself (dust may pass)
    for (let x = 0; x < ART.cols; x++) {
      for (const y of [0, ART.rows - 1]) {
        const c = fr.char[y * ART.cols + x];
        assert.ok(c === 0 || '*+.'.includes(CHARS[c]), `letter touches the edge at ${x},${y}`);
      }
    }
  }
});

test('a frame only uses characters from the engine set', () => {
  const [fr] = renderFrames(1);
  const text = frameSvg(fr).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  for (const ch of text) assert.ok(CHARS.includes(ch), `unexpected character ${JSON.stringify(ch)}`);
});

test('refuses a config with a missing name, naming the field', () => {
  const file = path.join(os.tmpdir(), `card-cfg-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ tagline: 'x', facts: [['a', 'b']] }));
  try {
    assert.throws(() => readConfig(file), /"name" must be a non-empty string/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('refuses a fact value too long for the card', () => {
  const file = path.join(os.tmpdir(), `card-cfg-long-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ name: 'n', tagline: 't', facts: [['role', 'x'.repeat(60)]] }));
  try {
    assert.throws(() => readConfig(file), /facts\[0\] value is 60 characters/);
  } finally {
    fs.rmSync(file, { force: true });
  }
});
