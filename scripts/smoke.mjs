#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const example = (name) => join(root, 'examples', name);
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const common = ['--supplier', example('supplier.json'), '--month', '2026-10', '--issued-at', '2026-11-03T09:00:00+08:00', '--json'];

const dir = mkdtempSync(join(tmpdir(), 'cons-smoke-'));
const link = join(dir, 'myinvois-consolidate');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const summary = JSON.parse(execFileSync(process.execPath, [bin, 'build', example('receipts-2026-10.csv'), ...common], { encoding: 'utf8' }));
  if (!summary.reconciled || summary.totalsFromDocuments.total !== '371.09' || summary.documents.length !== 1) {
    fail(`example via ${bin}: ${JSON.stringify(summary.totalsFromDocuments)}`);
  }
}
console.log('smoke: ok example (direct and via symlink) RM371.09, 1 document');

const exempt = JSON.parse(execFileSync(process.execPath, [cli, 'build', example('receipts-2026-10-exempt.csv'), ...common], { encoding: 'utf8' }));
const typeE = exempt.byTaxType?.find((t) => t.taxType === 'E');
if (!exempt.reconciled || exempt.totalsFromDocuments.total !== '87.50' || typeE?.subtotal !== '57.50') {
  fail(`exempt example: ${JSON.stringify(exempt.totalsFromDocuments)} ${JSON.stringify(typeE)}`);
}
console.log('smoke: ok tax type E example RM87.50 (E RM57.50)');

// A busy month: 6000 receipts with every other number missing, one line per receipt -> must split.
const rows = ['receipt,date,subtotal,tax_type,tax'];
for (let i = 1; i <= 6000; i++) {
  rows.push(`POS1-${String(i * 2).padStart(7, '0')},2026-10-${String((i % 31) + 1).padStart(2, '0')},12.34,02,0.99`);
}
const big = join(dir, 'big.csv');
writeFileSync(big, `${rows.join('\n')}\n`);
const out = join(dir, 'out');
const summary = JSON.parse(execFileSync(process.execPath, [cli, 'build', big, ...common, '--method', 'receipt', '--out', out], { encoding: 'utf8' }));
if (!summary.reconciled || summary.totalsFromDocuments.total !== '79980.00' || summary.documents.length < 2) {
  fail(`big month: ${summary.documents.length} documents, ${JSON.stringify(summary.totalsFromDocuments)}`);
}
for (const file of readdirSync(out).filter((f) => f.startsWith('CONS-'))) {
  if (statSync(join(out, file)).size > 300_001) {
    fail(`${file} is over 300000 bytes`);
  }
}
console.log(`smoke: ok big month 6000 receipts -> ${summary.documents.length} documents, RM${summary.totalsFromDocuments.total}`);
console.log(`smoke: files in ${out}`);
