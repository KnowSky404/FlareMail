export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ControlSize = 'sm' | 'md' | 'lg';

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

export const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--fm-primary)] text-[var(--fm-text-inverse)] hover:bg-[var(--fm-primary-hover)]',
  secondary: 'bg-[var(--fm-surface-subtle)] text-[var(--fm-text)] hover:bg-[var(--fm-surface-hover)]',
  outline: 'border border-[var(--fm-border)] bg-transparent text-[var(--fm-text)] hover:bg-[var(--fm-surface-hover)]',
  ghost: 'bg-transparent text-[var(--fm-text-secondary)] hover:bg-[var(--fm-surface-hover)] hover:text-[var(--fm-text)]',
  danger: 'bg-[var(--fm-danger)] text-[var(--fm-text-inverse)] hover:brightness-95',
  link: 'bg-transparent text-[var(--fm-primary)] underline-offset-4 hover:underline'
};

export const buttonSizes: Record<ControlSize, string> = {
  sm: 'min-h-11 min-w-11 px-2.5 text-xs sm:min-h-8 sm:min-w-0',
  md: 'min-h-11 min-w-11 px-3.5 text-sm sm:min-h-9 sm:min-w-0',
  lg: 'min-h-11 min-w-11 px-4 text-sm sm:min-h-10 sm:min-w-0'
};

export const controlBase =
  'rounded-[var(--radius-md)] border border-[var(--fm-border)] bg-[var(--fm-surface)] text-[var(--fm-text)] outline-none transition-colors placeholder:text-[var(--fm-text-muted)] focus-visible:border-[var(--fm-focus)] focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/25 disabled:cursor-not-allowed disabled:opacity-50';

export const focusRing =
  'outline-none focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/35 focus-visible:ring-offset-1';

export function buttonClass(variant: ButtonVariant = 'primary', size: ControlSize = 'md', className = '') {
  return cn(
    'inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] font-medium transition-colors',
    'outline-none focus-visible:ring-2 focus-visible:ring-[var(--fm-focus)]/40 focus-visible:ring-offset-1',
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
    buttonVariants[variant],
    buttonSizes[size],
    className
  );
}

export function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (['delivered', 'sent', 'success', 'active', 'healthy', '已送达', '已发送', '正常'].some((token) => normalized.includes(token))) {
    return 'success';
  }
  if (['failed', 'bounced', 'error', 'danger', 'suppressed', '失败', '退信'].some((token) => normalized.includes(token))) {
    return 'danger';
  }
  if (['pending', 'queued', 'delayed', 'warning', 'processing', '排队', '处理中', '延迟'].some((token) => normalized.includes(token))) {
    return 'warning';
  }
  return 'neutral';
}

export const statusClasses = {
  success: {
    badge: 'border-[color-mix(in_srgb,var(--fm-success)_35%,var(--fm-surface))] bg-[var(--fm-success-soft)] text-[var(--fm-success)]',
    dot: 'bg-[var(--fm-success)]'
  },
  danger: {
    badge: 'border-[color-mix(in_srgb,var(--fm-danger)_35%,var(--fm-surface))] bg-[var(--fm-danger-soft)] text-[var(--fm-danger)]',
    dot: 'bg-[var(--fm-danger)]'
  },
  warning: {
    badge: 'border-[color-mix(in_srgb,var(--fm-warning)_35%,var(--fm-surface))] bg-[var(--fm-warning-soft)] text-[var(--fm-warning)]',
    dot: 'bg-[var(--fm-warning)]'
  },
  neutral: {
    badge: 'border-[var(--fm-border)] bg-[var(--fm-surface-subtle)] text-[var(--fm-text-secondary)]',
    dot: 'bg-[var(--fm-text-muted)]'
  }
} as const;

export type StatusTone = keyof typeof statusClasses;
