export type MailFolder = 'inbox' | 'sent' | 'drafts';
export type MailSource = 'workspace' | 'inbound';
export type DeliveryStatus = 'queued' | 'sent' | 'failed';
export type ComposeMode = 'new' | 'draft' | 'reply' | 'forward';

export const inboundMessagePrefix = 'email:';

export interface MailAttachmentSummary {
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
}

export interface InboundMessageDetail {
  body: string;
  attachments: MailAttachmentSummary[];
  rawSize: number;
}

export const isInboundMessageId = (value: string) => value.startsWith(inboundMessagePrefix);
export const toInboundMessageId = (value: string) => `${inboundMessagePrefix}${value}`;
export const fromInboundMessageId = (value: string) =>
  isInboundMessageId(value) ? value.slice(inboundMessagePrefix.length) : value;

export interface MailMessage {
  id: string;
  folder: MailFolder;
  source: MailSource;
  fromName: string;
  fromEmail: string;
  toName: string;
  toEmail: string;
  cc?: string;
  subject: string;
  preview: string;
  body: string;
  sentAt: string;
  labels: string[];
  read: boolean;
  starred: boolean;
  deliveryStatus?: DeliveryStatus | null;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredAt?: string | null;
}

export interface MailboxState {
  inbox: MailMessage[];
  sent: MailMessage[];
  drafts: MailMessage[];
}

export interface WorkspaceMetrics {
  unreadCount: number;
  starredCount: number;
  inboxCount: number;
  sentCount: number;
  draftsCount: number;
}

export interface UserProfile {
  name: string;
  role: string;
  email: string;
  company: string;
  location: string;
  timezone: string;
  forwardingEnabled: boolean;
  signature: string;
}

export interface WorkspacePayload {
  profile: UserProfile;
  mailbox: MailboxState;
  metrics: WorkspaceMetrics;
}

export interface LoginInput {
  email: string;
  password: string;
  remember: boolean;
}

export interface ComposeInput {
  draftId?: string;
  toEmail: string;
  cc?: string;
  subject: string;
  body: string;
}

export interface MessagePatch {
  read?: boolean;
  starred?: boolean;
}

export const demoCredentials = {
  email: 'founder@flaremail.dev',
  password: 'flaremail-demo'
};

export const mockProfile: UserProfile = {
  name: 'Evelyn Chen',
  role: 'Founder, FlareMail',
  email: demoCredentials.email,
  company: 'FlareMail Labs',
  location: 'Shanghai',
  timezone: 'Asia/Shanghai',
  forwardingEnabled: true,
  signature: 'Regards,\nEvelyn\nFlareMail'
};

export const mockMailbox: MailboxState = {
  inbox: [
    {
      id: 'inbox-01',
      folder: 'inbox',
      source: 'workspace',
      fromName: 'Maya Patel',
      fromEmail: 'maya@northstar.so',
      toName: 'Evelyn Chen',
      toEmail: demoCredentials.email,
      subject: 'Pilot feedback from the first support queue',
      preview: 'Customers are replying faster when the thread preview is visible in one screen.',
      body:
        'Hi Evelyn,\n\nWe just finished the first support pilot. The biggest win is speed: agents are replying faster when the thread preview, sender profile, and mailbox labels sit in the same view. The next thing we want is a clean personal settings panel so operators can update their signature without leaving the app.\n\nIf you want, I can send the condensed notes before Friday.\n\nMaya',
      sentAt: '2026-03-24T08:20:00.000Z',
      labels: ['Feedback', 'Pilot'],
      read: false,
      starred: true
    },
    {
      id: 'inbox-02',
      folder: 'inbox',
      source: 'workspace',
      fromName: 'Arthur Kim',
      fromEmail: 'arthur@latticeops.io',
      toName: 'Evelyn Chen',
      toEmail: demoCredentials.email,
      subject: 'Can we get a calmer mailbox layout?',
      preview: 'Our ops team wants a UI that feels more editorial and less dashboard-heavy.',
      body:
        'Hello,\n\nThe product direction looks strong, but our ops team keeps asking for a calmer mailbox layout. They want fewer panels, more whitespace, and a stronger sense of reading focus. If the next pass can make the compose and detail views feel quieter, that would help adoption a lot.\n\nArthur',
      sentAt: '2026-03-24T05:05:00.000Z',
      labels: ['Design'],
      read: true,
      starred: false
    },
    {
      id: 'inbox-03',
      folder: 'inbox',
      source: 'workspace',
      fromName: 'Cloudflare Routing',
      fromEmail: 'routing@notifications.cloudflare.com',
      toName: 'Evelyn Chen',
      toEmail: demoCredentials.email,
      subject: 'Email Routing rule activated',
      preview: 'Your inbound route for hello@flaremail.dev is now pointing at the Worker.',
      body:
        'This is a generated confirmation.\n\nYour inbound route for hello@flaremail.dev is now attached to the selected Worker. New deliveries will trigger the Worker email handler and can be persisted into D1 and R2 according to your application logic.\n\nCloudflare',
      sentAt: '2026-03-23T23:10:00.000Z',
      labels: ['System'],
      read: true,
      starred: false
    }
  ],
  sent: [
    {
      id: 'sent-01',
      folder: 'sent',
      source: 'workspace',
      fromName: 'Evelyn Chen',
      fromEmail: demoCredentials.email,
      toName: 'Maya Patel',
      toEmail: 'maya@northstar.so',
      subject: 'Re: Pilot feedback from the first support queue',
      preview: 'Thanks, send the condensed notes and we will fold them into the next UI pass.',
      body:
        'Hi Maya,\n\nThanks. Send the condensed notes and we will fold them into the next UI pass. I am especially interested in how operators switch between reading mail and editing account details.\n\nRegards,\nEvelyn',
      sentAt: '2026-03-24T08:42:00.000Z',
      labels: ['Sent'],
      read: true,
      starred: false,
      deliveryStatus: 'sent',
      deliveryAttempts: 1,
      deliveryError: '',
      deliveredAt: '2026-03-24T08:42:14.000Z'
    },
    {
      id: 'sent-02',
      folder: 'sent',
      source: 'workspace',
      fromName: 'Evelyn Chen',
      fromEmail: demoCredentials.email,
      toName: 'Arthur Kim',
      toEmail: 'arthur@latticeops.io',
      subject: 'Re: Can we get a calmer mailbox layout?',
      preview: 'Agreed. The next prototype will reduce chrome and let the content breathe.',
      body:
        'Arthur,\n\nAgreed. The next prototype will reduce chrome, simplify the navigation, and let message content breathe. We are aiming for a minimal interaction model with clear compose, inbox, and profile flows.\n\nRegards,\nEvelyn',
      sentAt: '2026-03-24T06:14:00.000Z',
      labels: ['Sent'],
      read: true,
      starred: true,
      deliveryStatus: 'failed',
      deliveryAttempts: 2,
      deliveryError: '收件方域名暂时拒收，请稍后重试。',
      deliveredAt: null
    }
  ],
  drafts: [
    {
      id: 'draft-01',
      folder: 'drafts',
      source: 'workspace',
      fromName: 'Evelyn Chen',
      fromEmail: demoCredentials.email,
      toName: 'product',
      toEmail: 'product@flaremail.dev',
      cc: 'ops@flaremail.dev',
      subject: 'Weekly workspace checkpoint',
      preview: '整理一下本周的工作区目标：先接入真实进站邮件，再把草稿和发送串起来。',
      body:
        '大家好，\n\n整理一下本周的工作区目标：先接入真实进站邮件，再把草稿和发送串起来。UI 继续保持极简，但所有关键操作都要有可验证的状态落点。\n\nEvelyn',
      sentAt: '2026-03-24T09:10:00.000Z',
      labels: ['Draft'],
      read: true,
      starred: false
    }
  ]
};

const incomingTemplates = [
  {
    fromName: 'Nina Park',
    fromEmail: 'nina@orbitstudio.io',
    subject: 'New brand draft attached',
    body:
      'Hi,\n\nI uploaded a lighter brand direction with more whitespace and smaller navigation controls. It should fit the minimal mail client direction better.\n\nNina',
    labels: ['Design', 'New']
  },
  {
    fromName: 'Daniel Ross',
    fromEmail: 'daniel@shoreline.cx',
    subject: 'Support queue anomaly this morning',
    body:
      'Morning,\n\nA few support messages arrived without agent assignment. Nothing is broken, but the new mail triage flow should probably surface unassigned messages more clearly.\n\nDaniel',
    labels: ['Ops', 'Alert']
  },
  {
    fromName: 'Iris Lee',
    fromEmail: 'iris@founders.club',
    subject: 'Investor update draft review',
    body:
      'Evelyn,\n\nI read the draft. The product narrative is strong. If you want, I can tighten the section that explains why the Worker-based monolith keeps the system lean.\n\nIris',
    labels: ['Review']
  }
];

const normalizePreview = (value: string) => value.trim().replace(/\s+/g, ' ').slice(0, 96);

const deriveToName = (email: string) => email.split('@')[0].replace(/[._-]/g, ' ').trim() || email.trim();

const prefixedSubject = (prefix: 'Re' | 'Fwd', subject: string) => {
  const trimmed = subject.trim() || '(no subject)';
  const normalizedPrefix = `${prefix.toLowerCase()}:`;
  return trimmed.toLowerCase().startsWith(normalizedPrefix) ? trimmed : `${prefix}: ${trimmed}`;
};

const quoteBody = (value: string) =>
  value
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

const createReplyThread = (message: MailMessage, body: string) =>
  ['',
    '',
    `在 ${message.sentAt}，${message.fromName} <${message.fromEmail}> 写道：`,
    quoteBody(body)
  ].join('\n');

const createForwardThread = (message: MailMessage, body: string) =>
  [
    '',
    '',
    '---------- 转发邮件 ----------',
    `发件人: ${message.fromName} <${message.fromEmail}>`,
    `收件人: ${message.toName} <${message.toEmail}>`,
    `时间: ${message.sentAt}`,
    `主题: ${message.subject}`,
    '',
    body
  ].join('\n');

export function cloneMessage(message: MailMessage): MailMessage {
  return {
    ...message,
    labels: [...message.labels]
  };
}

export function cloneMailbox(mailbox: MailboxState = mockMailbox): MailboxState {
  return {
    inbox: mailbox.inbox.map(cloneMessage),
    sent: mailbox.sent.map(cloneMessage),
    drafts: mailbox.drafts.map(cloneMessage)
  };
}

export function cloneProfile(profile: UserProfile = mockProfile): UserProfile {
  return {
    ...profile
  };
}

export function getMailboxMetrics(mailbox: MailboxState): WorkspaceMetrics {
  return {
    unreadCount: mailbox.inbox.filter((message) => !message.read).length,
    starredCount:
      mailbox.inbox.filter((message) => message.starred).length +
      mailbox.sent.filter((message) => message.starred).length +
      mailbox.drafts.filter((message) => message.starred).length,
    inboxCount: mailbox.inbox.length,
    sentCount: mailbox.sent.length,
    draftsCount: mailbox.drafts.length
  };
}

export function createWorkspacePayload(profile: UserProfile, mailbox: MailboxState): WorkspacePayload {
  return {
    profile: cloneProfile(profile),
    mailbox: cloneMailbox(mailbox),
    metrics: getMailboxMetrics(mailbox)
  };
}

export function createIncomingMessage(recipient: UserProfile, sequence: number): MailMessage {
  const template = incomingTemplates[sequence % incomingTemplates.length];
  const sentAt = new Date(Date.now() + sequence * 60_000).toISOString();

  return {
    id: `inbox-live-${sequence}`,
    folder: 'inbox',
    source: 'workspace',
    fromName: template.fromName,
    fromEmail: template.fromEmail,
    toName: recipient.name,
    toEmail: recipient.email,
    subject: template.subject,
    preview: template.body.split('\n').filter(Boolean).slice(1, 2).join(' ').slice(0, 96),
    body: template.body,
    sentAt,
    labels: [...template.labels],
    read: false,
    starred: false
  };
}

export function createDraftMessage(input: {
  id?: string;
  from: UserProfile;
  toEmail: string;
  cc?: string;
  subject: string;
  body: string;
  starred?: boolean;
  updatedAt?: string;
}): MailMessage {
  const subject = input.subject.trim() || '未命名草稿';
  const body = input.body.trim();
  const toEmail = input.toEmail.trim();

  return {
    id: input.id ?? `draft-live-${crypto.randomUUID()}`,
    folder: 'drafts',
    source: 'workspace',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName: toEmail ? deriveToName(toEmail) : '待填写',
    toEmail,
    cc: input.cc?.trim() ?? '',
    subject,
    preview: normalizePreview(body || '继续补充内容…'),
    body,
    sentAt: input.updatedAt ?? new Date().toISOString(),
    labels: ['Draft'],
    read: true,
    starred: input.starred ?? false
  };
}

export function createSentMessage(input: {
  id?: string;
  from: UserProfile;
  toEmail: string;
  subject: string;
  body: string;
  cc?: string;
  deliveryStatus?: DeliveryStatus;
  deliveryAttempts?: number;
  deliveryError?: string;
  deliveredAt?: string | null;
}): MailMessage {
  const toEmail = input.toEmail.trim();
  const signatureBlock = input.from.signature ? `\n\n${input.from.signature}` : '';
  const ccLine = input.cc?.trim() ? `CC: ${input.cc.trim()}\n\n` : '';
  const body = input.body.trim();
  const messageBody = `${ccLine}${body}${signatureBlock}`;

  return {
    id: input.id ?? `sent-live-${crypto.randomUUID()}`,
    folder: 'sent',
    source: 'workspace',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName: deriveToName(toEmail),
    toEmail,
    cc: input.cc?.trim() ?? '',
    subject: input.subject.trim(),
    preview: normalizePreview(body),
    body: messageBody,
    sentAt: new Date().toISOString(),
    labels: ['Sent'],
    read: true,
    starred: false,
    deliveryStatus: input.deliveryStatus ?? 'queued',
    deliveryAttempts: input.deliveryAttempts ?? 0,
    deliveryError: input.deliveryError ?? '',
    deliveredAt: input.deliveredAt ?? null
  };
}

export function createComposeInputFromDraft(message: MailMessage): ComposeInput {
  return {
    draftId: message.folder === 'drafts' ? message.id : undefined,
    toEmail: message.toEmail,
    cc: message.cc ?? '',
    subject: message.subject === '未命名草稿' ? '' : message.subject,
    body: message.body
  };
}

export function createReplyComposeInput(message: MailMessage, quotedBody = message.body): ComposeInput {
  return {
    toEmail: message.fromEmail,
    cc: '',
    subject: prefixedSubject('Re', message.subject),
    body: `Hi ${message.fromName},\n\n${createReplyThread(message, quotedBody)}`
  };
}

export function createForwardComposeInput(message: MailMessage, forwardedBody = message.body): ComposeInput {
  return {
    toEmail: '',
    cc: '',
    subject: prefixedSubject('Fwd', message.subject),
    body: `Hi,\n\n转发给你参考。${createForwardThread(message, forwardedBody)}`
  };
}
