import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockTerminal, ZvtClient, type MockScenario } from '@accurateitsolutionorg/nexi-zvt-client';

const port = 22007;
let terminal: MockTerminal;

function client(timeout = 2500): ZvtClient {
  return new ZvtClient({
    host: '127.0.0.1',
    port,
    password: '000000',
    connectTimeoutMs: 1000,
    ackTimeoutMs: 1000,
    transactionTimeoutMs: timeout,
  });
}

async function registeredClient(timeout?: number): Promise<ZvtClient> {
  const c = client(timeout);
  await c.connect();
  await c.register();
  return c;
}

describe('MockTerminal e2e', () => {
  beforeAll(async () => {
    terminal = new MockTerminal({ port });
    await terminal.start();
  });

  afterAll(async () => {
    await terminal.stop();
  });

  it('approves payments and increments trace and receipt numbers', async () => {
    terminal.setScenario('approve');
    const c = await registeredClient();
    const first = await c.payment(100);
    const second = await c.payment(100);
    expect(first.approved).toBe(true);
    expect(first.amountCents).toBe(100);
    expect(first.merchantReceipt).toHaveLength(2);
    expect(second.receiptNo).toBe((first.receiptNo ?? 0) + 1);
    expect(second.traceNo).toBe((first.traceNo ?? 0) + 1);
    c.disconnect();
  });

  it.each([
    ['decline', 0x6c, 'Aborted'] as const,
    ['decline-expired', 0x78, 'Card expired'] as const,
  ])('returns a declined result for %s', async (scenario: MockScenario, code: number, text: string) => {
    terminal.setScenario(scenario);
    const c = await registeredClient();
    const result = await c.payment(100);
    expect(result.approved).toBe(false);
    expect(result.resultCode).toBe(code);
    expect(result.resultText).toContain(text);
    c.disconnect();
  });

  it('rejects timeout cleanly', async () => {
    terminal.setScenario('timeout');
    const c = await registeredClient(700);
    await expect(c.payment(100)).rejects.toThrow(/Timeout waiting for completion/);
    c.disconnect();
  });

  it('recovers after a dropped connection', async () => {
    terminal.setScenario('drop');
    const c = await registeredClient(1200);
    await expect(c.payment(100)).rejects.toThrow(/Connection closed|Timeout/);
    c.disconnect();

    terminal.setScenario('approve');
    const recovered = await registeredClient();
    const result = await recovered.payment(100);
    expect(result.approved).toBe(true);
    recovered.disconnect();
  });

  it('handles slow status-heavy payments', async () => {
    terminal.setScenario('slow');
    const c = await registeredClient(10_000);
    const statuses: string[] = [];
    c.on('status', (s) => statuses.push(s.text));
    const result = await c.payment(100);
    expect(result.approved).toBe(true);
    expect(statuses.length).toBeGreaterThanOrEqual(4);
    c.disconnect();
  });

  it('supports reversal and end-of-day', async () => {
    terminal.setScenario('approve');
    const c = await registeredClient();
    const reversal = await c.reversal(7);
    const eod = await c.endOfDay();
    expect(reversal.approved).toBe(true);
    expect(eod.approved).toBe(true);
    c.disconnect();
  });
});
