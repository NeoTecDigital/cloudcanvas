/**
 * CloudCanvas - NeoTec, LLC, Richard Christopher
 * Written by Richard Christopher, Copyright 2026 NeoTec, LLC
 *
 * Release-time bundler: turns `index.js` into the two single-file
 * distribution artifacts, each with a minified sibling.
 *
 * This is never part of the development loop. The framework is native browser
 * ESM and the test suites import `src/` directly, so `dist/` may be absent,
 * stale or deleted without affecting a source checkout. It exists for
 * two consumers the source tree cannot serve:
 *
 *   - `cloudcanvas.esm.js`  one `<script type="module">` import over http(s),
 *                           no import map and no directory of module requests.
 *   - `cloudcanvas.iife.js` the strict zero-server case. A plain non-module
 *                           `<script src>` is the *only* form that loads from a
 *                           `file://` URL: Chromium fetches module scripts in
 *                           CORS mode, which a `file://` origin always fails,
 *                           and bundling to a single module does not change
 *                           that - the failure is the fetch mode, not the
 *                           number of requests.
 *
 * A Node script rather than a package.json one-liner: four related outputs
 * share one config, and the size report below is the only place raw/gzip
 * numbers are measured rather than guessed.
 *
 * Single dependency: esbuild, a devDependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/** Repository root: this file lives one directory below it. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist');
const ENTRY = path.join(ROOT, 'index.js');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * Survives minification (`legalComments: 'inline'` would move it; a banner is
 * emitted verbatim ahead of everything either way).
 */
const BANNER = [
  '/*!',
  ` * CloudCanvas v${pkg.version} - ${pkg.description}`,
  ' * Written by Richard Christopher, Copyright 2026 NeoTec, LLC',
  ` * ${pkg.license} License. ${pkg.homepage}`,
  ' */'
].join('\n');

/**
 * Baseline shared by every artifact.
 *
 * `target` is the floor the framework already assumes - private class fields,
 * `structuredClone`-era DOM, top-level `??=` - so esbuild transpiles nothing it
 * does not have to and the ESM output stays close to the source it came from.
 */
const SHARED = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'browser',
  target: ['es2022'],
  charset: 'utf8',
  banner: { js: BANNER },
  logLevel: 'silent',
  metafile: true
};

/** The four artifacts, in report order. */
const TARGETS = [
  { outfile: 'dist/cloudcanvas.esm.js', format: 'esm', minify: false },
  { outfile: 'dist/cloudcanvas.esm.min.js', format: 'esm', minify: true },
  {
    outfile: 'dist/cloudcanvas.iife.js',
    format: 'iife',
    globalName: 'CloudCanvas',
    minify: false
  },
  {
    outfile: 'dist/cloudcanvas.iife.min.js',
    format: 'iife',
    globalName: 'CloudCanvas',
    minify: true
  }
];

/** esbuild messages are reported, never swallowed - a clean build says so. */
function reportMessages(label, messages, kind) {
  if (messages.length === 0) return;
  console.log(`\n${label}: ${messages.length} ${kind}(s)`);
  console.log(esbuild.formatMessagesSync(messages, { kind, color: false }).join('\n'));
}

async function buildTarget(target) {
  const { outfile, ...options } = target;
  const result = await esbuild.build({
    ...SHARED,
    ...options,
    outfile: path.join(ROOT, outfile)
  });

  reportMessages(outfile, result.warnings, 'warning');
  return { outfile, result };
}

/** Raw, gzip and (informational) module count for one written artifact. */
function measure(outfile, result) {
  const bytes = fs.readFileSync(path.join(ROOT, outfile));
  const output = Object.values(result.metafile.outputs)[0];

  return {
    outfile,
    raw: bytes.length,
    gzip: zlib.gzipSync(bytes, { level: 9 }).length,
    modules: Object.keys(output.inputs).length
  };
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function printReport(rows) {
  console.log(`\nCloudCanvas v${pkg.version} - esbuild ${esbuild.version}`);
  console.log(`${'artifact'.padEnd(30)}${'raw'.padStart(12)}${'gzip'.padStart(12)}   modules`);

  for (const row of rows) {
    const name = path.basename(row.outfile).padEnd(30);
    console.log(`${name}${kib(row.raw).padStart(12)}${kib(row.gzip).padStart(12)}   ${row.modules}`);
  }
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const built = [];
  for (const target of TARGETS) built.push(await buildTarget(target));

  printReport(built.map(({ outfile, result }) => measure(outfile, result)));
}

main().catch((error) => {
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    console.error(esbuild.formatMessagesSync(error.errors, { kind: 'error', color: true }).join('\n'));
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
