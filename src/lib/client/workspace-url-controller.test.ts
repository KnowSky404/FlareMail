import { describe, expect, test } from 'bun:test';
import { readWorkspaceUrl, updateWorkspaceUrl } from './workspace-url-controller';

describe('workspace URL controller', () => {
  test('normalizes invalid state without dropping unrelated parameters', () => {
    const url = new URL('https://flaremail.example/?folder=unknown&q=123456789&filter=bad&keep=yes');
    expect(readWorkspaceUrl(url)).toEqual({ section: 'inbox', query: '123456789', filter: 'all', messageId: null });
    const next = updateWorkspaceUrl(url, { section: 'profile', query: '', filter: 'all', messageId: null });
    expect(next.toString()).toBe('https://flaremail.example/?folder=settings&keep=yes');
  });

  test('round trips folder, filter, search and selected message', () => {
    const next = updateWorkspaceUrl(new URL('https://flaremail.example/'), {
      section: 'sent',
      query: '  invoice ',
      filter: 'starred',
      messageId: 'message-1'
    });
    expect(readWorkspaceUrl(next)).toEqual({ section: 'sent', query: 'invoice', filter: 'starred', messageId: 'message-1' });
  });
});
