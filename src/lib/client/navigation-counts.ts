import type { MailboxIdentityFilter, WorkspaceMetrics } from '$lib/domain/mail';
import { formatNumber, translateCount, type Locale } from '$lib/i18n';

export type AttentionSection = 'inbox' | 'drafts' | 'sent';
export type NavigationCounts = Record<AttentionSection, number | null>;

/** Counts describe work needing attention, independently of the loaded list. */
export function navigationCounts(
  metrics: WorkspaceMetrics,
  metricsIdentity: MailboxIdentityFilter | null,
  currentIdentity: MailboxIdentityFilter | null
): NavigationCounts {
  if (metricsIdentity?.kind !== currentIdentity?.kind || metricsIdentity?.id !== currentIdentity?.id) {
    return { inbox: null, drafts: null, sent: null };
  }
  return {
    inbox: metrics.unreadCount,
    drafts: metrics.draftsCount,
    // Stale submitting is already part of queuedCount; never count it twice.
    sent: metrics.queuedCount + metrics.delayedCount + metrics.failedCount + metrics.bouncedCount + metrics.complainedCount
  };
}

export function formatNavigationCount(locale: Locale, count: number) {
  return count > 99 ? '99+' : formatNumber(count, locale);
}

export function describeNavigationCount(locale: Locale, section: AttentionSection, count: number) {
  return translateCount(locale, section === 'inbox' ? 'mail.unreadCount'
    : section === 'sent' ? 'mail.sendAttentionCount' : 'mail.messageCount', count);
}
