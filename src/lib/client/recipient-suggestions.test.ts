import { describe, expect, test } from 'bun:test';
import type { MailMessage } from '$lib/domain/mail';
import { deriveRecipientSuggestions, matchRecipientSuggestions } from './recipient-suggestions';

function message(partial: Pick<MailMessage, 'folder' | 'sentAt'> & Partial<MailMessage>): MailMessage {
  return { fromName: '', fromEmail: '', toEmail: '', ...partial } as MailMessage;
}

describe('recent recipient suggestions', () => {
  test('uses recent correspondents, deduplicates addresses, and excludes own identities', () => {
    const suggestions = deriveRecipientSuggestions([
      message({ folder: 'inbox', sentAt: '2026-09-27T00:00:00Z', fromName: 'Old name', fromEmail: 'A@example.test' }),
      message({ folder: 'sent', sentAt: '2026-09-28T00:00:00Z', toAddresses: [
        { name: 'Alice', email: 'a@example.test' },
        { name: 'Me', email: 'owner@example.test' }
      ] }),
      message({ folder: 'inbox', sentAt: '2026-09-26T00:00:00Z', fromEmail: 'invalid' })
    ], ['OWNER@EXAMPLE.TEST']);

    expect(suggestions).toEqual([{ name: 'Alice', email: 'a@example.test' }]);
  });

  test('matches name or address while omitting selected recipients and delimiter input', () => {
    const suggestions = [
      { name: 'Alice', email: 'alice@example.test' },
      { name: 'Bob', email: 'bob@example.test' }
    ];
    expect(matchRecipientSuggestions(suggestions, 'ALI', [])).toEqual([suggestions[0]]);
    expect(matchRecipientSuggestions(suggestions, 'example', [suggestions[0]])).toEqual([suggestions[1]]);
    expect(matchRecipientSuggestions(suggestions, 'a, b', [])).toEqual([]);
  });
});
