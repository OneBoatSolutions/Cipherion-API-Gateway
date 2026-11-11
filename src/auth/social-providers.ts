// Each provider is on only when both its id and secret are set; the env schema
// refuses one without the other. Redirect URIs to register with each provider:
// <BETTER_AUTH_URL>/api/v1/auth/callback/google and /callback/github.
export function socialProviders(env: NodeJS.ProcessEnv = process.env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  const { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET } = env;
  return {
    ...(GOOGLE_CLIENT_ID &&
      GOOGLE_CLIENT_SECRET && {
        google: {
          clientId: GOOGLE_CLIENT_ID,
          clientSecret: GOOGLE_CLIENT_SECRET,
        },
      }),
    ...(GITHUB_CLIENT_ID &&
      GITHUB_CLIENT_SECRET && {
        github: {
          clientId: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
        },
      }),
  };
}
