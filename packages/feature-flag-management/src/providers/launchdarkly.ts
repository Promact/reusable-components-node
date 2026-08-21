import * as LaunchDarkly from '@launchdarkly/node-server-sdk';
import {
  IFeatureFlagService,
  LaunchDarklyOptions,
  LaunchDarklyUserContext,
} from '../types';

const PLACEHOLDER_NAME = 'User';
const PLACEHOLDER_EMAIL = 'user@example.com';
const PLACEHOLDER_SUBSCRIPTION = 'Basic';

/**
 * Evaluates against a locally cached ruleset synced from LaunchDarkly's
 * servers (or never synced, when `offline` is true) — no network round-trip
 * per call (spec §3.4.1). Exposed as async for interface parity only.
 */
export class LaunchDarklyFeatureFlagService implements IFeatureFlagService {
  private readonly client: LaunchDarkly.LDClient;
  private readonly context: LaunchDarkly.LDContext;
  private readonly initialized: Promise<void>;

  constructor(private readonly options: LaunchDarklyOptions) {
    if (!options.sdkKey) {
      throw new Error('LaunchDarkly feature flag service requires "sdkKey"');
    }

    this.client = LaunchDarkly.init(options.sdkKey, { offline: options.offline ?? false });
    this.initialized = this.client.waitForInitialization().then(
      () => undefined,
      () => undefined,
    );
    this.context = this.buildContext();
  }

  private buildContext(): LaunchDarkly.LDContext {
    // Read once per adapter instance, then reused for every isFeatureEnabled call.
    const raw: LaunchDarklyUserContext = this.options.userContextFactory?.() ?? {};

    const userKey = raw.userKey ?? PLACEHOLDER_NAME;
    const email = raw.email ?? PLACEHOLDER_EMAIL;
    const subscription = raw.subscription ?? PLACEHOLDER_SUBSCRIPTION;

    return {
      kind: 'multi',
      user: {
        kind: 'user',
        key: userKey,
        email,
        environment: this.options.environment ?? '',
      },
      subscription: {
        kind: 'Subscription',
        key: subscription,
      },
    } as LaunchDarkly.LDContext;
  }

  async isFeatureEnabled(featureName: string): Promise<boolean> {
    await this.initialized;
    try {
      return await this.client.variation(featureName, this.context, false);
    } catch {
      return false;
    }
  }
}
