// app.inject() sends no client IP, so every e2e file would share one Better
// Auth rate-limit bucket (sign-up/sign-in: 3 per 10 s) and the fourth sign-up
// across the suite would get 429. Better Auth reads the IP from
// x-forwarded-for, so each test sends its own address from the 198.18.0.0/15
// benchmarking range (RFC 2544), which is never a real client.
export function uniqueClientIp(): string {
  const n = Math.floor(Math.random() * 2 ** 17);
  return `198.${18 + (n >> 16)}.${(n >> 8) & 0xff}.${n & 0xff}`;
}
