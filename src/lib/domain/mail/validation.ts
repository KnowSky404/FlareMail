import type { ComposeInput, UserProfile } from './types';
import { utf8ByteLength } from '$lib/domain/utf8';
import {
  dedupeAddresses,
  inspectAddressList,
  isValidMailboxEmail,
  MAX_RECIPIENTS,
  normalizeMailboxEmail,
  type MailAddress,
  type MailAddressInput
} from './addresses';

export const MAIL_LIMITS = Object.freeze({
  email: 254,
  to: 4_096,
  subject: 998,
  // Keep compose parsing, JSON serialization and provider payloads well below
  // the 128 MiB Worker isolate ceiling. Inbound MIME has a separate limit.
  body: 8 * 1024 * 1024,
  cc: 4_096,
  bcc: 4_096,
  recipients: MAX_RECIPIENTS,
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
  return normalizeMailboxEmail(value);
}

/** Deliberately conservative address validation for a single mailbox address. */
export function isValidEmail(value: string): boolean {
  return isValidMailboxEmail(value);
}

export function validateEmail(value: string, field = 'email'): ValidationResult<string> {
  const normalized = normalizeEmail(value);
  const issues: ValidationIssue[] = [];
  if (!normalized) issues.push({ field, message: '邮箱不能为空。' });
  else if (!isValidEmail(value)) issues.push({ field, message: '请输入有效的邮箱地址。' });
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

function boundedBody(value: string): [string, ValidationIssue[]] {
  const normalized = value.trim();
  const issues: ValidationIssue[] = [];
  if (!normalized) issues.push({ field: 'body', message: '正文不能为空。' });
  const bytes = utf8ByteLength(normalized);
  if (bytes > MAIL_LIMITS.body) issues.push({ field: 'body', message: `正文不能超过 ${MAIL_LIMITS.body} 个 UTF-8 字节。` });
  return [normalized, issues];
}

function validateMailInput(input: ComposeInput, requireSendFields: boolean): ValidationResult<ComposeInput> {
  const [subject, subjectIssues] = bounded(input.subject, MAIL_LIMITS.subject, 'subject', '主题', requireSendFields);
  const [body, bodyIssues] = boundedBody(input.body);
  if (!requireSendFields && !body) bodyIssues.length = 0;
  const issues = [...subjectIssues, ...bodyIssues];
  const parsed: Record<'to' | 'cc' | 'bcc', MailAddress[]> = { to: [], cc: [], bcc: [] };
  const sources: Array<['to' | 'cc' | 'bcc', string | MailAddressInput[] | undefined, number]> = [
    ['to', input.to ?? input.toEmail ?? '', MAIL_LIMITS.to],
    ['cc', input.cc, MAIL_LIMITS.cc],
    ['bcc', input.bcc, MAIL_LIMITS.bcc]
  ];
  for (const [field, value, max] of sources) {
    if (typeof value === 'string' && value.trim().length > max) {
      issues.push({ field, message: `${field === 'to' ? '收件人' : field === 'cc' ? '抄送' : '密送'}不能超过 ${max} 个字符。` });
    }
    for (const entry of inspectAddressList(value)) {
      if (!entry.address) {
        const token = typeof entry.input === 'string'
          ? entry.input
          : typeof entry.input === 'object' && entry.input !== null && typeof (entry.input as Record<string, unknown>).email === 'string'
            ? String((entry.input as Record<string, unknown>).email)
            : '格式无效';
        issues.push({ field, message: `${field === 'to' ? '收件人' : field === 'cc' ? '抄送' : '密送'}地址无效：${token}` });
      } else {
        parsed[field].push(entry.address);
      }
    }
    parsed[field] = dedupeAddresses(parsed[field]);
  }
  const used = new Set<string>();
  for (const field of ['to', 'cc', 'bcc'] as const) {
    parsed[field] = parsed[field].filter((address) => {
      if (used.has(address.email)) return false;
      used.add(address.email);
      return true;
    });
  }
  const all = [...parsed.to, ...parsed.cc, ...parsed.bcc];
  if (all.length > MAIL_LIMITS.recipients) issues.push({ field: 'recipients', message: `收件人总数不能超过 ${MAIL_LIMITS.recipients} 个。` });
  if (requireSendFields && parsed.to.length === 0) issues.push({ field: 'to', message: '至少需要一个收件人。' });
  return result({ ...input, to: parsed.to, cc: parsed.cc, bcc: parsed.bcc, toEmail: parsed.to[0]?.email ?? '', subject, body }, issues);
}

export function validateComposeInput(input: ComposeInput): ValidationResult<ComposeInput> {
  return validateMailInput(input, true);
}

/** Drafts may be incomplete, but every supplied field must still be safe and bounded. */
export function validateDraftInput(input: ComposeInput): ValidationResult<ComposeInput> {
  return validateMailInput(input, false);
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
