import { describe, expect, test } from 'bun:test';
import { isComposeSendShortcut, isRecipientCommitKey, shouldHandleRecipientKey } from './compose-shortcuts';

const key = (overrides: Partial<KeyboardEvent> = {}) => ({
  key: 'Enter', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
  isComposing: false, repeat: false, defaultPrevented: false, ...overrides
});

describe('compose keyboard actions', () => {
  test('reserves Ctrl and Command Enter for sending without selecting a suggestion', () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(isComposeSendShortcut(key(modifier))).toBe(true);
      expect(shouldHandleRecipientKey(key(modifier))).toBe(false);
      expect(isRecipientCommitKey(key(modifier))).toBe(false);
    }
    expect(isComposeSendShortcut(key())).toBe(false);
    expect(isRecipientCommitKey(key())).toBe(true);
  });

  test('ignores IME confirmation, held keys, already-handled events and extra modifiers', () => {
    for (const suppressed of [
      { isComposing: true }, { keyCode: 229 }, { repeat: true },
      { defaultPrevented: true }, { altKey: true }, { shiftKey: true }
    ]) {
      expect(isComposeSendShortcut(key({ ctrlKey: true, ...suppressed }))).toBe(false);
      expect(shouldHandleRecipientKey(key(suppressed))).toBe(false);
      expect(isRecipientCommitKey(key(suppressed))).toBe(false);
    }
  });

  test('supports address separators without consuming ordinary text or navigation keys', () => {
    for (const separator of [',', '，', ';', '；']) {
      expect(isRecipientCommitKey(key({ key: separator }))).toBe(true);
      expect(isRecipientCommitKey(key({ key: separator, isComposing: true }))).toBe(false);
    }
    for (const ordinary of ['a', '@', 'Tab', 'ArrowDown', 'Escape']) {
      expect(isRecipientCommitKey(key({ key: ordinary }))).toBe(false);
      expect(isComposeSendShortcut(key({ key: ordinary, ctrlKey: true }))).toBe(false);
    }
  });
});
