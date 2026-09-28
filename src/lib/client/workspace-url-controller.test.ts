import { describe, expect, test } from 'bun:test';
import { readWorkspaceUrl, updateWorkspaceUrl } from './workspace-url-controller';

describe('workspace URL controller', () => {
  test('normalizes invalid state without dropping unrelated parameters', () => {
    const url = new URL('https://flaremail.example/?folder=unknown&q=123456789&filter=bad&keep=yes');
    expect(readWorkspaceUrl(url)).toEqual({ section: 'inbox', managementView: 'settings', managementDomainId: null, query: '123456789', filter: 'all', identityFilter: null, messageId: null });
    const next = updateWorkspaceUrl(url, { section: 'profile', query: '', filter: 'all', messageId: null });
    expect(next.toString()).toBe('https://flaremail.example/?folder=settings&keep=yes');
  });

  test('round trips folder, filter, search and selected message', () => {
    const next = updateWorkspaceUrl(new URL('https://flaremail.example/'), {
      section: 'sent',
      query: '  invoice ',
      filter: 'starred',
      identityFilter: { kind: 'address', id: 'address-1' },
      messageId: 'message-1'
    });
    expect(readWorkspaceUrl(next)).toEqual({
      section: 'sent', managementView: 'settings', managementDomainId: null, query: 'invoice', filter: 'starred', identityFilter: { kind: 'address', id: 'address-1' }, messageId: 'message-1'
    });
    expect(readWorkspaceUrl(new URL('https://flaremail.example/?folder=trash&q=invoice&filter=starred&identity=address:address-1')))
      .toEqual({ section: 'trash', managementView: 'settings', managementDomainId: null, query: '', filter: 'all', identityFilter: null, messageId: null });
  });

  test('keeps domain and address management deep links separate from mailbox folders', () => {
    const domainUrl = updateWorkspaceUrl(new URL('https://flaremail.example/?folder=inbox'), {
      section: 'profile', managementView: 'domains', query: '', filter: 'all', identityFilter: null, messageId: null
    });
    expect(readWorkspaceUrl(domainUrl).managementView).toBe('domains');
    expect(domainUrl.searchParams.get('view')).toBe('domains');
    const inboxUrl = updateWorkspaceUrl(domainUrl, { section: 'inbox' });
    expect(inboxUrl.searchParams.has('view')).toBe(false);
    expect(readWorkspaceUrl(new URL('https://flaremail.example/?folder=settings&view=unknown')).managementView).toBe('settings');
    const addressUrl = updateWorkspaceUrl(domainUrl, { section: 'profile', managementView: 'addresses', managementDomainId: 'domain-1' });
    expect(readWorkspaceUrl(addressUrl).managementDomainId).toBe('domain-1');
    expect(readWorkspaceUrl(new URL('https://flaremail.example/?folder=settings&view=addresses&domain=%3Cbad%3E')).managementDomainId).toBeNull();
  });
});
