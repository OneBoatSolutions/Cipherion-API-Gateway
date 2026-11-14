import { clientIp } from './client-ip.js';

describe('clientIp', () => {
  it('takes a single forwarded address, like Better Auth', () => {
    expect(clientIp('203.0.113.7', '10.0.0.1')).toBe('203.0.113.7');
    expect(clientIp(' 2001:db8::1 ', '10.0.0.1')).toBe('2001:db8::1');
  });

  it('falls back to the socket address for anything else', () => {
    expect(clientIp('203.0.113.7, 198.51.100.1', '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp('not-an-ip', '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp('', '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp(undefined, '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp(['a', 'b'], '10.0.0.1')).toBe('10.0.0.1');
  });
});
