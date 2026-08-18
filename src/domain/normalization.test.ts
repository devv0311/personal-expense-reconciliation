import { describe, expect, it } from 'vitest';

import { refineChannel } from './normalization.js';

describe('refineChannel — the channel a reference type proves', () => {
  it('refines a UPI reference to the upi channel', () => {
    expect(refineChannel('upi_utr', 'bank_transfer')).toBe('upi');
    expect(refineChannel('upi_rrn', 'bank_transfer')).toBe('upi');
  });

  it('refines a card reference to the card channel', () => {
    expect(refineChannel('card_reference', 'bank_transfer')).toBe('card');
  });

  it('leaves the adapter’s channel alone when the reference proves nothing', () => {
    // A bank reference says "this went through the banking system", which is what
    // bank_transfer already records. Refining it would add no information.
    expect(refineChannel('bank_reference', 'bank_transfer')).toBe('bank_transfer');
    expect(refineChannel('merchant_order_id', 'bank_transfer')).toBe('bank_transfer');
    expect(refineChannel('other', 'bank_transfer')).toBe('bank_transfer');
  });

  it('leaves the channel alone for a cheque, which has no channel to refine to', () => {
    // PAYMENT_CHANNELS has no `cheque` member. Mapping to `other` would be less
    // accurate than the transport the adapter actually recorded.
    expect(refineChannel('cheque_number', 'bank_transfer')).toBe('bank_transfer');
  });

  it('leaves the channel alone when the source carried no reference at all', () => {
    expect(refineChannel(null, 'bank_transfer')).toBe('bank_transfer');
    expect(refineChannel(null, 'cash')).toBe('cash');
  });

  it('never downgrades a channel the source already stated precisely', () => {
    expect(refineChannel('upi_utr', 'upi')).toBe('upi');
    expect(refineChannel('bank_reference', 'card')).toBe('card');
  });
});
