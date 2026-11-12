import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { root } from './helpers.js';

const csvPath = join(root, 'examples', 'receipts-2026-10.csv');
const supplierPath = join(root, 'examples', 'supplier.json');
const args = ['build', csvPath, '--supplier', supplierPath, '--month', '2026-10', '--issued-at', '2026-11-03T09:00:00+08:00'];

function capture() {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => ((out += String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => ((err += String(chunk)), true));
  return { out: () => out, err: () => err };
}

afterEach(() => vi.restoreAllMocks());

describe('cli', () => {
  it('prints a dry-run text summary', () => {
    const io = capture();
    expect(main(args)).toBe(0);
    expect(io.out()).toContain('CONS-202610-001');
    expect(io.out()).toContain('Total: RM352.95 + tax RM18.14 = RM371.09 (documents reconcile with receipts)');
    expect(io.out()).toContain('Submit by 2026-11-07');
    expect(io.out()).toContain('Dry run');
  });
  it('prints the exemption reason next to tax type E', () => {
    const io = capture();
    const exempt = ['build', join(root, 'examples', 'receipts-2026-10-exempt.csv'), ...args.slice(2)];
    expect(main(exempt)).toBe(0);
    expect(io.out()).toContain(
      'tax type E: RM57.50 + tax RM0.00 (exemption reason: Exempted goods, example reference EXM-2026-001 (synthetic))',
    );
    expect(io.out()).toContain('Total: RM85.90 + tax RM1.60 = RM87.50 (documents reconcile with receipts)');
  });
  it('prints totals per exemption reason when there are several', () => {
    const io = capture();
    const multi = ['build', join(root, 'examples', 'receipts-2026-10-exempt-multi.csv'), ...args.slice(2)];
    expect(main(multi)).toBe(0);
    expect(io.out()).toContain('CONS-202610-E1-001');
    expect(io.out()).toContain('tax type E: RM58.50 + tax RM0.00\n');
    expect(io.out()).toContain('    E1: RM28.00 (exemption reason: Exempted goods, example reference EXM-2026-001 (synthetic))');
    expect(io.out()).toContain('    E2: RM30.50 (exemption reason: Exempted services, example reference EXM-2026-002 (synthetic))');
    expect(io.out()).toContain('(documents reconcile with receipts)');
  });
  it('writes documents and summary.json, then refuses to overwrite', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cons-'));
    capture();
    expect(main([...args, '--by-branch', '--out', dir])).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['CONS-202610-KL1-001.json', 'CONS-202610-PG1-001.json', 'summary.json']);
    const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(summary.documents[0]).not.toHaveProperty('json');
    expect(summary.documents[0].file).toBe('CONS-202610-KL1-001.json');
    const doc = JSON.parse(readFileSync(join(dir, 'CONS-202610-KL1-001.json'), 'utf8'));
    expect(doc.Invoice[0].IssueTime[0]._).toBe('01:00:00Z');
    const io = capture();
    expect(main([...args, '--by-branch', '--out', dir])).toBe(2);
    expect(io.err()).toMatch(/refusing to overwrite/);
  });
  it('--json prints the summary', () => {
    const io = capture();
    expect(main([...args, '--json', '--method', 'receipt'])).toBe(0);
    const summary = JSON.parse(io.out());
    expect(summary.method).toBe('receipt');
    expect(summary.lines).toBe(8);
  });
  it('exits 2 with a message on input errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cons-'));
    const badJson = join(dir, 'bad.json');
    writeFileSync(badJson, '{');
    const cases: [string[], RegExp][] = [
      [['build', csvPath], /--supplier and --month are required/],
      [['nope'], /expected: build/],
      [[...args, '--method', 'x'], /--method must be/],
      [['build', csvPath, '--supplier', supplierPath, '--month', '2026-10', '--issued-at', '2026-11-03T09:00'], /time zone/],
      [['build', join(dir, 'missing.csv'), '--supplier', supplierPath, '--month', '2026-10'], /cannot read receipts CSV/],
      [['build', csvPath, '--supplier', badJson, '--month', '2026-10'], /not valid JSON/],
      [['--bogus'], /Unknown option/],
    ];
    for (const [argv, message] of cases) {
      const io = capture();
      expect(main(argv)).toBe(2);
      expect(io.err()).toMatch(message);
      vi.restoreAllMocks();
    }
  });
  it('--help exits 0', () => {
    const io = capture();
    expect(main(['--help'])).toBe(0);
    expect(io.out()).toContain('Usage: myinvois-consolidate build');
  });
});
