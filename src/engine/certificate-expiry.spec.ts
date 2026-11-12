import { reportCertificateExpiry } from './certificate-expiry.js';

describe('reportCertificateExpiry', () => {
  const now = Date.parse('2026-11-06T00:00:00Z');
  const inDays = (days: number) => new Date(now + days * 86_400_000);

  it('logs an error for an expired certificate and a warning under 30 days', () => {
    const logger = { error: vi.fn(), warn: vi.fn() };
    reportCertificateExpiry(
      [
        { label: 'old', notAfter: inDays(-1) },
        { label: 'soon', notAfter: inDays(10) },
        { label: 'fine', notAfter: inDays(30) },
      ],
      logger,
      now,
    );
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('old has expired');
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      'soon expires in 10 days',
    );
  });
});
