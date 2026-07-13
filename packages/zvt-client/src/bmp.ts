/**
 * Parser for the BMP-encoded payload of Status Information (04 0F) and
 * related messages.
 *
 * The payload is a sequence of fields, each starting with a 1-byte BMP tag.
 * Field length is defined per-tag: fixed, LLVAR (2 length bytes 0xFx 0xFy ->
 * length xy), LLLVAR (3 length bytes 0xFx 0xFy 0xFz -> length xyz), or a
 * BER-TLV container (BMP 06).
 *
 * Robustness rule: an unknown BMP tag has an unknown length, so parsing the
 * rest of the buffer would be guesswork. We stop, keep everything parsed so
 * far, and expose the remainder for hex logging instead of crashing.
 */

import { bcdToAmountCents, bcdToDigitString, bcdToNumber } from './bcd.js';
import { CARD_TYPE, errorText } from './constants.js';

type LenSpec = number | 'LLVAR' | 'LLLVAR' | 'TLV';

/** Length spec per BMP tag (subset relevant to payment responses). */
const BMP_LENGTH: Record<number, LenSpec> = {
  0x01: 1, // timeout
  0x02: 1, // max status infos
  0x03: 1, // service byte
  0x04: 6, // amount (BCD cents)
  0x05: 1, // pump number
  0x06: 'TLV', // TLV container
  0x0b: 3, // trace number (BCD)
  0x0c: 3, // time HHMMSS (BCD)
  0x0d: 2, // date MMDD (BCD)
  0x0e: 2, // expiry YYMM (BCD)
  0x17: 2, // card sequence number (BCD)
  0x19: 1, // payment type / status byte
  0x22: 'LLVAR', // PAN / EF_ID (masked, BCD nibbles)
  0x23: 'LLVAR', // track 2
  0x24: 'LLLVAR', // track 3
  0x27: 1, // result code
  0x29: 4, // terminal ID (BCD)
  0x2a: 15, // VU number (ASCII)
  0x37: 3, // original trace number (BCD)
  0x3b: 8, // AID authorization attribute
  0x3c: 'LLLVAR', // additional text
  0x3d: 3, // password (BCD)
  0x49: 2, // currency (BCD)
  0x60: 'LLLVAR', // individual totals
  0x87: 2, // receipt number (BCD)
  0x88: 3, // turnover record number (BCD)
  0x8a: 1, // card type
  0x8b: 'LLVAR', // card name (ASCII)
  0x8c: 1, // card type ID
  0xa0: 1, // result code AS
  0xaa: 3, // date YYMMDD (BCD)
  0xba: 5, // AID parameter
};

export interface TlvItem {
  tag: number;
  value: Buffer;
  children?: TlvItem[];
}

export interface StatusInformation {
  /** BMP 27 result code; 0x00 = approved. */
  resultCode?: number;
  resultText?: string;
  approved: boolean;
  amountCents?: number;
  traceNo?: number;
  originalTraceNo?: number;
  time?: string; // "HHMMSS"
  date?: string; // "MMDD"
  expiry?: string; // "YYMM"
  receiptNo?: number;
  turnoverNo?: number;
  paymentType?: number;
  maskedPan?: string;
  cardSequenceNo?: number;
  terminalId?: string;
  vuNumber?: string;
  aid?: string;
  additionalText?: string;
  cardType?: number;
  cardTypeName?: string;
  cardName?: string;
  currency?: string; // "0978" for EUR
  tlv?: TlvItem[];
  /** BMPs seen but not mapped onto a named field. */
  otherBmps: { tag: number; value: Buffer }[];
  /** Non-empty if an unknown BMP forced parsing to stop early. */
  unparsedRemainder?: Buffer;
}

function readVarLength(buf: Buffer, offset: number, count: 2 | 3): { len: number; next: number } {
  if (offset + count > buf.length) throw new RangeError('Truncated LLVAR length');
  let len = 0;
  for (let i = 0; i < count; i++) {
    const b = buf[offset + i];
    if ((b & 0xf0) !== 0xf0) throw new RangeError(`Bad LLVAR length byte 0x${b.toString(16)}`);
    len = len * 10 + (b & 0x0f);
  }
  return { len, next: offset + count };
}

function readBerLength(buf: Buffer, offset: number): { len: number; next: number } {
  const first = buf[offset];
  if (first < 0x80) return { len: first, next: offset + 1 };
  if (first === 0x81) return { len: buf[offset + 1], next: offset + 2 };
  if (first === 0x82) return { len: (buf[offset + 1] << 8) | buf[offset + 2], next: offset + 3 };
  throw new RangeError(`Unsupported BER length byte 0x${first.toString(16)}`);
}

/** Minimal BER-TLV parser for the ZVT TLV container (BMP 06). */
export function parseTlv(buf: Buffer): TlvItem[] {
  const items: TlvItem[] = [];
  let i = 0;
  while (i < buf.length) {
    let tag = buf[i++];
    const constructed = (tag & 0x20) !== 0;
    if ((tag & 0x1f) === 0x1f) {
      // multi-byte tag
      let t = tag;
      do {
        t = (t << 8) | buf[i];
      } while ((buf[i++] & 0x80) !== 0);
      tag = t;
    }
    const { len, next } = readBerLength(buf, i);
    i = next;
    if (i + len > buf.length) throw new RangeError('Truncated TLV value');
    const value = Buffer.from(buf.subarray(i, i + len));
    i += len;
    const item: TlvItem = { tag, value };
    if (constructed) {
      try {
        item.children = parseTlv(value);
      } catch {
        /* leave as opaque value */
      }
    }
    items.push(item);
  }
  return items;
}

/** PAN nibbles: 0xE nibble encodes the masking character ('*'). */
function decodePan(buf: Buffer): string {
  let s = '';
  for (const byte of buf) {
    for (const nibble of [byte >> 4, byte & 0x0f]) {
      if (nibble <= 9) s += nibble.toString();
      else if (nibble === 0x0e) s += '*';
      else if (nibble === 0x0f) {
        /* padding */
      } else s += '?';
    }
  }
  return s;
}

/** Parse the payload of a 04 0F Status Information message. */
export function parseStatusInformation(data: Buffer): StatusInformation {
  const out: StatusInformation = { approved: false, otherBmps: [] };
  let i = 0;

  while (i < data.length) {
    const tag = data[i++];
    const spec = BMP_LENGTH[tag];

    if (spec === undefined) {
      out.unparsedRemainder = Buffer.from(data.subarray(i - 1));
      break;
    }

    let value: Buffer;
    try {
      if (spec === 'LLVAR' || spec === 'LLLVAR') {
        const { len, next } = readVarLength(data, i, spec === 'LLVAR' ? 2 : 3);
        value = Buffer.from(data.subarray(next, next + len));
        i = next + len;
      } else if (spec === 'TLV') {
        const { len, next } = readBerLength(data, i);
        value = Buffer.from(data.subarray(next, next + len));
        i = next + len;
      } else {
        value = Buffer.from(data.subarray(i, i + spec));
        i += spec;
      }
    } catch {
      out.unparsedRemainder = Buffer.from(data.subarray(i - 1));
      break;
    }

    switch (tag) {
      case 0x27:
        out.resultCode = value[0];
        out.resultText = errorText(value[0]);
        break;
      case 0x04:
        out.amountCents = bcdToAmountCents(value);
        break;
      case 0x0b:
        out.traceNo = bcdToNumber(value);
        break;
      case 0x37:
        out.originalTraceNo = bcdToNumber(value);
        break;
      case 0x0c:
        out.time = bcdToDigitString(value);
        break;
      case 0x0d:
        out.date = bcdToDigitString(value);
        break;
      case 0x0e:
        out.expiry = bcdToDigitString(value);
        break;
      case 0x87:
        out.receiptNo = bcdToNumber(value);
        break;
      case 0x88:
        out.turnoverNo = bcdToNumber(value);
        break;
      case 0x19:
        out.paymentType = value[0];
        break;
      case 0x22:
        out.maskedPan = decodePan(value);
        break;
      case 0x17:
        out.cardSequenceNo = bcdToNumber(value);
        break;
      case 0x29:
        out.terminalId = bcdToDigitString(value);
        break;
      case 0x2a:
        out.vuNumber = value.toString('latin1').trim();
        break;
      case 0x3b:
        out.aid = value.toString('hex').toUpperCase();
        break;
      case 0x3c:
        out.additionalText = value.toString('latin1');
        break;
      case 0x8a:
        out.cardType = value[0];
        out.cardTypeName = CARD_TYPE[value[0]];
        break;
      case 0x8b:
        out.cardName = value.toString('latin1').replace(/\0+$/, '').trim();
        break;
      case 0x49:
        out.currency = bcdToDigitString(value);
        break;
      case 0x06:
        try {
          out.tlv = parseTlv(value);
        } catch {
          out.otherBmps.push({ tag, value });
        }
        break;
      default:
        out.otherBmps.push({ tag, value });
    }
  }

  out.approved = out.resultCode === 0x00;
  return out;
}
