import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from './auth.guard.js';
import { Public } from './decorators/public.decorator.js';

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock('../auth.js', () => ({ auth: { api: { getSession } } }));

@Public()
class PublicController {
  handle() {}
}

class PrivateController {
  handle() {}
}

function contextFor(
  controller: typeof PublicController | typeof PrivateController,
  request: Partial<FastifyRequest>,
): ExecutionContext {
  return {
    getHandler: () => controller.prototype.handle,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  const guard = new AuthGuard(new Reflector());

  beforeEach(() => {
    getSession.mockReset();
  });

  it('allows @Public() routes without looking up a session', async () => {
    const request = { headers: {} };

    await expect(
      guard.canActivate(contextFor(PublicController, request)),
    ).resolves.toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('rejects protected routes without a session', async () => {
    getSession.mockResolvedValue(null);

    await expect(
      guard.canActivate(contextFor(PrivateController, { headers: {} })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the user and session when the session is valid', async () => {
    const user = { id: 'user-1', email: 'jane@example.com' };
    const session = { id: 'session-1', userId: 'user-1' };
    getSession.mockResolvedValue({ user, session });
    const request: Partial<FastifyRequest> = {
      headers: { cookie: 'better-auth.session_token=abc' },
    };

    await expect(
      guard.canActivate(contextFor(PrivateController, request)),
    ).resolves.toBe(true);
    expect(request.user).toBe(user);
    expect(request.session).toBe(session);

    const { headers } = getSession.mock.calls[0][0] as { headers: Headers };
    expect(headers.get('cookie')).toBe('better-auth.session_token=abc');
  });
});
