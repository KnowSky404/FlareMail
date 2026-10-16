import { describe, expect, test } from 'bun:test';
import { cloneProfile } from '$lib/domain/mail';
import { acceptProfileSave, profileSubmission, readSettingsTab } from './settings-tabs';
import { readWorkspaceUrl, updateWorkspaceUrl } from './workspace-url-controller';

describe('settings tabs', () => {
  test('saves only the active tab, including when the other tab contains invalid input', () => {
    const server = { ...cloneProfile(), name: 'Server', email: 'owner@example.test', forwardingEnabled: false };
    const draft = { ...server, name: '', email: 'invalid', forwardingEnabled: true };
    expect(profileSubmission(server, draft, 'notifications')).toEqual({ ...server, forwardingEnabled: true });
    expect(profileSubmission(server, draft, 'profile')).toEqual({ ...draft, forwardingEnabled: false });
  });
  test('accepts normalization without wiping the other tab draft in either save direction', () => {
    const server = { ...cloneProfile(), name: 'Server', forwardingEnabled: false };
    const draft = { ...server, name: '  Edited  ', forwardingEnabled: true };
    expect(acceptProfileSave(server, { ...server, name: 'Edited' }, draft, 'profile')).toMatchObject({ name: 'Edited', forwardingEnabled: true });
    expect(acceptProfileSave(server, { ...server, forwardingEnabled: true }, draft, 'notifications')).toMatchObject({ name: '  Edited  ', forwardingEnabled: true });
  });
  test('round trips tabs, reads old anchors and removes tabs when leaving settings', () => {
    const old = new URL('https://flaremail.test/?folder=settings#settings-telegram');
    expect(readSettingsTab(old)).toBe('telegram');
    const normalized = updateWorkspaceUrl(old, { settingsTab: 'telegram' });
    expect(normalized.hash).toBe('');
    expect(readWorkspaceUrl(normalized).settingsTab).toBe('telegram');
    expect(updateWorkspaceUrl(normalized, { section: 'inbox' }).searchParams.has('tab')).toBe(false);
    expect(updateWorkspaceUrl(normalized, { managementView: 'domains' }).searchParams.has('tab')).toBe(false);
    expect(readSettingsTab(new URL('https://flaremail.test/?tab=notifications#settings-telegram'))).toBe('notifications');
    expect(readSettingsTab(new URL('https://flaremail.test/?tab=invalid'))).toBe('profile');
  });
  test('falls back to profile for removed appearance links and normalizes the URL', () => {
    for (const suffix of ['&tab=appearance', '#settings-appearance']) {
      const old = new URL(`https://flaremail.test/?folder=settings${suffix}`);
      const state = readWorkspaceUrl(old);
      expect(state.settingsTab).toBe('profile');
      const normalized = updateWorkspaceUrl(old, { settingsTab: state.settingsTab });
      expect(normalized.searchParams.has('tab')).toBe(false);
      expect(normalized.hash).toBe('');
    }
  });
});
