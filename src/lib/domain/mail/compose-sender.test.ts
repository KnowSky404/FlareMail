import { describe, expect, test } from 'bun:test';
import { selectInitialComposeSenderAddressId } from './compose';

const addresses = [
  { id: 'address-a', isDefaultSender: true, sendReady: true },
  { id: 'address-b', isDefaultSender: false, sendReady: true },
  { id: 'address-disabled', isDefaultSender: false, sendReady: false }
];

describe('initial compose sender selection', () => {
  test('prefers the exact ready address filter and falls back to the global default', () => {
    expect(selectInitialComposeSenderAddressId(addresses, 'new', { kind: 'address', id: 'address-b' }, undefined))
      .toBe('address-b');
    expect(selectInitialComposeSenderAddressId(addresses, 'new', { kind: 'address', id: 'address-disabled' }, undefined))
      .toBe('address-a');
    expect(selectInitialComposeSenderAddressId(addresses, 'new', null, undefined)).toBe('address-a');
  });

  test('does not choose an arbitrary address for a domain filter', () => {
    expect(selectInitialComposeSenderAddressId(addresses, 'new', { kind: 'domain', id: 'domain-b' }, undefined))
      .toBe('address-a');
  });

  test('preserves explicit reply, forward, and restored draft sender choices', () => {
    expect(selectInitialComposeSenderAddressId(addresses, 'reply', { kind: 'address', id: 'address-b' }, 'address-a'))
      .toBe('address-a');
    expect(selectInitialComposeSenderAddressId(addresses, 'forward', null, 'address-disabled'))
      .toBe('address-disabled');
    expect(selectInitialComposeSenderAddressId(addresses, 'draft', null, null)).toBeNull();
    expect(selectInitialComposeSenderAddressId(addresses, 'reply', null, undefined)).toBeNull();
  });
});
