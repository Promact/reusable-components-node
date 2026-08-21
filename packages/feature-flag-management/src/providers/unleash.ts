import { Unleash, startUnleash } from 'unleash-client';
import {
  IFeatureFlagService,
  UnleashOptions,
  UnleashSubscriptionContext,
} from '../types';

const PLACEHOLDER_SUBSCRIPTION = 'Basic';

/**
 * `isFeatureEnabled` is the only method on the shared IFeatureFlagService
 * interface. `isFeatureForSubscriptionEnabled` is intentionally NOT part of
 * that interface (spec §3.1/§3.4.3) — no other provider has an equivalent
 * subscription-level concept. Callers who need it must depend on this
 * concrete class directly.
 */
export class UnleashFeatureFlagService implements IFeatureFlagService {
  private client: Unleash | undefined;
  private readonly ready: Promise<Unleash>;

  constructor(private readonly options: UnleashOptions) {
    if (!options.appName) {
      throw new Error('Unleash feature flag service requires "appName"');
    }
    if (!options.unleashApi) {
      throw new Error('Unleash feature flag service requires "unleashApi"');
    }
    if (!options.apiToken) {
      throw new Error('Unleash feature flag service requires "apiToken"');
    }

    this.ready = startUnleash({
      appName: options.appName,
      url: options.unleashApi,
      // No "Bearer " prefix — Unleash's own auth convention, deliberately
      // different from PostHog's (spec §3.3).
      customHeaders: { Authorization: options.apiToken },
    }).then((client) => {
      this.client = client;
      return client;
    });
  }

  async isFeatureEnabled(featureName: string): Promise<boolean> {
    try {
      const client = this.client ?? (await this.ready);
      return client.isEnabled(featureName);
    } catch {
      return false;
    }
  }

  async isFeatureForSubscriptionEnabled(featureName: string): Promise<boolean> {
    try {
      const client = this.client ?? (await this.ready);
      const raw: UnleashSubscriptionContext = this.options.subscriptionContextFactory?.() ?? {};

      const subscription = raw.subscription ?? PLACEHOLDER_SUBSCRIPTION;

      return client.isEnabled(featureName, {
        userId: raw.userId,
        appName: this.options.appName,
        environment: this.options.environment ?? '',
        properties: {
          Subscription: subscription,
        },
      });
    } catch {
      return false;
    }
  }
}
