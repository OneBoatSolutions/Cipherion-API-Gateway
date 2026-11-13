import {
  escapeHtml,
  passwordChangedEmail,
  passwordResetCodeEmail,
  verificationCodeEmail,
} from './emails.js';

describe('auth emails', () => {
  const code = '048213';
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
    ['verification', verificationCodeEmail, 'Verify your Cipherion email address'],
    ['password reset', passwordResetCodeEmail, 'Reset your Cipherion password'],
  ])('builds the %s email with the code and no link', (_, build, subject) => {
    const email = build(user, code);

    expect(email.to).toBe(user.email);
    expect(email.subject).toBe(subject);
    // Never on a lock screen.
    expect(email.subject).not.toContain(code);
    expect(email.html).not.toContain('<script>');
    expect(email.html).toContain('Hi &lt;script&gt;alert(1)&lt;/script&gt;,');
    expect(email.html).toContain(`>${code}</td>`);
    expect(email.html).not.toMatch(/<a |href=|<img|src=/);
    expect(email.text).toContain(`Your code: ${code}`);
    expect(email.text).toContain('expires in 10 minutes');
    expect(email.text).toContain('Never share it');
  });

  it('builds the password changed email without a link or code', () => {
    const when = new Date('2026-11-11T08:30:00Z');
    const email = passwordChangedEmail(user, when);

    expect(email.subject).toBe('Your Cipherion password was changed');
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<a ');
    expect(email.text).not.toContain('Your code');
    expect(email.text).toContain(when.toUTCString());
    expect(email.text).toContain('Forgot password');
  });
});
