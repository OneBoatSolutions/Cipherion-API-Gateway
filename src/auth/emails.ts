import type { Email } from '../lib/mailer.js';

// Names are chosen by whoever signs up, so they're escaped before going into HTML.
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

interface Recipient {
  name: string;
  email: string;
}

interface Content {
  subject: string;
  // The line inbox lists show next to the subject.
  preview: string;
  heading: string;
  // Plain sentences; escaped before going into HTML.
  paragraphs: string[];
  action?: { label: string; url: string };
  // Under the button: how long the link lasts, and what to do if it wasn't you.
  notes: string[];
}

const BRAND = '#4f46e5';
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Tables and inline styles, because that's what Gmail and Outlook render
// reliably. No images, so nothing is fetched and nothing tracks opens.
function layout(content: Content, greetingName: string): string {
  const paragraph = (text: string) =>
    `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#344054;">${escapeHtml(text)}</p>`;
  const note = (text: string) =>
    `<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#667085;">${escapeHtml(text)}</p>`;

  const action = content.action
    ? `
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
            <tr>
              <td bgcolor="${BRAND}" style="border-radius:8px;">
                <a href="${escapeHtml(content.action.url)}" target="_blank" style="display:inline-block;padding:12px 24px;font-family:${FONT};font-size:15px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(content.action.label)}</a>
              </td>
            </tr>
          </table>
          ${note("If the button doesn't work, copy this link into your browser:")}
          <p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;"><a href="${escapeHtml(content.action.url)}" target="_blank" style="color:${BRAND};">${escapeHtml(content.action.url)}</a></p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(content.subject)}</title>
  <style>
    @media (prefers-color-scheme: dark) {
      .page { background:#0c111d !important; }
      .card { background:#161b26 !important; border-color:#2a3140 !important; }
      .card p, .card h1 { color:#e4e7ec !important; }
      .muted { color:#98a2b3 !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(content.preview)}</div>
  <table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f4f7;font-family:${FONT};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
          <tr>
            <td style="padding:0 0 20px;font-size:18px;font-weight:700;color:#101828;">
              <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${BRAND};margin-right:8px;"></span>Cipherion
            </td>
          </tr>
          <tr>
            <td class="card" style="background:#ffffff;border:1px solid #eaecf0;border-radius:12px;padding:32px;">
              <h1 style="margin:0 0 20px;font-size:22px;line-height:30px;font-weight:700;color:#101828;">${escapeHtml(content.heading)}</h1>
              ${paragraph(`Hi ${greetingName},`)}
              ${content.paragraphs.map(paragraph).join('\n              ')}
              ${action}
              ${content.notes.map(note).join('\n              ')}
            </td>
          </tr>
          <tr>
            <td class="muted" style="padding:20px 8px 0;font-size:12px;line-height:18px;color:#98a2b3;text-align:center;">
              You're receiving this because of activity on your Cipherion account.<br>Cipherion will never ask for your password or passphrase by email.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function text(content: Content, name: string): string {
  return [
    `Hi ${name},`,
    '',
    ...content.paragraphs.flatMap((line) => [line, '']),
    ...(content.action
      ? [`${content.action.label}: ${content.action.url}`, '']
      : []),
    ...content.notes,
    '',
    '-- ',
    'Cipherion. We will never ask for your password or passphrase by email.',
  ].join('\n');
}

function build(user: Recipient, content: Content): Email {
  return {
    to: user.email,
    subject: content.subject,
    // escapeHtml is applied inside layout(), so the raw name goes in here.
    html: layout(content, user.name),
    text: text(content, user.name),
  };
}

const LINK_LIFETIME = 'This link works once and expires in 1 hour.';

export const verificationEmail = (user: Recipient, url: string): Email =>
  build(user, {
    subject: 'Verify your Cipherion email address',
    preview: 'Confirm your email address to finish setting up your account.',
    heading: 'Verify your email address',
    paragraphs: [
      'Thanks for creating a Cipherion account. Confirm that this is your email address to finish setting it up.',
    ],
    action: { label: 'Verify email address', url },
    notes: [
      LINK_LIFETIME,
      "If you didn't create a Cipherion account, ignore this email and don't click the link.",
    ],
  });

export const passwordResetEmail = (user: Recipient, url: string): Email =>
  build(user, {
    subject: 'Reset your Cipherion password',
    preview: 'Use this link to choose a new password.',
    heading: 'Reset your password',
    paragraphs: [
      'We received a request to reset the password of your Cipherion account. Choose a new one with the button below.',
      'Resetting your password signs you out on every device.',
    ],
    action: { label: 'Reset password', url },
    notes: [
      LINK_LIFETIME,
      "If you didn't ask for this, ignore this email. Your password stays the same.",
    ],
  });

// No link: the gateway doesn't know the frontend's address, and a link in an
// unexpected security email is what phishing looks like.
export const passwordChangedEmail = (user: Recipient, when: Date): Email =>
  build(user, {
    subject: 'Your Cipherion password was changed',
    preview: "If this wasn't you, reset your password now.",
    heading: 'Your password was changed',
    paragraphs: [
      `The password of your Cipherion account was changed on ${when.toUTCString()}.`,
      'Every other device and browser was signed out. The one used to make the change stays signed in.',
    ],
    notes: [
      "If this was you, there's nothing else to do.",
      'If this wasn\'t you, reset your password straight away with "Forgot password" on the Cipherion sign-in page. That signs out everyone, including whoever changed it.',
    ],
  });
