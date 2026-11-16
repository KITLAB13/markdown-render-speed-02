// Driver for the make.fun markdown-render-speed-02 harness.
// Reads a JSON array of { id, markdown } cases, renders each one with the
// parse() function from ./parse.js, and writes a JSON array of HTML strings
// (same order as the input) to the output directory.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw: string = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases: Array<{ id: unknown; markdown: string }> = JSON.parse(raw);

const out: string[] = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  const md: unknown = cases[i].markdown;
  out[i] = parse(typeof md === 'string' ? md : '');
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(out));
