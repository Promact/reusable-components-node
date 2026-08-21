const mockVariation = jest.fn();
const mockWaitForInitialization = jest.fn().mockResolvedValue(undefined);
const mockInit = jest.fn();

jest.mock('@launchdarkly/node-server-sdk', () => ({
  init: (...args: unknown[]) => mockInit(...args),
}));

import { LaunchDarklyFeatureFlagService } from './launchdarkly';

describe('LaunchDarklyFeatureFlagService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWaitForInitialization.mockResolvedValue(undefined);
    mockInit.mockReturnValue({
      waitForInitialization: mockWaitForInitialization,
      variation: mockVariation,
    });
  });

  it('rejects at construction time when sdkKey is missing', () => {
    expect(() => new LaunchDarklyFeatureFlagService({ sdkKey: '' })).toThrow();
  });

  it('passes offline through to the SDK init call so no network is ever contacted', () => {
    new LaunchDarklyFeatureFlagService({ sdkKey: 'sdk-key', offline: true });
    expect(mockInit).toHaveBeenCalledWith('sdk-key', expect.objectContaining({ offline: true }));
  });

  it('returns false (never throws) for an unknown flag when evaluation fails', async () => {
    mockVariation.mockRejectedValue(new Error('unknown flag'));
    const service = new LaunchDarklyFeatureFlagService({ sdkKey: 'sdk-key' });
    await expect(service.isFeatureEnabled('does-not-exist')).resolves.toBe(false);
  });

  it('falls back to placeholder identity values when no context factory is supplied', async () => {
    mockVariation.mockResolvedValue(true);
    const service = new LaunchDarklyFeatureFlagService({ sdkKey: 'sdk-key' });
    await service.isFeatureEnabled('some-flag');

    const [, context] = mockVariation.mock.calls[0];
    expect(context.user.key).toBe('User');
    expect(context.user.email).toBe('user@example.com');
    expect(context.subscription.key).toBe('Basic');
  });

  it('falls back to placeholders for claims missing from a partial context factory result', async () => {
    mockVariation.mockResolvedValue(true);
    const service = new LaunchDarklyFeatureFlagService({
      sdkKey: 'sdk-key',
      userContextFactory: () => ({ userKey: 'user-1' }),
    });
    await service.isFeatureEnabled('some-flag');

    const [, context] = mockVariation.mock.calls[0];
    expect(context.user.key).toBe('user-1');
    expect(context.user.email).toBe('user@example.com');
    expect(context.subscription.key).toBe('Basic');
  });

  it('builds the context once per instance and reuses it across calls', async () => {
    mockVariation.mockResolvedValue(true);
    const factory = jest.fn().mockReturnValue({ userKey: 'user-1', email: 'a@b.com', subscription: 'Pro' });
    const service = new LaunchDarklyFeatureFlagService({ sdkKey: 'sdk-key', userContextFactory: factory });

    await service.isFeatureEnabled('flag-a');
    await service.isFeatureEnabled('flag-b');

    expect(factory).toHaveBeenCalledTimes(1);
  });
});
