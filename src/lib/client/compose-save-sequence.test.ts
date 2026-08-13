import { describe, expect, test } from 'bun:test';
import { ComposeSaveSequence } from './compose-save-sequence';

describe('ComposeSaveSequence', () => {
  test('distinguishes a newer edit from a closed compose session', () => {
    const sequence = new ComposeSaveSequence();
    const save = sequence.begin();
    sequence.changed();
    expect(save.isActive()).toBe(true);
    expect(save.isCurrent()).toBe(false);
    sequence.reset();
    expect(save.isActive()).toBe(false);
  });
});
