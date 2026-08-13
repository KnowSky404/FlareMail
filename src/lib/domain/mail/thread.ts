import type { MailFolder, MailMessage, MailThread, MailboxState } from './types';

const MESSAGE_ID_RE = /^[^\s<>@]+@[^\s<>@]+$/;

const normalizeEmail = (value: string) => value.trim().toLowerCase();

/** Return a safe, comparable Message-ID without changing its semantic value. */
export function normalizeMessageId(value: string): string | null {
  const trimmed = value.trim().replace(/^<|>$/g, '').trim();
  if (!trimmed || /[\u0000-\u001f\u007f\s<>]/.test(trimmed) || !MESSAGE_ID_RE.test(trimmed)) {
    return null;
  }

  return trimmed.toLowerCase();
}
/**
 * Parse one or more RFC message identifiers from an untrusted header value.
 * Invalid tokens are ignored so a malformed header cannot collapse unrelated
 * messages into one thread.
 */
export function parseMessageIds(value: string | null | undefined): string[] {
  if (!value) return [];

  const bracketed = [...value.matchAll(/<([^<>\s]+)>/g)].map((match) => match[1]);
  const tokens = bracketed.length ? bracketed : value.split(/[\s,]+/);
  const seen = new Set<string>();

  return tokens.reduce<string[]>((ids, token) => {
    const normalized = normalizeMessageId(token);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      ids.push(normalized);
    }
    return ids;
  }, []);
}

export function normalizeThreadSubject(value: string): string {
  return (
    value
      .trim()
      .replace(/^(?:(?:re|fwd?)\s*:\s*)+/gi, '')
      .replace(/\s+/g, ' ')
      .toLowerCase() || '(no subject)'
  );
}

function getCounterpartyEmail(message: MailMessage): string {
  return message.folder === 'inbox' ? message.fromEmail : message.toEmail;
}

function getCounterpartyLabel(message: MailMessage): string {
  return message.folder === 'inbox'
    ? `${message.fromName} <${message.fromEmail}>`
    : `${message.toName} <${message.toEmail}>`;
}

function getRfcIds(message: MailMessage): string[] {
  return [
    ...parseMessageIds(message.messageId),
    ...parseMessageIds(message.inReplyTo),
    ...parseMessageIds(message.references)
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

function getFallbackThreadKey(message: MailMessage): string {
  return `${normalizeThreadSubject(message.subject)}::${normalizeEmail(getCounterpartyEmail(message))}`;
}

/**
 * Return the stable key for a message. RFC threading metadata wins; legacy
 * subject/counterparty grouping is retained for messages without usable IDs.
 */
export function getMailThreadKey(message: MailMessage): string {
  const references = parseMessageIds(message.references);
  const inReplyTo = parseMessageIds(message.inReplyTo);
  const messageId = parseMessageIds(message.messageId);
  const rfcId = references[0] ?? inReplyTo[0] ?? messageId[0];

  return rfcId ? `rfc:${rfcId}` : getFallbackThreadKey(message);
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(value: string) {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  union(left: string, right: string) {
    this.add(left);
    this.add(right);
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;

    // Use the lexical minimum as canonical root. This makes output stable
    // regardless of mailbox ordering or webhook arrival order.
    if (leftRoot < rightRoot) this.parent.set(rightRoot, leftRoot);
    else this.parent.set(leftRoot, rightRoot);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parent.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
}

function cloneMessage(message: MailMessage): MailMessage {
  return { ...message, labels: [...message.labels] };
}

function compareNewestFirst(left: MailMessage, right: MailMessage): number {
  return right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id);
}

function compareOldestFirst(left: MailMessage, right: MailMessage): number {
  return left.sentAt.localeCompare(right.sentAt) || left.id.localeCompare(right.id);
}

/**
 * Build inbox/sent threads. RFC IDs are connected as a graph, allowing a
 * reply-to-reply chain to remain one thread even when its first parent is not
 * present in the current mailbox. Legacy messages use the old fallback key.
 */
export function buildMailThreads(
  mailbox: MailboxState,
  section: Exclude<MailFolder, 'drafts'>
): MailThread[] {
  const allMessages = [...mailbox.inbox, ...mailbox.sent].map(cloneMessage).sort(compareNewestFirst);
  const rfc = new DisjointSet();
  const messageIds = new Map<string, string[]>();

  for (const message of allMessages) {
    const ids = getRfcIds(message);
    messageIds.set(message.id, ids);
    if (ids.length) {
      ids.forEach((id) => rfc.add(id));
      ids.slice(1).forEach((id) => rfc.union(ids[0], id));
    }
  }

  const grouped = new Map<string, MailMessage[]>();
  for (const message of allMessages) {
    const ids = messageIds.get(message.id) ?? [];
    const key = ids.length ? `rfc:${rfc.find(ids[0])}` : getFallbackThreadKey(message);
    const messages = grouped.get(key);
    if (messages) messages.push(message);
    else grouped.set(key, [message]);
  }

  return [...grouped.entries()]
    .map(([id, messages]) => {
      const sectionMessages = messages.filter((message) => message.folder === section);
      if (!sectionMessages.length) return null;

      const counterparties = [
        ...messages
          .reduce((accumulator, message) => {
            accumulator.set(normalizeEmail(getCounterpartyEmail(message)), getCounterpartyLabel(message));
            return accumulator;
          }, new Map<string, string>())
          .values()
      ];
      const latestMessage = messages[0];
      const oldestFirst = [...messages].sort(compareOldestFirst);

      return {
        id,
        subject: latestMessage.subject,
        counterpartLabel:
          counterparties.length === 1
            ? counterparties[0]
            : `${counterparties[0]} 等 ${counterparties.length} 位联系人`,
        latestMessage,
        sectionLatestMessage: sectionMessages[0],
        messages: oldestFirst,
        messageCount: messages.length,
        sectionMessageCount: sectionMessages.length,
        unreadCount: messages.filter((message) => message.folder === 'inbox' && !message.read).length,
        preview: latestMessage.preview,
        sentAt: latestMessage.sentAt
      } satisfies MailThread;
    })
    .filter((thread): thread is MailThread => Boolean(thread))
    .sort((left, right) => right.sentAt.localeCompare(left.sentAt) || right.id.localeCompare(left.id));
}
