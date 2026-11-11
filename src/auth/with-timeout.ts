export const PROVIDER_TIMEOUT_MS = 10_000;

// Better Auth's calls to Google and GitHub have no time limit of their own.
// This answers the user after the limit; the call itself finishes in the background.
export async function withTimeout(
  handled: Promise<Response>,
  ms: number,
): Promise<Response> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<Response>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(
          Response.json(
            {
              code: 'PROVIDER_TIMEOUT',
              message: 'Sign-in took too long. Please try again.',
            },
            { status: 504 },
          ),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([handled, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
