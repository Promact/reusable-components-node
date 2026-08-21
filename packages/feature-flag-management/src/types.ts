/**
 * Shared interface every feature-flag provider adapter implements.
 * Only ever reads flag state — no create/update/delete of flags.
 *
 * Deliberate deviation from this library's usual "fail fast" rule (see spec §0/§5):
 * an unknown flag name or an unreachable provider must resolve to `false`,
 * never throw. A flag check briefly unavailable degrading to "off" is safer
 * than taking down the caller.
 */
export interface IFeatureFlagService {
  isFeatureEnabled(featureName: string): Promise<boolean>;
}

export interface PostHogOptions {
  apiKey: string;
  host: string;
  projectId: string;
}

/**
 * Context read for a LaunchDarkly evaluation. Never constructed by the
 * caller directly — produced by an injectable factory (see UserContextFactory)
 * or defaulted to placeholders when absent.
 */
export interface LaunchDarklyUserContext {
  userKey?: string;
  email?: string;
  subscription?: string;
}

export type UserContextFactory = () => LaunchDarklyUserContext | undefined;

export interface LaunchDarklyOptions {
  sdkKey: string;
  environment?: string;
  /** When true, the client never contacts LaunchDarkly's servers; every flag evaluates to its default (false). */
  offline?: boolean;
  userContextFactory?: UserContextFactory;
}

/** Context read for an Unleash subscription-aware evaluation. */
export interface UnleashSubscriptionContext {
  userId?: string;
  subscription?: string;
}

export type SubscriptionContextFactory = () => UnleashSubscriptionContext | undefined;

export interface UnleashOptions {
  appName: string;
  unleashApi: string;
  /**
   * Sent as the raw `Authorization` header value with no "Bearer " prefix.
   * This is a deliberate, preserved difference from PostHog's own auth
   * convention (spec §3.3) — not an inconsistency to fix.
   */
  apiToken: string;
  environment?: string;
  subscriptionContextFactory?: SubscriptionContextFactory;
}
