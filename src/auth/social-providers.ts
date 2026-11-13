// Each provider is on only when both its id and secret are set; the env schema
// refuses one without the other.
//
// Redirect URIs to register with each provider: <base>/api/v1/auth/callback/google
// and /callback/github, where <base> is SOCIAL_REDIRECT_BASE_URL when it is set,
// otherwise BETTER_AUTH_URL.
//
// SOCIAL_REDIRECT_BASE_URL is the dashboard's origin when the dashboard proxies
// /api/v1/auth/* to this gateway. Better Auth's state cookie is then set on the
// dashboard's host, so the provider must send the user back to that host: a
// callback on the API host has no state cookie and fails with state_mismatch.
export function socialProviders(env: NodeJS.ProcessEnv = process.env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = env;
  const base = env.SOCIAL_REDIRECT_BASE_URL?.replace(/\/+$/, '');
  const redirectURI = (provider: string) =>
    base ? { redirectURI: `${base}/api/v1/auth/callback/${provider}` } : {};
  return {
    ...(GOOGLE_CLIENT_ID &&
      GOOGLE_CLIENT_SECRET && {
        google: {
          clientId: GOOGLE_CLIENT_ID,
          clientSecret: GOOGLE_CLIENT_SECRET,
          ...redirectURI('google'),
        },
      }),
    ...(GITHUB_CLIENT_ID &&
      GITHUB_CLIENT_SECRET && {
        github: {
          clientId: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
          ...redirectURI('github'),
        },
      }),
  };
}
