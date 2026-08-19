import { describe, expect, it } from 'vitest';

import { merchantAliasKey, refineChannel } from './normalization.js';

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

describe('merchantAliasKey — the canonical form a description matches on', () => {
  it('is unchanged for a description already canonical', () => {
    expect(merchantAliasKey('UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD')).toBe(
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    );
  });

  it('ignores casing', () => {
    expect(merchantAliasKey('upi-blinkit9821paytm-blinkit india pvt ltd')).toBe(
      'UPI-BLINKIT9821PAYTM-BLINKIT INDIA PVT LTD',
    );
  });

  it('ignores leading and trailing whitespace', () => {
    expect(merchantAliasKey('   ELECTRICITY BOARD BBPS BILLPAY  ')).toBe(
      'ELECTRICITY BOARD BBPS BILLPAY',
    );
  });

  it('collapses runs of internal whitespace, including tabs and newlines', () => {
    expect(merchantAliasKey('ELECTRICITY   BOARD\tBBPS\nBILLPAY')).toBe(
      'ELECTRICITY BOARD BBPS BILLPAY',
    );
  });

  it('maps descriptions differing only in casing and spacing onto one key', () => {
    expect(merchantAliasKey('  zomato0091   sample  ')).toBe(merchantAliasKey('ZOMATO0091 SAMPLE'));
  });

  it('does not collide descriptions that genuinely differ', () => {
    expect(merchantAliasKey('UPI-ZOMATO0091-A')).not.toBe(merchantAliasKey('UPI-ZOMATO0091-B'));
  });

  it('is empty for a description that is only whitespace', () => {
    // The importer rejects an empty description, so this cannot arrive from an import —
    // it is pinned so the function stays total rather than throwing on an odd input.
    expect(merchantAliasKey('   ')).toBe('');
  });
});
