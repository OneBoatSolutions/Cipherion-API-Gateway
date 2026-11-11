import { socialProviders } from './social-providers.js';

describe('socialProviders', () => {
  it('turns nothing on without credentials', () => {
    expect(socialProviders({})).toEqual({});
  });

  it('turns on each provider that has both values', () => {
    expect(
      socialProviders({
        GOOGLE_CLIENT_ID: 'g-id',
        GOOGLE_CLIENT_SECRET: 'g-secret',
        GITHUB_CLIENT_ID: 'gh-id',
      }),
    ).toEqual({ google: { clientId: 'g-id', clientSecret: 'g-secret' } });

    expect(
      socialProviders({
        GITHUB_CLIENT_ID: 'gh-id',
        GITHUB_CLIENT_SECRET: 'gh-secret',
      }),
    ).toEqual({ github: { clientId: 'gh-id', clientSecret: 'gh-secret' } });
  });
});
