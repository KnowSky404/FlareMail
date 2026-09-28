import { describe, expect, test } from 'bun:test';
import { nextRadioIndex } from './radio-navigation';

describe('radio group navigation', () => {
  test('wraps arrow navigation and supports first and last positions', () => {
    expect(nextRadioIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextRadioIndex('ArrowDown', 0, 3)).toBe(1);
    expect(nextRadioIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextRadioIndex('ArrowUp', 2, 3)).toBe(1);
    expect(nextRadioIndex('Home', 2, 3)).toBe(0);
    expect(nextRadioIndex('End', 0, 3)).toBe(2);
  });

  test('leaves unrelated keys and invalid targets to their normal handlers', () => {
    expect(nextRadioIndex('Tab', 0, 3)).toBeNull();
    expect(nextRadioIndex('Escape', 0, 3)).toBeNull();
    expect(nextRadioIndex('ArrowRight', -1, 3)).toBeNull();
    expect(nextRadioIndex('ArrowRight', 0, 0)).toBeNull();
  });
});
