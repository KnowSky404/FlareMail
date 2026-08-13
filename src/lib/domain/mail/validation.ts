import type { ComposeInput, UserProfile } from './types';

export const MAIL_LIMITS = Object.freeze({
  email: 254,
  subject: 998,
  body: 1_048_576,
  cc: 4_096,
  name: 200,
  role: 120,
  company: 200,
  location: 200,
  timezone: 100,
  signature: 10_000,
  filename: 255,
  contentDisposition: 512
});

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value: T;
  issues: ValidationIssue[];
}

const result = <T>(value: T, issues: ValidationIssue[]): ValidationResult<T> => ({
  ok: issues.length === 0,
  value,
  issues
});

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** Deliberately conservative address validation for a single mailbox address. */
export function isValidEmail(value: string): boolean {
  const normalized = normalizeEmail(value);
  if (normalized.length > MAIL_LIMITS.email || /[\r\n\0]/.test(normalized)) return false;
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at !== normalized.indexOf('@') || at === normalized.length - 1) return false;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return false;
  if (domain.length > 253 || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length > 1 && labels[labels.length - 1].length >= 2 && labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

export function validateEmail(value: string, field = 'email'): ValidationResult<string> {
  const normalized = normalizeEmail(value);
  const issues: ValidationIssue[] = [];
  if (!normalized) issues.push({ field, message: '邮箱不能为空。' });
  else if (!isValidEmail(normalized)) issues.push({ field, message: '请输入有效的邮箱地址。' });
  return result(normalized, issues);
}

function bounded(value: string, max: number, field: string, label: string, required = false): [string, ValidationIssue[]] {
  const normalized = value.trim();
  const issues: ValidationIssue[] = [];
  if (required && !normalized) issues.push({ field, message: `${label}不能为空。` });
  if (normalized.length > max) issues.push({ field, message: `${label}不能超过 ${max} 个字符。` });
  if (/[\u0000\r\n]/.test(normalized) && (field === 'email' || field === 'subject')) {
    issues.push({ field, message: `${label}包含非法控制字符。` });
  }
  return [normalized, issues];
}

export function validateComposeInput(input: ComposeInput): ValidationResult<ComposeInput> {
  const [subject, subjectIssues] = bounded(input.subject, MAIL_LIMITS.subject, 'subject', '主题', true);
  const [body, bodyIssues] = bounded(input.body, MAIL_LIMITS.body, 'body', '正文', true);
  const [cc, ccIssues] = bounded(input.cc ?? '', MAIL_LIMITS.cc, 'cc', '抄送');
  const to = validateEmail(input.toEmail, 'toEmail');
  const issues = [...to.issues, ...subjectIssues, ...bodyIssues, ...ccIssues];
  const ccAddresses = cc
    .split(/[;,\s]+/)
    .map((address) => address.trim())
    .filter(Boolean);
  for (const address of ccAddresses) {
    if (!isValidEmail(address)) issues.push({ field: 'cc', message: `抄送地址无效：${address}` });
  }

  return result({ ...input, toEmail: to.value, cc, subject, body }, issues);
}

export function validateProfile(profile: UserProfile): ValidationResult<UserProfile> {
  const fields: Array<[keyof UserProfile, string, number]> = [
    ['name', profile.name, MAIL_LIMITS.name],
    ['role', profile.role, MAIL_LIMITS.role],
    ['company', profile.company, MAIL_LIMITS.company],
    ['location', profile.location, MAIL_LIMITS.location],
    ['timezone', profile.timezone, MAIL_LIMITS.timezone],
    ['signature', profile.signature, MAIL_LIMITS.signature]
  ];
  const issues: ValidationIssue[] = [];
  const value = { ...profile };
  for (const [field, raw, max] of fields) {
    const [normalized, fieldIssues] = bounded(raw, max, field, String(field), field === 'name');
    value[field] = normalized as never;
    issues.push(...fieldIssues);
  }
  const email = validateEmail(profile.email);
  value.email = email.value;
  issues.push(...email.issues);
  return result(value, issues);
}

/** Remove path components, controls and dangerous whitespace from an attachment name. */
export function sanitizeFilename(value: string, fallback = 'attachment'): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[\\/]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/^[._]+/, '')
    .trim()
    .slice(0, MAIL_LIMITS.filename);
  return cleaned || fallback;
}

function quoteHeaderFilename(filename: string): string {
  return filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Generate a safe attachment disposition value; never trust a raw header. */
export function sanitizeContentDisposition(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const safeDisposition = disposition === 'inline' ? 'inline' : 'attachment';
  const safeFilename = sanitizeFilename(filename);
  const ascii = safeFilename.replace(/[^\x20-\x7e]/g, '_');
  const value = `${safeDisposition}; filename="${quoteHeaderFilename(ascii)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
  return value.slice(0, MAIL_LIMITS.contentDisposition);
}

export const buildContentDisposition = sanitizeContentDisposition;
export const sanitizeAttachmentFilename = sanitizeFilename;
export const validateProfileInput = validateProfile;
