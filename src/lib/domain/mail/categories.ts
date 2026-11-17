/** Inbox categories are organizational hints, never authentication or spam decisions. */
export const mailInboxCategories = ['primary', 'transactions', 'security', 'updates', 'subscriptions', 'promotions'] as const;
export type MailInboxCategory = typeof mailInboxCategories[number];
export type InboxCategoryFilter = MailInboxCategory | 'all';

export function isMailInboxCategory(value: unknown): value is MailInboxCategory {
  return typeof value === 'string' && (mailInboxCategories as readonly string[]).includes(value);
}

export function isInboxCategoryFilter(value: unknown): value is InboxCategoryFilter {
  return value === 'all' || isMailInboxCategory(value);
}

/** Ordered, conservative metadata-only rules shared by SQL queries and detail mapping. */
export const inboxCategoryRules: ReadonlyArray<{
  category: Exclude<MailInboxCategory, 'primary'>;
  senderDomains?: readonly string[];
  senderPrefixes?: readonly string[];
  subjectPhrases?: readonly string[];
}> = [
  { category: 'security', subjectPhrases: ['verification code', 'one time password', 'password reset', 'security alert', 'sign-in', '验证码', '密码重置', '重置密码', '安全提醒', '登录提醒'] },
  { category: 'transactions', subjectPhrases: ['invoice', 'receipt', 'order confirmation', 'refund', 'shipment', 'delivery notification', '账单', '发票', '收据', '订单', '退款', '物流', '发货'] },
  { category: 'promotions', subjectPhrases: ['special offer', 'limited time offer', 'flash sale', 'discount', 'coupon', '促销', '优惠', '折扣'] },
  { category: 'subscriptions', senderPrefixes: ['newsletter@', 'newsletters@'], subjectPhrases: ['newsletter', 'weekly digest', '周报', '新闻简报'] },
  { category: 'security', senderPrefixes: ['security@'] },
  { category: 'transactions', senderPrefixes: ['billing@', 'receipts@'] },
  { category: 'promotions', senderPrefixes: ['offers@', 'promotions@', 'marketing@'] },
  {
    category: 'updates',
    senderDomains: ['groups.google.com', 'groups.io', 'facebookmail.com', 'linkedin.com', 'twitter.com', 'x.com', 'instagram.com', 'pinterest.com', 'redditmail.com'],
    senderPrefixes: ['noreply@', 'no-reply@', 'notifications@', 'notification@', 'forum@', 'forums@', 'discourse@', 'groups-noreply@'],
    subjectPhrases: ['[forum]', '[discourse]', '回复了话题', '论坛回复']
  }
];

/** Preserve links and clients using the two retired category IDs. */
export function normalizeInboxCategory(value: unknown): unknown {
  return value === 'social' || value === 'forums' ? 'updates' : value;
}

// SQLite lower() folds ASCII only. Use the same transformation for exact parity.
const lowerAscii = (value: string) => value.replace(/[A-Z]/gu, (character) => character.toLowerCase());

export function categorySenderAddress(from: string): string {
  const start = from.indexOf('<');
  const end = from.indexOf('>');
  const address = start >= 0 && end > start ? from.slice(start + 1, end) : from;
  return lowerAscii(address.replace(/^ +| +$/gu, ''));
}

export function classifyInboxCategory(from: string, subject: string): MailInboxCategory {
  const sender = categorySenderAddress(from);
  const normalizedSubject = lowerAscii(subject);
  for (const rule of inboxCategoryRules) {
    if (rule.senderDomains?.some((domain) => sender.endsWith(`@${domain}`) || sender.endsWith(`.${domain}`)) ||
      rule.senderPrefixes?.some((prefix) => sender.startsWith(prefix)) ||
      rule.subjectPhrases?.some((phrase) => /^[a-z]/u.test(phrase)
        ? new RegExp(`(^|[^a-z0-9])${phrase}($|[^a-z0-9])`, 'u').test(normalizedSubject)
        : normalizedSubject.includes(phrase))) return rule.category;
  }
  return 'primary';
}

export function resolveInboxCategory(from: string, subject: string, override?: MailInboxCategory | null, automatic?: MailInboxCategory | null): MailInboxCategory {
  return isMailInboxCategory(override) ? override : isMailInboxCategory(automatic) ? automatic : classifyInboxCategory(from, subject);
}
