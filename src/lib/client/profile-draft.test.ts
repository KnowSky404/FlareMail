import { describe, expect, test } from 'bun:test';
import type { UserProfile } from '$lib/domain/mail';
import { mergeProfileDraft } from './profile-draft';

const baseline: UserProfile = {
  name: 'FlareMail Owner', role: 'Owner', email: 'owner@example.test', company: 'Old Company',
  location: 'Berlin', timezone: 'Europe/Berlin', forwardingEnabled: false, signature: 'Old signature'
};

describe('mergeProfileDraft', () => {
  test('keeps edited fields and incorporates remote changes to untouched fields', () => {
    const incoming = { ...baseline, role: 'Administrator', company: 'New Company', forwardingEnabled: true };
    const draft = { ...baseline, name: 'Unsaved name', signature: 'Unsaved signature' };

    expect(mergeProfileDraft(baseline, incoming, draft)).toEqual({
      ...incoming, name: 'Unsaved name', signature: 'Unsaved signature'
    });
  });

  test('does not mutate the incoming profile or the local draft', () => {
    const incoming = { ...baseline, location: 'Paris' };
    const draft = { ...baseline, company: 'Local Company' };
    expect(mergeProfileDraft(baseline, incoming, draft)).toEqual({ ...incoming, company: 'Local Company' });
    expect(incoming.location).toBe('Paris');
    expect(draft.company).toBe('Local Company');
  });
});
