import type { UserProfile } from '$lib/domain/mail';

/** Refresh untouched fields from the server without discarding local edits. */
export function mergeProfileDraft(previous: UserProfile, incoming: UserProfile, draft: UserProfile): UserProfile {
  return {
    name: draft.name === previous.name ? incoming.name : draft.name,
    role: draft.role === previous.role ? incoming.role : draft.role,
    email: draft.email === previous.email ? incoming.email : draft.email,
    company: draft.company === previous.company ? incoming.company : draft.company,
    location: draft.location === previous.location ? incoming.location : draft.location,
    timezone: draft.timezone === previous.timezone ? incoming.timezone : draft.timezone,
    forwardingEnabled: draft.forwardingEnabled === previous.forwardingEnabled
      ? incoming.forwardingEnabled : draft.forwardingEnabled,
    signature: draft.signature === previous.signature ? incoming.signature : draft.signature
  };
}
