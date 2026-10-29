import { describe, expect, test } from 'bun:test';
import { sanitizeEmailInlineCss, sanitizeEmailStylesheet } from './css-sanitize';
import { SafeHtmlError, sanitizeHtml } from './html-sanitize';

describe('email presentation CSS', () => {
  test('preserves common newsletter layout and responsive class/id rules', () => {
    const result = sanitizeHtml(`<html><head><title>Not body text</title><style>
      body { margin:0; background:#eee; color:#222 }
      .card, #receipt { max-width:600px; border-radius:8px }
      @media screen and (max-width:480px) { .card { width:100%!important; padding:12px } }
    </style></head><body bgcolor="#eeeeee"><table class="card" id="receipt" width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" valign="top" style="padding:24px;background:#fff"><a href="https://example.com" style="display:inline-block;background-color:#1558b0;color:white;padding:12px 20px">Open</a><img src="cid:logo" width="120" height="40" style="display:block" alt="logo"></td></tr></table></body></html>`, {
      preserveStyles: true, resolveCidImage: () => '/api/owned-logo'
    });
    expect(result.html).toContain('class="fm-tag-body" bgcolor="#eeeeee"');
    expect(result.html).toContain('class="fm-user-card" id="fm-user-receipt"');
    expect(result.html).toContain('width="100%" cellpadding="0" cellspacing="0" role="presentation"');
    expect(result.html).toContain('style="padding:24px;background:#fff" align="center" valign="top"');
    expect(result.html).toContain('style="display:block" width="120" height="40"');
    expect(result.styles).toContain('.fm-email-content fm-email-body{margin:0;background:#eee;color:#222}');
    expect(result.styles).toContain('.fm-email-content .fm-user-card,.fm-email-content #fm-user-receipt');
    expect(result.styles).toContain('@media screen and (max-width:480px)');
    expect(result.text).toBe('Openlogo');
  });

  test('removes resource loads, CSS escapes, active functions and UI positioning', () => {
    for (const css of [
      'background:url(https://tracker.example/pixel)',
      'background:image-set("https://tracker.example/pixel" 1x)',
      'background:var(--tracking)', 'color:expression(alert(1))',
      'position:fixed;inset:0;z-index:99999',
      'width:attr(data-width px)', 'font-family:evil;src:url(https://tracker.example/font)',
      'background:u\\72l(https://tracker.example/pixel)',
      'background:URL(//tracker.example/pixel)'
    ]) {
      const output = sanitizeEmailInlineCss(css);
      expect(output).not.toMatch(/tracker|url\(|expression|var\(|fixed|z-index|attr\(/iu);
    }
    const css = sanitizeEmailStylesheet(`@import 'https://tracker.example/a';
      @font-face{font-family:evil;src:url(https://tracker.example/font)}
      a[href^="secret"]{background:url(https://tracker.example/pixel)}
      .fm-privacy-note{display:none} body{color:red;background:url(https://tracker.example/b)}
      @supports(display:grid){div{display:none}}`);
    expect(css).not.toContain('tracker');
    expect(css).not.toContain('@import');
    expect(css).not.toContain('@font-face');
    expect(css).not.toContain('@supports');
    expect(css).toContain('.fm-email-content .fm-user-fm-privacy-note{display:none}');
    expect(css).toContain('.fm-email-content fm-email-body{color:red}');
  });

  test('keeps buttons free of injected labels and risk notices outside sender CSS', () => {
    const result = sanitizeHtml('<style>span{display:none!important}</style><p><a href="https://example.com">Open account</a></p><a href="https://other.example">https://example.com</a>', { preserveStyles: true });
    expect(result.html).not.toContain('fm-link-target');
    expect(result.html).toContain('title="https://example.com"');
    expect(result.linkNotices).toContain('[other.example]');
    expect(result.linkNotices).toContain('显示文本与目标不一致');
    expect(result.styles).toBe('.fm-email-content span{display:none!important}');
    expect(sanitizeHtml('<style media="print">p{display:none}</style><p>screen</p>', { preserveStyles: true }).styles).toBe('');
  });

  test('preserves child selectors and legacy presentation tag identity', () => {
    const result = sanitizeHtml('<style>.card>p{color:red}font{font-weight:bold}center{font-size:36px}</style><div class="card"><p>Child</p></div><center><font>Legacy</font></center>', { preserveStyles: true });
    expect(result.styles).toContain('.fm-email-content .fm-user-card>p{color:red}');
    expect(result.styles).toContain('.fm-email-content font{font-weight:bold}');
    expect(result.styles).toContain('.fm-email-content center{font-size:36px}');
    expect(result.html).toContain('<center>');
    expect(result.html).toContain('<font>');
    const link = sanitizeHtml('<a href="https://attacker.example"><span style="display:none">https://attacker.example/</span>https://bank.example</a>', { preserveStyles: true });
    expect(link.linkNotices).toContain('[attacker.example]');
    expect(link.linkNotices).toContain('显示文本与目标不一致');
  });

  test('normalizes malformed table nesting and budgets the final UTF-8 document fragments', () => {
    const result = sanitizeHtml('<style>p{color:red}</style><table><div><table></table></div></table><div style="margin-top:-35px">中文<a href="http://attacker.example">https://bank.example</a></div>', { preserveStyles: true });
    expect(result.html).toContain('<div></div><table></table><table></table><div');
    const bytes = new TextEncoder().encode(result.html + result.styles + result.linkNotices).byteLength;
    const input = '<style>p{color:red}</style><table><div><table></table></div></table><div style="margin-top:-35px">中文<a href="http://attacker.example">https://bank.example</a></div>';
    expect(sanitizeHtml(input, { preserveStyles: true, maxOutputBytes: bytes }).html).toBe(result.html);
    expect(() => sanitizeHtml(input, { preserveStyles: true, maxOutputBytes: bytes - 1 })).toThrow();
    const repaired = sanitizeHtml('<table><tr><td>x</td></tr></table>', { preserveStyles: true });
    expect(repaired.html).toContain('<tbody>');
    expect(() => sanitizeHtml('<table><tr><td>x</td></tr></table>', { preserveStyles: true, maxOutputBytes: repaired.html.length - 1 })).toThrow();
  });

  test('bounds repaired DOM depth before recursive HTML serialization', () => {
    const code = (input: string, limits = {}) => {
      try { sanitizeHtml(input, { preserveStyles: true, ...limits }); }
      catch (error) { return error instanceof SafeHtmlError ? error.code : String(error); }
    };
    expect(code('<div/>'.repeat(9000))).toBe('HTML_NESTING_TOO_DEEP');
    expect(code('<table><tr><td>x</td></tr></table>', { maxDepth: 3 })).toBe('HTML_NESTING_TOO_DEEP');
    expect(code('hello', { maxNodes: 0 })).toBe('HTML_COMPLEXITY_LIMIT');
  });

  test('preserves low-priority legacy hints and synthesizes implicit roots', () => {
    const result = sanitizeHtml('<style>body{color:white}div{padding:20px}.card{color:white;background-color:#111}</style><table><tr><td class="card" bgcolor="#fff">Text</td></tr></table><center><font color="red" face="Arial" size="2">Legacy</font></center>', { preserveStyles: true });
    expect(result.html).toStartWith('<fm-email-html class="fm-tag-html"><fm-email-body class="fm-tag-body">');
    expect(result.html).toContain('class="fm-user-card" bgcolor="#fff"');
    expect(result.html).not.toContain('style="background-color:#fff"');
    expect(result.html).toContain('<center><font color="red" face="Arial" size="2">');
    expect(result.styles).toContain('.fm-email-content div{padding:20px}');
    const body = sanitizeHtml('<style>body{background:#111}</style><body bgcolor="#fff">Text</body>', { preserveStyles: true });
    expect(body.styles).toStartWith(':where(.fm-email-content .fm-tag-body){background-color:#fff}');
    expect(body.styles).toContain('.fm-email-content fm-email-body{background:#111}');
    const attack = '<div>' + Array.from({ length: 1500 }, (_, i) => `<b id="b${i}"/>`).join('') + '</div>' + '<p>x</p>'.repeat(1500);
    expect(() => sanitizeHtml(attack, { preserveStyles: true })).toThrow(SafeHtmlError);
    expect(() => sanitizeHtml('<table><tr/><td/>', { preserveStyles: true, maxNodes: 4 })).toThrow(SafeHtmlError);
  });

  test('bounds malformed and deeply nested CSS and accounts for stylesheet output', () => {
    expect(sanitizeEmailStylesheet('a{color:red')).toBe('');
    expect(sanitizeEmailInlineCss(`width:${'calc('.repeat(100)}1px${')'.repeat(100)}`)).toBe('');
    expect(() => sanitizeHtml('<style>p{color:red}</style>', { preserveStyles: true, maxOutputBytes: 5 })).toThrow();
    const result = sanitizeHtml('<style>p{color:red}</style><p>still here</p>', { preserveStyles: true });
    expect(result.html).toContain('<p>still here</p>');
    expect(result.styles).toBe('.fm-email-content p{color:red}');
    expect(sanitizeEmailStylesheet('<!-- p{color:red} -->')).toBe('.fm-email-content p{color:red}');
    expect(sanitizeEmailStylesheet('/* Step 1) */ p{font-family:"Example ) Font";color:red}')).toContain('color:red');
  });

  test('keeps compose policy separate and never treats stylesheet strings as HTML', () => {
    expect(sanitizeHtml('<style>p{color:red}</style><p style="color:red">hello</p>').html).toBe('<p>hello</p>');
    const result = sanitizeHtml('<style>p{font-family:"</style><script>alert(1)</script><p>safe</p>', { preserveStyles: true });
    expect(result.html).toContain('<p>safe</p>');
    expect(result.styles).toBe('');
  });
});
