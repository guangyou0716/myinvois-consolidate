import { describe, expect, it } from 'vitest';
import { parseSupplier } from '../src/supplier.js';
import { example } from './helpers.js';

const base = () => JSON.parse(example('supplier.json')) as Record<string, unknown>;

describe('parseSupplier', () => {
  it('reads the example and defaults sst / ttx / country', () => {
    const raw = base();
    delete raw.sst;
    delete raw.ttx;
    delete raw.country;
    expect(parseSupplier(raw)).toMatchObject({ sst: 'NA', ttx: 'NA', country: 'MYS', state: '07' });
  });
  it('rejects missing fields and bad codes', () => {
    expect(() => parseSupplier([])).toThrow(/JSON object/);
    expect(() => parseSupplier({ ...base(), name: '' })).toThrow(/"name"/);
    expect(() => parseSupplier({ ...base(), msic: '4719' })).toThrow(/msic/);
    expect(() => parseSupplier({ ...base(), state: '7' })).toThrow(/state/);
    expect(() => parseSupplier({ ...base(), addressLines: [] })).toThrow(/addressLines/);
    expect(() => parseSupplier({ ...base(), tin: 'EI00000000010' })).toThrow(/general TIN/);
  });
});
