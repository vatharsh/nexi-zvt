/**
 * ZVT APDU framing.
 *
 * Every ZVT message is:  CCRC APRC LEN [DATA]
 *   - CCRC/APRC: two control bytes, e.g. 06 01 = Authorization
 *   - LEN: one byte 0x00..0xFE, or the extended form 0xFF LL HH
 *          (16-bit little-endian length) for payloads > 254 bytes.
 *
 * The positive acknowledge is itself an APDU: 80 00 00.
 * The negative acknowledge is 84 XX 00 (XX = error code).
 */

export interface Apdu {
  /** Control field, e.g. 0x0601 for Authorization, 0x040F for Status Information. */
  ctrl: number;
  data: Buffer;
  /** The complete raw frame as received/sent (for hex logging). */
  raw: Buffer;
}

export const ACK_CTRL = 0x8000;
export const NACK_CTRL = 0x8400;

/** Build a raw APDU frame from a 16-bit control field and payload. */
export function buildApdu(ctrl: number, data: Uint8Array = Buffer.alloc(0)): Buffer {
  if (data.length > 0xffff) {
    throw new RangeError(`APDU payload too large: ${data.length}`);
  }
  let header: Buffer;
  if (data.length <= 0xfe) {
    header = Buffer.from([(ctrl >> 8) & 0xff, ctrl & 0xff, data.length]);
  } else {
    header = Buffer.from([
      (ctrl >> 8) & 0xff,
      ctrl & 0xff,
      0xff,
      data.length & 0xff, // low byte first (little-endian per ZVT spec)
      (data.length >> 8) & 0xff,
    ]);
  }
  return Buffer.concat([header, Buffer.from(data)]);
}

/** Positive acknowledge 80 00 00. */
export function buildAck(): Buffer {
  return buildApdu(ACK_CTRL);
}

/** Negative acknowledge 84 XX 00. */
export function buildNack(errorCode: number): Buffer {
  return Buffer.from([0x84, errorCode & 0xff, 0x00]);
}

export function isAck(apdu: Apdu): boolean {
  return apdu.ctrl === ACK_CTRL;
}

export function isNack(apdu: Apdu): boolean {
  return (apdu.ctrl & 0xff00) === NACK_CTRL;
}

export function ctrlHex(ctrl: number): string {
  return ctrl.toString(16).padStart(4, '0').replace(/(..)(..)/, '$1 $2').toUpperCase();
}

export function toHex(buf: Buffer): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
}

/**
 * Incremental frame assembler for a TCP byte stream.
 * TCP gives no message boundaries: a single `data` event may contain half a
 * frame, exactly one frame, or several frames. Feed every chunk to push();
 * it returns all complete APDUs and buffers the remainder.
 */
export class ApduAssembler {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Apdu[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Apdu[] = [];

    for (;;) {
      if (this.buffer.length < 3) break;

      const lenByte = this.buffer[2];
      let headerLen: number;
      let dataLen: number;

      if (lenByte === 0xff) {
        if (this.buffer.length < 5) break;
        headerLen = 5;
        dataLen = this.buffer[3] | (this.buffer[4] << 8);
      } else {
        headerLen = 3;
        dataLen = lenByte;
      }

      const frameLen = headerLen + dataLen;
      if (this.buffer.length < frameLen) break;

      const raw = this.buffer.subarray(0, frameLen);
      frames.push({
        ctrl: (raw[0] << 8) | raw[1],
        data: Buffer.from(raw.subarray(headerLen)),
        raw: Buffer.from(raw),
      });
      this.buffer = this.buffer.subarray(frameLen);
    }

    return frames;
  }

  /** Drop any buffered partial frame (call after a protocol error / reconnect). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
