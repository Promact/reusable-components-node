import { PostHogFeatureFlagService } from './posthog';

describe('PostHogFeatureFlagService', () => {
  const options = { apiKey: 'key123', host: 'https://posthog.example.com', projectId: '42' };

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects at construction time when apiKey is missing', () => {
    expect(() => new PostHogFeatureFlagService({ ...options, apiKey: '' })).toThrow();
  });

  it('rejects at construction time when host is missing', () => {
    expect(() => new PostHogFeatureFlagService({ ...options, host: '' })).toThrow();
  });

  it('rejects at construction time when projectId is missing', () => {
    expect(() => new PostHogFeatureFlagService({ ...options, projectId: '' })).toThrow();
  });

  it('sends Authorization: Bearer {apiKey} against api/projects/{projectId}/feature_flags/', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ key: 'new-checkout', active: true }] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const service = new PostHogFeatureFlagService(options);
    await service.isFeatureEnabled('new-checkout');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://posthog.example.com/api/projects/42/feature_flags/');
    expect(init.headers.Authorization).toBe('Bearer key123');
  });

  it('returns true when the matching flag is active', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ key: 'new-checkout', active: true }] }),
    }) as unknown as typeof fetch;

    const service = new PostHogFeatureFlagService(options);
    await expect(service.isFeatureEnabled('new-checkout')).resolves.toBe(true);
  });

  it('returns false (never throws) when the flag key is not found', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ key: 'other-flag', active: true }] }),
    }) as unknown as typeof fetch;

    const service = new PostHogFeatureFlagService(options);
    await expect(service.isFeatureEnabled('missing-flag')).resolves.toBe(false);
  });

  it('returns false (never throws) on a non-2xx HTTP response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;

    const service = new PostHogFeatureFlagService(options);
    await expect(service.isFeatureEnabled('new-checkout')).resolves.toBe(false);
  });

  it('returns false (never throws) when the network call itself rejects', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const service = new PostHogFeatureFlagService(options);
    await expect(service.isFeatureEnabled('new-checkout')).resolves.toBe(false);
  });
});
