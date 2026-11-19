export function parseInboundRecipient(rawRecipient: string) {
  const recipient = rawRecipient.trim().toLowerCase();
  const separator = recipient.lastIndexOf('@');
  if (separator <= 0 || separator === recipient.length - 1 ||
      recipient.indexOf('@') !== separator || /\s/u.test(recipient)) return null;

  const domain = recipient.slice(separator + 1);
  const plus = recipient.slice(0, separator).indexOf('+');
  const base = plus > 0 ? `${recipient.slice(0, plus)}@${domain}` : recipient;
  return { recipient, base, domain };
}
