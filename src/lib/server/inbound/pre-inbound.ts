import { normalizeManagedAddress } from '../mail-identities/validation.ts';

type PreInboundVars = {
  PRE_INBOUND_RECIPIENT?: string;
  PRE_INBOUND_ENABLED?: string;
};

export const PRE_INBOUND_BINDING_NAMES = ['PRE_INBOUND_SETTINGS', 'PRE_INBOUND_DB', 'PRE_INBOUND_BUCKET'];

export function readPreInboundConfig(vars: PreInboundVars, hasDatabase: boolean, hasBucket: boolean, hasRouting = false) {
  const { PRE_INBOUND_RECIPIENT: recipient, PRE_INBOUND_ENABLED: enabled } = vars;
  if (recipient === undefined && enabled === undefined && !hasDatabase && !hasBucket && !hasRouting) return null;
  if ((recipient === undefined && !hasRouting) || (enabled !== 'true' && enabled !== 'false') || !hasDatabase || !hasBucket) {
    throw new Error('PRE_INBOUND_CONFIGURATION_INVALID');
  }
  return { recipient: recipient === undefined ? null : normalizePreInboundRecipient(recipient), enabled: enabled === 'true' };
}

export function readPreInboundBindings(settings: unknown, hasDatabase: boolean, hasBucket: boolean, hasRouting = false) {
  // An inherited text or key secret cannot declare this JSON binding.
  const absentOrSecret = settings === undefined || typeof settings === 'string' || settings instanceof CryptoKey;
  if (absentOrSecret && !hasDatabase && !hasBucket && !hasRouting) return null;
  if (absentOrSecret || !settings || typeof settings !== 'object' || Array.isArray(settings) || 'previewApp' in settings ||
      !('recipient' in settings) || (typeof settings.recipient !== 'string' && !(hasRouting && settings.recipient === null)) ||
      !('enabled' in settings) || typeof settings.enabled !== 'boolean' || !hasDatabase || !hasBucket) {
    throw new Error('PRE_INBOUND_CONFIGURATION_INVALID');
  }
  return { recipient: settings.recipient === null ? null : normalizePreInboundRecipient(settings.recipient), enabled: settings.enabled };
}

export function normalizePreInboundRecipient(input: string) {
  const candidate = input.trim().toLowerCase();
  const parts = candidate.split('@');
  if (parts.length === 2 && parts[1]) {
    try {
      const { email, localPart } = normalizeManagedAddress(candidate, parts[1]);
      if (email === candidate && !localPart.includes('+')) return email;
    } catch {
      // Configuration errors must not disclose the private recipient.
    }
  }
  throw new Error('PRE_INBOUND_RECIPIENT_INVALID');
}

export function resolvePreInboundMatch(reserved: string, envelopeRecipient: string): 'exact' | 'subaddress' | null {
  const recipient = envelopeRecipient.trim().toLowerCase();
  if (recipient === reserved) return 'exact';
  const [localPart, domain] = reserved.split('@');
  return recipient.startsWith(`${localPart}+`) && recipient.endsWith(`@${domain}`) &&
    recipient.indexOf('@') === recipient.lastIndexOf('@') ? 'subaddress' : null;
}
