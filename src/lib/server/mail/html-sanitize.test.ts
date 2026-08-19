import { describe, expect, test } from 'bun:test';
import { SAFE_HTML_DEFAULT_LIMITS, SafeHtmlError, sanitizeHtml } from './html-sanitize';

describe('safe HTML sanitizer', () => {
  test('keeps safe formatting and canonicalizes links', () => {
    const result = sanitizeHtml('<H1>Hello</H1><p><strong>中文</strong> <a href="https://example.com/x?a=1">link</a></p><table><tr><td colspan="2">cell</td></tr></table>');

    expect(result.html).toBe('<h1>Hello</h1><p><strong>中文</strong> <a href="https://example.com/x?a=1" target="_blank" rel="noopener noreferrer">link</a></p><table><tr><td colspan="2">cell</td></tr></table>');
    expect(result.text).toBe('Hello中文 linkcell');
  });

  test('removes dangerous containers and event/style attributes', () => {
    const result = sanitizeHtml('<p onclick="alert(1)" style="color:red">safe</p><script>alert(1)</script><style>body{display:none}</style><iframe src="x">bad</iframe><svg><text>bad</text></svg><form>bad</form>');

    expect(result.html).toBe('<p>safe</p>');
    expect(result.text).toBe('safe');
    expect(result.removedElements).toBe(5);
  });

  test('does not let misleading closing tags escape suppressed script content', () => {
    const result = sanitizeHtml('<p>before<script>evil</p><img src="https://tracker.example/pixel">still evil</script>after</p>');

    expect(result.html).toBe('<p>beforeafter</p>');
    expect(result.text).toBe('beforeafter');
  });

  test('rejects encoded javascript, data, file and malformed schemes', () => {
    const result = sanitizeHtml([
      '<a href="javascript:alert(1)">js</a>',
      '<a href="&#x6a;avascript:alert(1)">encoded</a>',
      '<a href="java&#10;script:alert(1)">newline</a>',
      '<a href="data:text/html,evil">data</a>',
      '<a href="file:///etc/passwd">file</a>',
      '<a href="mailto:user@example.com">mail</a>'
    ].join(''));

    expect(result.html).toBe('jsencodednewlinedatafile<a href="mailto:user@example.com" target="_blank" rel="noopener noreferrer">mail</a>');
    expect(result.text).toContain('jsencodednewlinedatafilemail');
  });

  test('blocks remote images and permits only explicitly mapped owned cid images', () => {
    const result = sanitizeHtml('<p>before<img src="https://tracker.example/pixel" alt="remote">after</p><img src="data:image/png;base64,abc"><img src="cid:owned-1" alt="inline"><img src="cid:other" alt="blocked">', {
      resolveCidImage: (cid) => cid === 'owned-1' ? '/api/workspace/messages/email-1/attachments/att-1' : null
    });

    expect(result.html).toBe('<p>beforeremoteafter</p><img src="/api/workspace/messages/email-1/attachments/att-1" alt="inline">blocked');
    expect(result.text).toBe('beforeremoteafterinlineblocked');
    expect(result.blockedImages).toBe(3);
    expect(result.allowedCidImages).toBe(1);
  });

  test('treats malformed tags as text without executing them', () => {
    const result = sanitizeHtml('<p>ok &lt;script&gt;still text</p><a href="https://example.com" title="ignored">x</a><broken');

    expect(result.html).toBe('<p>ok &lt;script&gt;still text</p><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>&lt;broken');
    expect(result.text).toBe('ok <script>still textx<broken');
  });

  test('enforces input, output, nesting and node limits with stable typed errors', () => {
    const errorCode = (run: () => void) => {
      try {
        run();
        return null;
      } catch (error) {
        return error instanceof SafeHtmlError ? error.code : null;
      }
    };
    expect(errorCode(() => sanitizeHtml('😀'.repeat(100), { maxInputBytes: 10 }))).toBe('HTML_INPUT_TOO_LARGE');
    expect(errorCode(() => sanitizeHtml('<p>123456789</p>', { maxOutputBytes: 5 }))).toBe('HTML_TEXT_TOO_LARGE');
    expect(errorCode(() => sanitizeHtml('<div><div><div>x</div></div></div>', { maxDepth: 2 }))).toBe('HTML_NESTING_TOO_DEEP');
    expect(errorCode(() => sanitizeHtml('<p>x</p>'.repeat(10), { maxNodes: 3 }))).toBe('HTML_COMPLEXITY_LIMIT');
    expect(new SafeHtmlError('HTML_TEXT_TOO_LARGE', 'x', { limit: 1 }).code).toBe('HTML_TEXT_TOO_LARGE');
    expect(SAFE_HTML_DEFAULT_LIMITS.maxInputBytes).toBe(256 * 1024);
  });
});
