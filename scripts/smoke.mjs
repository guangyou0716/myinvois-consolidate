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

// Same busy month as XML: larger encoding, so more documents, each still under the limit.
const outXml = join(dir, 'out-xml');
const xmlSummary = JSON.parse(
  execFileSync(process.execPath, [cli, 'build', big, ...common, '--method', 'receipt', '--format', 'xml', '--out', outXml], { encoding: 'utf8' }),
);
if (!xmlSummary.reconciled || xmlSummary.totalsFromDocuments.total !== '79980.00' || xmlSummary.documents.length <= summary.documents.length) {
  fail(`big month xml: ${xmlSummary.documents.length} documents, ${JSON.stringify(xmlSummary.totalsFromDocuments)}`);
}
const xmlFiles = readdirSync(outXml).filter((f) => f.startsWith('CONS-'));
if (xmlFiles.length !== xmlSummary.documents.length || !xmlFiles.every((f) => f.endsWith('.xml'))) {
  fail(`big month xml files: ${xmlFiles.join(', ')}`);
}
for (const file of xmlFiles) {
  if (statSync(join(outXml, file)).size > 300_001) {
    fail(`${file} is over 300000 bytes`);
  }
}
console.log(`smoke: ok big month as XML -> ${xmlSummary.documents.length} documents, RM${xmlSummary.totalsFromDocuments.total}`);
console.log(`smoke: files in ${out} and ${outXml}`);

// Refund note against the example consolidated e-Invoice, checked against the original document.
const consOut = join(dir, 'cons');
execFileSync(process.execPath, [cli, 'build', example('receipts-2026-10.csv'), ...common, '--out', consOut], { encoding: 'utf8' });
const refund = JSON.parse(
  execFileSync(
    process.execPath,
    [cli, 'refund-note', example('refunds-2026-10.csv'), '--supplier', example('supplier.json'), '--month', '2026-10',
      '--original', join(consOut, 'CONS-202610-001.json'), '--original-uuid', 'F9D425P6DS7D8IU5ABCDEF1234',
      '--issued-at', '2026-11-20T10:00:00+08:00', '--json'],
    { encoding: 'utf8' },
  ),
);
if (refund.id !== 'RN-CONS-202610-001' || refund.totals.total !== '141.30' || !refund.checkedAgainstOriginal) {
  fail(`refund note: ${JSON.stringify(refund)}`);
}
console.log('smoke: ok refund note RN-CONS-202610-001 RM141.30 against CONS-202610-001');

// Credit note (type 02) against the same consolidated e-Invoice.
const credit = JSON.parse(
  execFileSync(
    process.execPath,
    [cli, 'credit-note', example('credits-2026-10.csv'), '--supplier', example('supplier.json'), '--month', '2026-10',
      '--original', join(consOut, 'CONS-202610-001.json'), '--original-uuid', 'F9D425P6DS7D8IU5ABCDEF1234',
      '--issued-at', '2026-11-20T10:00:00+08:00', '--json'],
    { encoding: 'utf8' },
  ),
);
if (credit.id !== 'CN-CONS-202610-001' || credit.typeCode !== '02' || credit.totals.total !== '12.80' || !credit.checkedAgainstOriginal) {
  fail(`credit note: ${JSON.stringify(credit)}`);
}
console.log('smoke: ok credit note CN-CONS-202610-001 (type 02) RM12.80 against CONS-202610-001');
