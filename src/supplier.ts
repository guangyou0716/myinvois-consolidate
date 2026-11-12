import { InputError } from './errors.js';

export interface Supplier {
  name: string;
  tin: string;
  brn: string;
  sst: string;
  ttx: string;
  msic: string;
  msicDescription: string;
  addressLines: string[];
  city: string;
  postcode: string;
  /** Malaysian state code, e.g. "07" for Pulau Pinang. */
  state: string;
  country: string;
  phone: string;
  email?: string;
}

function str(obj: Record<string, unknown>, key: string, fallback?: string): string {
  const value = obj[key];
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InputError(`supplier file: "${key}" must be a non-empty string.`);
  }
  return value.trim();
}

/** Reads the supplier JSON. Format checks are basic; run myinvois-precheck on the output for the full rule set. */
export function parseSupplier(json: unknown): Supplier {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new InputError('supplier file must be a JSON object.');
  }
  const obj = json as Record<string, unknown>;
  const lines = obj.addressLines;
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 3 || !lines.every((l) => typeof l === 'string' && l.trim() !== '')) {
    throw new InputError('supplier file: "addressLines" must be 1 to 3 non-empty strings.');
  }
  const supplier: Supplier = {
    name: str(obj, 'name'),
    tin: str(obj, 'tin'),
    brn: str(obj, 'brn'),
    sst: str(obj, 'sst', 'NA'),
    ttx: str(obj, 'ttx', 'NA'),
    msic: str(obj, 'msic'),
    msicDescription: str(obj, 'msicDescription'),
    addressLines: lines.map((l: string) => l.trim()),
    city: str(obj, 'city'),
    postcode: str(obj, 'postcode'),
    state: str(obj, 'state'),
    country: str(obj, 'country', 'MYS'),
    phone: str(obj, 'phone'),
  };
  if (obj.email !== undefined) {
    supplier.email = str(obj, 'email');
  }
  if (!/^\d{5}$/.test(supplier.msic)) {
    throw new InputError('supplier file: "msic" must be a 5-digit MSIC code.');
  }
  if (!/^\d{2}$/.test(supplier.state)) {
    throw new InputError('supplier file: "state" must be a 2-digit state code (e.g. "07").');
  }
  if (/^EI\d{11}$/.test(supplier.tin)) {
    throw new InputError('supplier file: "tin" must be your own TIN, not a general TIN.');
  }
  return supplier;
}
