export type MailFolder = 'inbox' | 'sent';

export interface MailMessage {
  id: string;
  folder: MailFolder;
  fromName: string;
  fromEmail: string;
  toName: string;
  toEmail: string;
  subject: string;
  preview: string;
  body: string;
  sentAt: string;
  labels: string[];
  read: boolean;
  starred: boolean;
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

export const mockMailbox = {
  inbox: [
    {
      id: 'inbox-01',
      folder: 'inbox',
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
  ] satisfies MailMessage[],
  sent: [
    {
      id: 'sent-01',
      folder: 'sent',
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
      starred: false
    },
    {
      id: 'sent-02',
      folder: 'sent',
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
      starred: true
    }
  ] satisfies MailMessage[]
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

export function cloneMailbox() {
  return {
    inbox: mockMailbox.inbox.map((message) => ({ ...message, labels: [...message.labels] })),
    sent: mockMailbox.sent.map((message) => ({ ...message, labels: [...message.labels] }))
  };
}

export function cloneProfile() {
  return {
    ...mockProfile
  };
}

export function createIncomingMessage(recipient: UserProfile, sequence: number): MailMessage {
  const template = incomingTemplates[sequence % incomingTemplates.length];
  const sentAt = new Date(Date.now() + sequence * 60_000).toISOString();

  return {
    id: `inbox-live-${sequence}`,
    folder: 'inbox',
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

export function createSentMessage(input: {
  from: UserProfile;
  toEmail: string;
  subject: string;
  body: string;
  cc?: string;
}): MailMessage {
  const toName = input.toEmail.split('@')[0].replace(/[._-]/g, ' ');
  const signatureBlock = input.from.signature ? `\n\n${input.from.signature}` : '';
  const ccLine = input.cc?.trim() ? `CC: ${input.cc.trim()}\n\n` : '';
  const messageBody = `${ccLine}${input.body.trim()}${signatureBlock}`;

  return {
    id: `sent-live-${crypto.randomUUID()}`,
    folder: 'sent',
    fromName: input.from.name,
    fromEmail: input.from.email,
    toName,
    toEmail: input.toEmail.trim(),
    subject: input.subject.trim(),
    preview: input.body.trim().replace(/\s+/g, ' ').slice(0, 96),
    body: messageBody,
    sentAt: new Date().toISOString(),
    labels: ['Sent'],
    read: true,
    starred: false
  };
}
