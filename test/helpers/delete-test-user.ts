import { prisma } from './../../src/lib/prisma.js';
import { redis } from './../../src/lib/redis.js';

// Deleting a user straight through Prisma bypasses Better Auth, so its cached
// sessions in Redis must be removed too, or they stay valid until their TTL.
export async function deleteTestUser(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  const listKey = `active-sessions-${user.id}`;
  const list = await redis.get(listKey);
  const tokens = list
    ? (JSON.parse(list) as { token: string }[]).map(({ token }) => token)
    : [];

  await redis.del(listKey, ...tokens);
  await prisma.user.delete({ where: { id: user.id } });
}
