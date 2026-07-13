/** ZVT command control fields (CCRC APRC as a 16-bit number). */
export const CMD = {
  // ECR -> PT
  REGISTRATION: 0x0600,
  AUTHORIZATION: 0x0601, // card payment
  LOG_OFF: 0x0602,
  REPEAT_RECEIPT: 0x0620,
  PRE_AUTHORIZATION: 0x0622,
  PARTIAL_REVERSAL: 0x0623,
  REVERSAL: 0x0630,
  REFUND: 0x0631,
  END_OF_DAY: 0x0650,
  DIAGNOSIS: 0x0670,
  ABORT: 0x06b0,
  STATUS_ENQUIRY: 0x0501,

  // PT -> ECR
  STATUS_INFORMATION: 0x040f,
  INTERMEDIATE_STATUS: 0x04ff,
  PRINT_LINE: 0x06d1,
  PRINT_TEXT_BLOCK: 0x06d3,
  COMPLETION: 0x060f,
  ABORT_FROM_PT: 0x061e,
} as const;

/**
 * Registration (06 00) config-byte flags.
 * NOTE the inverted sense of the receipt bits: setting the bit means the
 * *ECR* takes over receipt printing (required for the A77 — no printer).
 */
export const CONFIG = {
  /** ECR prints payment receipts (bit set = printout via ECR). */
  ECR_PRINTS_PAYMENT_RECEIPTS: 0x02,
  /** ECR prints administration receipts (end-of-day etc.). */
  ECR_PRINTS_ADMIN_RECEIPTS: 0x04,
  /** PT sends intermediate status information (04 FF) during transactions. */
  SEND_INTERMEDIATE_STATUS: 0x08,
  /** ECR controls payments: manual payment start at the terminal is blocked. */
  ECR_CONTROLS_PAYMENT: 0x10,
  /** ECR controls administration functions at the terminal. */
  ECR_CONTROLS_ADMIN: 0x20,
  /** ECR uses print-text-blocks (06 D3) instead of print-lines (06 D1). */
  USE_PRINT_TEXT_BLOCKS: 0x80,
} as const;

/** Sensible default for this PoC: ECR prints everything + live status. */
export const DEFAULT_CONFIG_BYTE =
  CONFIG.ECR_PRINTS_PAYMENT_RECEIPTS |
  CONFIG.ECR_PRINTS_ADMIN_RECEIPTS |
  CONFIG.SEND_INTERMEDIATE_STATUS;

/** ISO 4217 currency code EUR as 2-byte BCD (09 78). */
export const CURRENCY_EUR = Buffer.from([0x09, 0x78]);

/**
 * Error codes as used in Abort (06 1E) and BMP 27 result code.
 * Subset of the spec's error list (chapter "error-messages") — extend as
 * needed; unknown codes are rendered as hex by errorText().
 */
export const ERROR_TEXT: Record<number, string> = {
  0x00: 'Success',
  0x64: 'Card not readable',
  0x65: 'Card data not present',
  0x66: 'Processing error',
  0x67: 'Function not permitted for ec/Maestro card',
  0x68: 'Function not permitted for credit/fuel card',
  0x6a: 'Turnover file full',
  0x6b: 'Function deactivated (terminal not registered)',
  0x6c: 'Aborted (timeout or abort key)',
  0x6e: 'Card in blocked list',
  0x6f: 'Wrong currency',
  0x71: 'Credit not sufficient (chip card)',
  0x72: 'Chip error',
  0x73: 'Card data incorrect',
  0x77: 'End-of-day batch not possible',
  0x78: 'Card expired',
  0x79: 'Card not yet valid',
  0x7a: 'Card unknown',
  0x7d: 'Communication error',
  0x83: 'Function not possible',
  0x85: 'Key missing',
  0x9a: 'ZVT protocol error',
  0xb4: 'Already reversed',
  0xc3: 'Maximum amount exceeded',
  0xcb: 'Payment method not supported',
  0xd2: 'Reversal not possible',
} as const;

export function errorText(code: number): string {
  return ERROR_TEXT[code] ?? `Error 0x${code.toString(16).padStart(2, '0')}`;
}

/**
 * Intermediate status (04 FF) codes -> operator text. Subset of the spec's
 * table; the terminal may also deliver display text via a TLV container in
 * the same message, which takes precedence when present.
 */
export const INTERMEDIATE_STATUS_TEXT: Record<number, string> = {
  0x01: 'Please watch PIN pad',
  0x02: 'Please watch PIN pad',
  0x03: 'Not accepted',
  0x04: 'Waiting for authorization host',
  0x0a: 'Insert / present card',
  0x0b: 'Please remove card',
  0x0c: 'Card not readable',
  0x0d: 'Processing error',
  0x0e: 'Please wait...',
  0x10: 'Invalid card',
  0x13: 'Payment not possible',
  0x15: 'Incorrect PIN',
  0x17: 'Please wait...',
  0x18: 'PIN try limit exceeded',
  0x1d: 'Declined',
  0x41: 'Please wait...',
} as const;

export function intermediateStatusText(code: number): string {
  return INTERMEDIATE_STATUS_TEXT[code] ?? `Status 0x${code.toString(16).padStart(2, '0')}`;
}

/** BMP 8A card type (common values; provider-dependent — verify in the field). */
export const CARD_TYPE: Record<number, string> = {
  0x05: 'girocard',
  0x06: 'Mastercard',
  0x0a: 'Visa',
  0x0d: 'Maestro',
  0x2e: 'V PAY',
  0x08: 'American Express',
} as const;
