/**
 * Encodes MyInvois UBL 2.1 JSON as UBL 2.1 XML, following the JSON/XML mapping MyInvois uses:
 * `_D`, `_A`, `_B` hold the document, aggregate (cac) and basic (cbc) namespaces; every element is an array of
 * objects; an object with a `_` key is a basic component whose `_` is its text and whose other keys are attributes,
 * and any other object is an aggregate component whose keys are child elements, in order.
 *
 * Element order is taken from the JSON key order, so the JSON builder must list keys in UBL schema order.
 */

import { InputError } from './errors.js';

type Json = Record<string, unknown>;

export const UBL_NAMESPACES = {
  _D: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  _A: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  _B: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
} as const;

const NAME = /^[A-Za-z][A-Za-z0-9]*$/;

function escapeXml(value: string, attribute: boolean, where: string): string {
  // XML 1.0 forbids most C0 control characters even when escaped.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/.test(value)) {
    throw new InputError(`${where} contains a control character that XML 1.0 cannot carry; remove it or use --format json.`);
  }
  let out = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (attribute) {
    out = out.replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');
  } else {
    out = out.replace(/\r/g, '&#13;');
  }
  return out;
}

function scalar(value: unknown, where: string): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  throw new Error(`internal: ${where} is not a string, number or boolean.`);
}

function checkName(name: string): void {
  if (!NAME.test(name)) {
    throw new Error(`internal: "${name}" is not a valid UBL element or attribute name.`);
  }
}

/** XML for one JSON element (an array of occurrences). */
export function elementXml(name: string, occurrences: unknown): string {
  checkName(name);
  if (!Array.isArray(occurrences)) {
    throw new Error(`internal: ${name} must be an array.`);
  }
  let out = '';
  for (const item of occurrences) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`internal: ${name} occurrence must be an object.`);
    }
    const obj = item as Json;
    if ('_' in obj) {
      let attrs = '';
      for (const [key, value] of Object.entries(obj)) {
        if (key === '_') {
          continue;
        }
        checkName(key);
        attrs += ` ${key}="${escapeXml(scalar(value, `${name}@${key}`), true, `${name}@${key}`)}"`;
      }
      out += `<cbc:${name}${attrs}>${escapeXml(scalar(obj._, name), false, name)}</cbc:${name}>`;
    } else {
      let children = '';
      for (const [key, value] of Object.entries(obj)) {
        children += elementXml(key, value);
      }
      out += `<cac:${name}>${children}</cac:${name}>`;
    }
  }
  return out;
}

/** Converts a MyInvois UBL JSON Invoice document (with `_D`, `_A`, `_B` and `Invoice`) to an XML string. */
export function ublJsonToXml(doc: Json): string {
  for (const key of ['_D', '_A', '_B'] as const) {
    if (doc[key] !== UBL_NAMESPACES[key]) {
      throw new Error(`internal: ${key} must be ${UBL_NAMESPACES[key]}.`);
    }
  }
  const roots = Object.keys(doc).filter((key) => !key.startsWith('_'));
  if (roots.length !== 1 || roots[0] !== 'Invoice') {
    throw new Error('internal: document must have exactly one root element, Invoice.');
  }
  const invoice = doc.Invoice;
  if (!Array.isArray(invoice) || invoice.length !== 1 || typeof invoice[0] !== 'object' || invoice[0] === null || '_' in invoice[0]) {
    throw new Error('internal: Invoice must be one aggregate object.');
  }
  let children = '';
  for (const [key, value] of Object.entries(invoice[0] as Json)) {
    children += elementXml(key, value);
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<Invoice xmlns="${UBL_NAMESPACES._D}" xmlns:cac="${UBL_NAMESPACES._A}" xmlns:cbc="${UBL_NAMESPACES._B}">` +
    `${children}</Invoice>`
  );
}
