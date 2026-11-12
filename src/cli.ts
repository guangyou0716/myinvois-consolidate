#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { consolidate } from './consolidate.js';
import { InputError } from './errors.js';
import type { Method } from './lines.js';
import { parseReceipts } from './receipts.js';
import { summaryJson, textReport } from './report.js';
import { parseSupplier } from './supplier.js';

const USAGE = `Usage: myinvois-consolidate build <receipts.csv> --supplier <supplier.json> --month YYYY-MM [options]

Builds monthly consolidated e-Invoices (buyer "General Public", TIN EI00000000010, classification 004)
from B2C receipts, as unsigned MyInvois UBL 2.1 JSON (v1.0). Offline; never submits anything.

Options:
  --supplier <file>     supplier JSON (name, tin, brn, msic, msicDescription, addressLines, city, postcode, state, phone, ...)
  --month YYYY-MM       month being consolidated; every receipt must fall in it
  --method chain|receipt  chain (default): one line per continuous receipt-number chain; receipt: one line per receipt
  --by-branch           one document series per value of the CSV "branch" column
  --prefix <text>       document ID prefix (default CONS), IDs look like CONS-202610-001
  --issued-at <iso>     issue time (default now), e.g. 2026-11-03T09:00:00+08:00
  --out <dir>           write <ID>.json per document and summary.json (refuses to overwrite)
  --json                print the summary as JSON
  -h, --help            show this help

Exit codes: 0 ok, 1 documents do not reconcile with receipts, 2 input error.
`;

export function main(argv: string[]): number {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        supplier: { type: 'string' },
        month: { type: 'string' },
        method: { type: 'string', default: 'chain' },
        'by-branch': { type: 'boolean', default: false },
        prefix: { type: 'string' },
        'issued-at': { type: 'string' },
        out: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    if (positionals[0] !== 'build' || positionals.length !== 2) {
      throw new InputError('expected: build <receipts.csv>');
    }
    if (values.supplier === undefined || values.month === undefined) {
      throw new InputError('--supplier and --month are required.');
    }
    if (values.method !== 'chain' && values.method !== 'receipt') {
      throw new InputError('--method must be chain or receipt.');
    }
    const issuedAt = values['issued-at'] === undefined ? new Date() : new Date(values['issued-at']);
    if (values['issued-at'] !== undefined && !/(Z|[+-]\d{2}:\d{2})$/.test(values['issued-at'])) {
      throw new InputError('--issued-at needs a time zone, e.g. 2026-11-03T09:00:00+08:00 or ...Z.');
    }
    const receipts = parseReceipts(read(positionals[1], 'receipts CSV'));
    let supplierJson: unknown;
    try {
      supplierJson = JSON.parse(read(values.supplier, 'supplier file'));
    } catch (error) {
      if (error instanceof InputError) {
        throw error;
      }
      throw new InputError(`supplier file is not valid JSON (${(error as Error).message}).`);
    }
    const result = consolidate(receipts, parseSupplier(supplierJson), {
      month: values.month,
      method: values.method as Method,
      byBranch: values['by-branch'],
      idPrefix: values.prefix,
      issuedAt,
    });
    if (!result.reconciled) {
      process.stdout.write(values.json ? `${JSON.stringify(summaryJson(result), null, 2)}\n` : textReport(result));
      process.stderr.write('error: documents do not reconcile with receipts; nothing written.\n');
      return 1;
    }
    if (values.out !== undefined) {
      const files = [...result.documents.map((d) => `${d.id}.json`), 'summary.json'].map((f) => join(values.out as string, f));
      const existing = files.filter((f) => existsSync(f));
      if (existing.length > 0) {
        throw new InputError(`refusing to overwrite ${existing[0]}${existing.length > 1 ? ` and ${existing.length - 1} more` : ''}.`);
      }
      mkdirSync(values.out, { recursive: true });
      for (const doc of result.documents) {
        writeFileSync(join(values.out, `${doc.id}.json`), `${JSON.stringify(doc.json)}\n`, { flag: 'wx' });
      }
      writeFileSync(join(values.out, 'summary.json'), `${JSON.stringify(summaryJson(result), null, 2)}\n`, { flag: 'wx' });
    }
    process.stdout.write(values.json ? `${JSON.stringify(summaryJson(result), null, 2)}\n` : textReport(result, values.out));
    return 0;
  } catch (error) {
    if (error instanceof InputError) {
      process.stderr.write(`error: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read ${what} ${path} (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
  }
}

function isEntryPoint(): boolean {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
