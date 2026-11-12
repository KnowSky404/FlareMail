import type { MailInboxCategory } from './categories';

/** Bump whenever the prompt, input projection or result contract changes. */
export const MAIL_AI_VERSION = 2;

export interface MailAiInput {
  subject: string;
  sender: string;
  body: string;
  language: string;
  truncated: boolean;
}

export interface MailAiAnalysis {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  /** Verbatim excerpts, never inferred or normalized dates. */
  dates: string[];
  language: string;
  suggestion: { category: MailInboxCategory; confidence: number; reason: string } | null;
}

export interface MailAiResponse {
  status: 'disabled' | 'unconfigured' | 'empty' | 'processing' | 'ready';
  analysis: MailAiAnalysis | null;
  truncated?: boolean;
  updatedAt?: number;
  language?: string;
}

export const mailAiApiFormats = ['chat-completions', 'responses'] as const;
export type MailAiApiFormat = typeof mailAiApiFormats[number];

export interface MailAiSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiFormat: MailAiApiFormat;
  timeoutMs: number;
  maxInputChars: number;
  summaryLanguage: string;
  backgroundLanguage: 'zh-CN' | 'en';
}

export interface MailAiSettingsView {
  settings: MailAiSettings;
  hasApiKey: boolean;
  canSave: boolean;
  revision: string;
  source: 'server' | 'workspace';
}

/** A language code, never a free-form instruction to the model. */
export function parseMailAiLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 64 || value === 'auto' || !/^[a-z0-9-]+$/iu.test(value)) return null;
  try {
    const language = Intl.getCanonicalLocales(value)[0];
    return language && language !== 'auto' && language.length <= 64 ? language : null;
  } catch { return null; }
}
