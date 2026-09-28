import { isValidMailboxEmail, normalizeMailboxEmail, parseAddressList, type MailAddress, type MailMessage } from '$lib/domain/mail';

/** Recent correspondents from messages already loaded into this browser session. */
export function deriveRecipientSuggestions(messages: MailMessage[], ownEmails: string[]): MailAddress[] {
  const own = new Set(ownEmails.map(normalizeMailboxEmail));
  const seen = new Set<string>();
  const suggestions: MailAddress[] = [];

  for (const message of [...messages].sort((left, right) => right.sentAt.localeCompare(left.sentAt))) {
    const candidates = message.folder === 'sent'
      ? message.toAddresses?.length ? message.toAddresses : parseAddressList(message.toEmail)
      : [{ name: message.fromName, email: message.fromEmail }];
    for (const candidate of candidates) {
      const email = normalizeMailboxEmail(candidate.email);
      if (!isValidMailboxEmail(email) || own.has(email) || seen.has(email)) continue;
      seen.add(email);
      suggestions.push({ name: candidate.name.trim(), email });
      if (suggestions.length === 100) return suggestions;
    }
  }
  return suggestions;
}

export function matchRecipientSuggestions(
  suggestions: MailAddress[],
  query: string,
  selected: MailAddress[],
  limit = 6
): MailAddress[] {
  const search = query.trim().toLowerCase();
  if (search.length < 2 || /[,;，；\r\n]/u.test(search)) return [];
  const chosen = new Set(selected.map((address) => normalizeMailboxEmail(address.email)));
  return suggestions.filter((candidate) =>
    !chosen.has(normalizeMailboxEmail(candidate.email)) &&
    (candidate.email.toLowerCase().includes(search) || candidate.name.toLowerCase().includes(search))
  ).slice(0, limit);
}
