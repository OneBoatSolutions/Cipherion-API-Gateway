import { Controller, Get, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APIError } from 'better-auth/api';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../auth.js';
import { Public } from './decorators/public.decorator.js';
import {
  BEGIN_PATH,
  bindCode,
  clientIp,
  errorCode,
  FINISH_PATH,
  firstBegin,
  isFlowId,
  loopbackUrl,
  messagePage,
  newFlowId,
  PAGE_HEADERS,
  parseStartQuery,
  readFlow,
  saveFlow,
  socialOrigin,
  takeFlow,
  tooManyStarts,
} from './desktop-sign-in.js';
import { socialProviders } from './social-providers.js';

const EXPIRED = messagePage(
  'This sign-in link has expired',
  'Go back to CipSeQ and choose Google or GitHub again.',
);
const BAD_LINK = messagePage(
  'This sign-in link is not valid',
  'Start the sign-in from the CipSeQ app.',
);
const BUSY = messagePage(
  'Sign-in is unavailable',
  'Please try again in a few minutes.',
);
const TOO_MANY = messagePage(
  'Too many sign-in attempts',
  'Wait a minute, then try again from the CipSeQ app.',
);

type Query = Record<string, unknown>;

// The browser half of Google and GitHub sign-in for the desktop agent. The flow
// and its checks are described in desktop-sign-in.ts. These routes are more
// specific than AuthController's wildcard, so Fastify matches them first.
@ApiExcludeController()
@Public()
@Controller('auth/desktop')
export class DesktopSignInController {
  // Opened by the agent in the user's browser.
  @Get('start')
  async start(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await answer(reply, async () => {
      if (
        await tooManyStarts(clientIp(req.headers['x-forwarded-for'], req.ip))
      ) {
        return page(reply, 429, TOO_MANY);
      }
      const enabled = Object.keys(socialProviders());
      const query = parseStartQuery(req.query as Query, enabled);
      if (!query) {
        return page(reply, 400, BAD_LINK);
      }
      const flowId = newFlowId();
      await saveFlow(flowId, { ...query, createdAt: Date.now() });
      redirect(reply, `${socialOrigin()}${BEGIN_PATH}?flow=${flowId}`);
    });
  }

  // On the origin the provider returns to, so the state cookie is set there.
  @Get('begin')
  async begin(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await answer(reply, async () => {
      const flowId = (req.query as Query).flow;
      const flow = isFlowId(flowId) ? await readFlow(flowId) : undefined;
      if (!isFlowId(flowId) || !flow || !(await firstBegin(flowId))) {
        return page(reply, 400, EXPIRED);
      }
      const back = `${FINISH_PATH}?flow=${flowId}`;
      const { headers, response } = await auth.api.signInSocial({
        body: {
          provider: flow.provider,
          callbackURL: back,
          errorCallbackURL: back,
          disableRedirect: true,
        },
        headers: fromNodeHeaders(req.headers),
        returnHeaders: true,
      });
      if (!response?.url) {
        return page(reply, 503, BUSY);
      }
      const cookies = headers.getSetCookie();
      if (cookies.length > 0) {
        reply.header('set-cookie', cookies);
      }
      redirect(reply, response.url);
    });
  }

  // Where Better Auth sends the browser after Google or GitHub, on success
  // (with the new session cookie) or failure (with `error`).
  @Get('finish')
  async finish(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await answer(reply, async () => {
      const query = req.query as Query;
      const flow = isFlowId(query.flow)
        ? await takeFlow(query.flow)
        : undefined;
      if (!flow) {
        return page(reply, 400, EXPIRED);
      }
      if (query.error !== undefined) {
        return redirect(
          reply,
          loopbackUrl(flow, { error: errorCode(query.error) }),
        );
      }

      const headers = fromNodeHeaders(req.headers);
      const signedIn = await auth.api.getSession({ headers });
      // Only a session this sign-in made: never one the browser already had,
      // for example a dashboard session left open when the provider failed.
      if (
        !signedIn ||
        new Date(signedIn.session.createdAt).getTime() < flow.createdAt
      ) {
        return redirect(reply, loopbackUrl(flow, { error: 'sign_in_failed' }));
      }

      const { token } = await auth.api.generateOneTimeToken({ headers });
      await bindCode(token, flow.challenge);
      // The agent holds the session from here on; the browser keeps no copy.
      reply.header('set-cookie', await expiredSessionCookie());
      redirect(reply, loopbackUrl(flow, { code: token }));
    });
  }
}

function redirect(reply: FastifyReply, location: string): void {
  reply
    .status(302)
    .header('location', location)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .send();
}

function page(reply: FastifyReply, status: number, html: string): void {
  reply.status(status).headers(PAGE_HEADERS).send(html);
}

// Redis or the database being down is a page, not a stack trace. Anything
// unexpected is still thrown, so Nest logs it and answers 500.
async function answer(
  reply: FastifyReply,
  handle: () => Promise<void>,
): Promise<void> {
  try {
    await handle();
  } catch (error) {
    if (error instanceof APIError && error.statusCode === 503) {
      return page(reply, 503, BUSY);
    }
    if (error instanceof APIError && error.statusCode < 500) {
      return page(reply, 400, BAD_LINK);
    }
    throw error;
  }
}

async function expiredSessionCookie(): Promise<string> {
  const { name, attributes } = (await auth.$context).authCookies.sessionToken;
  const parts = [`${name}=`, 'Max-Age=0', `Path=${attributes.path ?? '/'}`];
  if (attributes.domain) {
    parts.push(`Domain=${attributes.domain}`);
  }
  if (attributes.secure || name.startsWith('__Secure-')) {
    parts.push('Secure');
  }
  parts.push('HttpOnly');
  if (attributes.sameSite) {
    const sameSite = String(attributes.sameSite);
    parts.push(`SameSite=${sameSite[0].toUpperCase()}${sameSite.slice(1)}`);
  }
  return parts.join('; ');
}
