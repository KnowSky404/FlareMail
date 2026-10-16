import type { UserProfile } from '$lib/domain/mail';
import { mergeProfileDraft } from './profile-draft';

export const settingsTabs = ['profile', 'notifications', 'diagnostics', 'telegram'] as const;
export type SettingsTab = typeof settingsTabs[number];
export type EditableSettingsTab = 'profile' | 'notifications';
export function isSettingsTab(value: string | null): value is SettingsTab { return settingsTabs.includes(value as SettingsTab); }
export function readSettingsTab(url: URL): SettingsTab {
  const value = url.searchParams.get('tab');
  if (isSettingsTab(value)) return value;
  const anchor = url.hash.replace('#settings-', '');
  return isSettingsTab(anchor) ? anchor : 'profile';
}
const profileFields = ['name', 'role', 'company', 'timezone', 'location', 'email', 'signature'] as const;
export function profileSubmission(server: UserProfile, draft: UserProfile, tab: EditableSettingsTab): UserProfile {
  if (tab === 'notifications') return { ...server, forwardingEnabled: draft.forwardingEnabled };
  const result = { ...server };
  for (const key of profileFields) result[key] = draft[key];
  return result;
}
export function acceptProfileSave(previous: UserProfile, saved: UserProfile, draft: UserProfile, tab: EditableSettingsTab): UserProfile {
  const merged = mergeProfileDraft(previous, saved, draft);
  if (tab === 'notifications') merged.forwardingEnabled = saved.forwardingEnabled;
  else for (const key of profileFields) merged[key] = saved[key];
  return merged;
}
