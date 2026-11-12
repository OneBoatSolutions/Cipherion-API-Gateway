import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { trustedOrigins } from './../../src/config/env.js';
import { prisma } from './../../src/lib/prisma.js';
import { uniqueClientIp } from './client-ip.js';

export interface SignedInUser {
  id: string;
  email: string;
  cookie: string;
  // The signed bearer token from the set-auth-token header.
  token: string;
}

export const TEST_PASSWORD = 'e2e-password-123';

export const cookieOf = (response: {
  cookies: { name: string; value: string }[];
}): string =>
  response.cookies.map(({ name, value }) => `${name}=${value}`).join('; ');

// Sign-up returns no session until the email is verified, so tests skip the
// email: sign up, mark the address verified directly, then sign in.
export async function signUpVerified(
  app: NestFastifyApplication,
  name: string,
  email: string,
  password = TEST_PASSWORD,
): Promise<SignedInUser> {
  const headers = {
    origin: trustedOrigins[0],
    'x-forwarded-for': uniqueClientIp(),
  };

  const signUp = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-up/email',
    headers,
    payload: { name, email, password },
  });
  expect(signUp.statusCode).toBe(200);

  const { id } = await prisma.user.update({
    where: { email },
    data: { emailVerified: true },
    select: { id: true },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in/email',
    headers,
    payload: { email, password },
  });
  expect(signIn.statusCode).toBe(200);
  const token = signIn.headers['set-auth-token'];
  expect(typeof token).toBe('string');

  return { id, email, cookie: cookieOf(signIn), token: token as string };
}
