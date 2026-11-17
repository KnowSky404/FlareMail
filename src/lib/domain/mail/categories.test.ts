import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { classifyInboxCategory, isInboxCategoryFilter, resolveInboxCategory } from './categories';
import { inboxCategorySql } from '$lib/server/db/inbox-categories';

describe('metadata-only inbox categories', () => {
  const cases = [
    ['Ada <ada@example.test>', 'Lunch tomorrow?', 'primary'],
    ['newsletter@example.test', 'Weekly digest', 'subscriptions'],
    ['offers@example.test', 'Verification code and coupon', 'security'],
    ['noreply@example.test', 'Order confirmation and discount', 'transactions'],
    ['notice@linkedin.com', 'Invoice for subscription', 'transactions'],
    ['Facebook <notice@facebookmail.com>', 'New activity', 'updates'],
    ['NEWS@MAIL.LINKEDIN.COM', 'New connection', 'updates'],
    ['linkedin.com <ada@example.test>', 'Personal note', 'primary'],
    ['notice@linkedin.com.attacker.test', 'Personal note', 'primary'],
    ['offers@example.test', 'Latest news', 'promotions'],
    ['sales@example.test', 'A special offer!', 'promotions'],
    ['ada@example.test', 'Discounting a hypothesis', 'primary'],
    ['ada@example.test', 'Receiptions', 'primary'],
    ['noreply@example.test', 'New receipt', 'transactions'],
    ['Ada <ada@example.test>', 'Invoice #123', 'transactions'],
    ['ada@example.test', '您的验证码', 'security'],
    ['ada@example.test', '会员专享优惠', 'promotions'],
    ['forum@example.test', 'A topic reply', 'updates'],
    ['topic@groups.google.com', 'New discussion', 'updates'],
    ['no-reply@example.test', '[forum] Special offer discussion', 'promotions']
  ] as const;

  test('uses conservative sender and subject rules with boundary checks', () => {
    for (const [sender, subject, category] of cases) {
      expect(classifyInboxCategory(sender, subject)).toBe(category);
    }
    expect(resolveInboxCategory('offers@example.test', 'Sale', 'primary')).toBe('primary');
    expect(resolveInboxCategory('offers@example.test', 'Sale', null)).toBe('promotions');
    expect(isInboxCategoryFilter('all')).toBe(true);
    expect(isInboxCategoryFilter('spam')).toBe(false);
  });

  test('SQL classification is identical to detail mapping, including manual overrides', () => {
    const db = new Database(':memory:');
    try {
      const expression = inboxCategorySql('sender', 'subject', 'override', 'automatic');
      const statement = db.query(`SELECT ${expression} AS category FROM (SELECT ? AS sender, ? AS subject, ? AS override, ? AS automatic)`);
      for (const [sender, subject, category] of cases) {
        expect(statement.get(sender, subject, null, null)).toEqual({ category });
        expect(statement.get(sender, subject, null, 'transactions')).toEqual({ category: 'transactions' });
        expect(resolveInboxCategory(sender, subject, null, 'transactions')).toBe('transactions');
        expect(statement.get(sender, subject, 'primary', 'security')).toEqual({ category: 'primary' });
      }
    } finally {
      db.close();
    }
  });
});
