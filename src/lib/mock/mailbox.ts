/**
 * Development-only mailbox fixtures.
 *
 * Production contracts live in `$lib/domain/mail`; runtime code must never
 * import this module. The re-export keeps older fixture consumers compatible
 * while the remaining UI and service layers are migrated in stages.
 */
import type { MailboxState, UserProfile } from '$lib/domain/mail';

export * from '$lib/domain/mail';

export const demoCredentials = {
  email: 'founder@flaremail.dev',
  password: 'flaremail-demo'
} as const;

export const mockProfile: UserProfile = {
  name: 'FlareMail User',
  role: 'Workspace Owner',
  email: demoCredentials.email,
  company: 'FlareMail',
  location: '',
  timezone: 'Asia/Shanghai',
  forwardingEnabled: false,
  signature: ''
};

export const mockMailbox: MailboxState = {
  inbox: [],
  sent: [],
  drafts: []
};
