import {
  escapeHtml,
  passwordChangedEmail,
  passwordResetEmail,
  verificationEmail,
} from './emails.js';

describe('auth emails', () => {
  const url =
    'http://localhost:3000/api/v1/auth/verify-email?token=abc&callbackURL=x';
  const user = {
    name: '<script>alert(1)</script>',
    email: 'ada@cipherion.test',
  };

  it('escapes HTML', () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe(
      '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;',
    );
  });

  it.each([
    ['verification', verificationEmail, 'Verify email address'],
    ['password reset', passwordResetEmail, 'Reset password'],
  ])(
    'builds the %s email with a button and a plain link',
    (_, build, label) => {
      const email = build(user, url);
      const href = `href="${url.replaceAll('&', '&amp;')}"`;

      expect(email.to).toBe(user.email);
      expect(email.html).not.toContain('<script>');
      expect(email.html).toContain('Hi &lt;script&gt;alert(1)&lt;/script&gt;,');
      // The button and the fallback link underneath it.
      expect(email.html.split(href)).toHaveLength(3);
      expect(email.html).toContain(`>${label}</a>`);
      expect(email.html).not.toMatch(/<img|src=/);
      expect(email.text).toContain(`${label}: ${url}`);
      expect(email.text).toContain('expires in 1 hour');
    },
  );

  it('builds the password changed email without a link', () => {
    const when = new Date('2026-11-11T08:30:00Z');
    const email = passwordChangedEmail(user, when);

    expect(email.subject).toBe('Your Cipherion password was changed');
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<a ');
    expect(email.text).toContain(when.toUTCString());
    expect(email.text).toContain('Forgot password');
  });
});
