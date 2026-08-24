import { describe, expect, test } from 'bun:test';
import { sanitizeComposeInput } from './compose-body';

describe('compose body normalization', () => {
  test('removes XSS and uses sanitized text when plain text is empty', () => {
    const result = sanitizeComposeInput({
      toEmail: 'person@example.com',
      subject: 'Subject',
      body: '',
      html: '<p>Hello</p><script>alert(1)</script><img src="https://tracker.example/pixel">'
    });
    expect(result.body).toBe('Hello');
    expect(result.html).toBe('<p>Hello</p>');
    expect(result.html).not.toContain('alert');
    expect(result.html).not.toContain('tracker.example');
  });

  test('rejects HTML-only content that has no safe body after sanitization', () => {
    expect(() => sanitizeComposeInput({
      toEmail: 'person@example.com',
      subject: 'Subject',
      body: '',
      html: '<script>alert(1)</script><style>body{display:none}</style>'
    })).toThrow('HTML 清洗后没有可发送的正文内容。');
  });
});
