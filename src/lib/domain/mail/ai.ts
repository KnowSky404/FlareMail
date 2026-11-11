import type { MailInboxCategory } from './categories';

/** Bump whenever the prompt, input projection or result contract changes. */
export const MAIL_AI_VERSION = 1;

export interface MailAiInput {
  subject: string;
  sender: string;
  body: string;
  language: 'zh-CN' | 'en';
  truncated: boolean;
}

export interface MailAiAnalysis {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  /** Verbatim excerpts, never inferred or normalized dates. */
  dates: string[];
  language: 'zh-CN' | 'en';
  suggestion: { category: MailInboxCategory; confidence: number; reason: string } | null;
}

export interface MailAiResponse {
  status: 'disabled' | 'unconfigured' | 'empty' | 'processing' | 'ready';
  analysis: MailAiAnalysis | null;
  truncated?: boolean;
  updatedAt?: number;
}
