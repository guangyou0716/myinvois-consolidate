#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { consolidate } from './consolidate.js';
import { InputError } from './errors.js';
import type { Method } from './lines.js';
import { parseReceipts } from './receipts.js';
import { parseOriginal, refundNote, refundSummaryJson, refundTextReport, type NoteKind, type OriginalDocument } from './refund.js';
import { documentFile, summaryJson, textReport } from './report.js';
import { parseSupplier } from './supplier.js';

const USAGE = `Usage: myinvois-consolidate build <receipts.csv> --supplier <supplier.json> --month YYYY-MM [options]
       myinvois-consolidate refund-note <refunds.csv> --supplier <supplier.json> --month YYYY-MM
                            (--original <CONS-....json> | --original-id <ID>) --original-uuid <UUID> [options]
       myinvois-consolidate credit-note <credits.csv> ... (same options as refund-note)

Builds monthly consolidated e-Invoices (buyer "General Public", TIN EI00000000010, classification 004)
from B2C receipts, as unsigned MyInvois UBL 2.1 JSON or XML (v1.0). Offline; never submits anything.

Options:
  --supplier <file>     supplier JSON (name, tin, brn, msic, msicDescription, addressLines, city, postcode, state, phone, ...)
  --month YYYY-MM       month being consolidated; every receipt must fall in it
  --method chain|receipt  chain (default): one line per continuous receipt-number chain; receipt: one line per receipt
  --by-branch           one document series per value of the CSV "branch" column
  --prefix <text>       document ID prefix (default CONS), IDs look like CONS-202610-001
  --issued-at <iso>     issue time (default now), e.g. 2026-11-03T09:00:00+08:00
  --format json|xml     document encoding (default json); size limits are measured on it
  --out <dir>           write <ID>.json or <ID>.xml per document and summary.json (refuses to overwrite)
  --json                print the summary as JSON
  -h, --help            show this help

refund-note: one unsigned Refund Note (type 04) against a validated consolidated e-Invoice, for receipts refunded
after it was submitted. refunds.csv has the receipts CSV columns; date is the original receipt date, amounts are the
refunded amounts. One line per refunded receipt.
  --original <file>     the consolidated e-Invoice JSON written by build (checks supplier, month and amount)
  --original-id <ID>    its ID instead, when the JSON is not at hand (no checks)
  --original-uuid <UUID>  the UUID MyInvois returned when it validated the consolidated e-Invoice
  --id <text>           refund note ID (default RN-<original ID>)
  --issued-at, --format, --out, --json as for build (--out writes <ID>.json or <ID>.xml)

credit-note: the same, as one unsigned Credit Note (type 02) for receipts whose amount was reduced after the
consolidated e-Invoice was submitted (a discount or price correction, no money paid back). credits.csv amounts are the
reductions; the default ID is CN-<original ID>.

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
        format: { type: 'string', default: 'json' },
        out: { type: 'string' },
        original: { type: 'string' },
        'original-id': { type: 'string' },
        'original-uuid': { type: 'string' },
        id: { type: 'string' },
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
    const command = positionals[0];
    const isNote = command === 'refund-note' || command === 'credit-note';
    if ((command !== 'build' && !isNote) || positionals.length !== 2) {
      throw new InputError('expected: build <receipts.csv>, refund-note <refunds.csv> or credit-note <credits.csv>');
    }
    const refundOnly = ['original', 'original-id', 'original-uuid', 'id'] as const;
    if (command === 'build' && refundOnly.some((name) => values[name] !== undefined)) {
      throw new InputError('--original, --original-id, --original-uuid and --id are for refund-note and credit-note only.');
    }
    if (isNote && (values['by-branch'] || values.prefix !== undefined || argv.some((a) => a === '--method' || a.startsWith('--method=')))) {
      throw new InputError(`--method, --by-branch and --prefix are for build only (a ${command === 'credit-note' ? 'credit' : 'refund'} note has one line per receipt).`);
    }
    if (values.supplier === undefined || values.month === undefined) {
      throw new InputError('--supplier and --month are required.');
    }
    if (values.format !== 'json' && values.format !== 'xml') {
      throw new InputError('--format must be json or xml.');
    }
    const issuedAt = values['issued-at'] === undefined ? new Date() : new Date(values['issued-at']);
    if (values['issued-at'] !== undefined && !/(Z|[+-]\d{2}:\d{2})$/.test(values['issued-at'])) {
      throw new InputError('--issued-at needs a time zone, e.g. 2026-11-03T09:00:00+08:00 or ...Z.');
    }
    const receipts = parseReceipts(read(positionals[1], command === 'build' ? 'receipts CSV' : command === 'credit-note' ? 'credits CSV' : 'refunds CSV'));
    let supplierJson: unknown;
    try {
      supplierJson = JSON.parse(read(values.supplier, 'supplier file'));
    } catch (error) {
      if (error instanceof InputError) {
        throw error;
      }
      throw new InputError(`supplier file is not valid JSON (${(error as Error).message}).`);
    }
    const supplier = parseSupplier(supplierJson);
    if (isNote) {
      return refundCommand(command === 'credit-note' ? 'credit' : 'refund', receipts, supplier, values, issuedAt);
    }
    if (values.method !== 'chain' && values.method !== 'receipt') {
      throw new InputError('--method must be chain or receipt.');
    }
    const result = consolidate(receipts, supplier, {
      month: values.month,
      method: values.method as Method,
      byBranch: values['by-branch'],
      idPrefix: values.prefix,
      issuedAt,
      format: values.format,
    });
    if (!result.reconciled) {
      process.stdout.write(values.json ? `${JSON.stringify(summaryJson(result), null, 2)}\n` : textReport(result));
      process.stderr.write('error: documents do not reconcile with receipts; nothing written.\n');
      return 1;
    }
    if (values.out !== undefined) {
      const files = [...result.documents.map((d) => documentFile(d.id, result.format)), 'summary.json'].map((f) => join(values.out as string, f));
      const existing = files.filter((f) => existsSync(f));
      if (existing.length > 0) {
        throw new InputError(`refusing to overwrite ${existing[0]}${existing.length > 1 ? ` and ${existing.length - 1} more` : ''}.`);
      }
      mkdirSync(values.out, { recursive: true });
      for (const doc of result.documents) {
        writeFileSync(join(values.out, documentFile(doc.id, result.format)), `${doc.body}\n`, { flag: 'wx' });
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

interface RefundValues {
  month?: string;
  format?: string;
  out?: string;
  json?: boolean;
  original?: string;
  'original-id'?: string;
  'original-uuid'?: string;
  id?: string;
}

function refundCommand(
  kind: NoteKind,
  refunds: ReturnType<typeof parseReceipts>,
  supplier: ReturnType<typeof parseSupplier>,
  values: RefundValues,
  issuedAt: Date,
): number {
  if ((values.original === undefined) === (values['original-id'] === undefined)) {
    throw new InputError(`${kind}-note needs exactly one of --original <file.json> or --original-id <ID>.`);
  }
  if (values['original-uuid'] === undefined) {
    throw new InputError(`${kind}-note needs --original-uuid (the UUID MyInvois returned for the consolidated e-Invoice).`);
  }
  let originalDocument: OriginalDocument | undefined;
  if (values.original !== undefined) {
    originalDocument = parseOriginal(read(values.original, 'original document'));
  }
  const result = refundNote(refunds, supplier, {
    kind,
    month: values.month as string,
    original: { id: originalDocument?.id ?? (values['original-id'] as string), uuid: values['original-uuid'] },
    originalDocument,
    id: values.id,
    issuedAt,
    format: values.format as 'json' | 'xml',
  });
  if (values.out !== undefined) {
    const file = join(values.out, documentFile(result.id, result.format));
    if (existsSync(file)) {
      throw new InputError(`refusing to overwrite ${file}.`);
    }
    mkdirSync(values.out, { recursive: true });
    writeFileSync(file, `${result.body}\n`, { flag: 'wx' });
  }
  process.stdout.write(values.json ? `${JSON.stringify(refundSummaryJson(result), null, 2)}\n` : refundTextReport(result, values.out));
  return 0;
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
