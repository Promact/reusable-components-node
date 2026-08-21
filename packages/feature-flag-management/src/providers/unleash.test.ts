const mockIsEnabled = jest.fn();
const mockStartUnleash = jest.fn();

jest.mock('unleash-client', () => ({
  startUnleash: (...args: unknown[]) => mockStartUnleash(...args),
}));

import { UnleashFeatureFlagService } from './unleash';

describe('UnleashFeatureFlagService', () => {
  const options = { appName: 'my-app', unleashApi: 'https://unleash.example.com', apiToken: 'token123' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockStartUnleash.mockResolvedValue({ isEnabled: mockIsEnabled });
  });

  it('rejects at construction time when appName is missing', () => {
    expect(() => new UnleashFeatureFlagService({ ...options, appName: '' })).toThrow();
  });

  it('rejects at construction time when unleashApi is missing', () => {
    expect(() => new UnleashFeatureFlagService({ ...options, unleashApi: '' })).toThrow();
  });

  it('rejects at construction time when apiToken is missing', () => {
    expect(() => new UnleashFeatureFlagService({ ...options, apiToken: '' })).toThrow();
  });

  it('sends the Authorization header with no Bearer prefix', () => {
    new UnleashFeatureFlagService(options);
    expect(mockStartUnleash).toHaveBeenCalledWith(
      expect.objectContaining({ customHeaders: { Authorization: 'token123' } }),
    );
  });

  it('isFeatureEnabled evaluates context-free and returns false (never throws) on failure', async () => {
    mockIsEnabled.mockImplementation(() => {
      throw new Error('boom');
    });
    const service = new UnleashFeatureFlagService(options);
    await expect(service.isFeatureEnabled('some-flag')).resolves.toBe(false);
  });

  it('isFeatureEnabled returns the underlying cached-ruleset result', async () => {
    mockIsEnabled.mockReturnValue(true);
    const service = new UnleashFeatureFlagService(options);
    await expect(service.isFeatureEnabled('some-flag')).resolves.toBe(true);
    expect(mockIsEnabled).toHaveBeenCalledWith('some-flag');
  });

  it('isFeatureForSubscriptionEnabled is a distinct method not on the shared interface, evaluated with a Subscription context', async () => {
    mockIsEnabled.mockReturnValue(true);
    const service = new UnleashFeatureFlagService(options);
    await service.isFeatureForSubscriptionEnabled('sub-flag');

    expect(mockIsEnabled).toHaveBeenCalledWith(
      'sub-flag',
      expect.objectContaining({ properties: expect.objectContaining({ Subscription: 'Basic' }) }),
    );
  });

  it('isFeatureForSubscriptionEnabled returns false (never throws) on failure', async () => {
    mockIsEnabled.mockImplementation(() => {
      throw new Error('boom');
    });
    const service = new UnleashFeatureFlagService(options);
    await expect(service.isFeatureForSubscriptionEnabled('sub-flag')).resolves.toBe(false);
  });
});
