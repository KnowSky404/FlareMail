import { describe, expect, test } from 'bun:test';
import { selectedVisibleMessages } from './mailbox-selection';

describe('visible mailbox selection', () => {
  test('includes only selected visible rows and de-duplicates thread/message overlap', () => {
    const inbox = { id: 'inbox', folder: 'inbox' };
    const sent = { id: 'sent', folder: 'sent' };
    const draft = { id: 'draft', folder: 'drafts' };
    expect(selectedVisibleMessages(
      [{ sectionLatestMessage: inbox }],
      [inbox, sent, draft],
      new Set(['inbox', 'draft', 'off-page'])
    )).toEqual([inbox, draft]);
  });

  test('preserves list order with many loaded messages and no selection', () => {
    const messages = Array.from({ length: 5_000 }, (_, index) => ({ id: `message-${index}` }));
    expect(selectedVisibleMessages([], messages, new Set())).toEqual([]);
    expect(selectedVisibleMessages([], messages, new Set(['message-4999', 'message-1']))).toEqual([
      messages[1], messages[4999]
    ]);
  });
});
