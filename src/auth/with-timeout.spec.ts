import { withTimeout } from './with-timeout.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the response when it arrives in time', async () => {
    const response = new Response(null, { status: 302 });
    await expect(withTimeout(Promise.resolve(response), 10_000)).resolves.toBe(
      response,
    );
  });

  it('answers 504 when the provider takes too long', async () => {
    const result = withTimeout(new Promise<Response>(() => {}), 10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    const response = await result;
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      code: 'PROVIDER_TIMEOUT',
      message: 'Sign-in took too long. Please try again.',
    });
  });

  it('passes errors through', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 10_000),
    ).rejects.toThrow('boom');
  });
});
