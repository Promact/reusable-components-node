export {
  IFeatureFlagService,
  PostHogOptions,
  LaunchDarklyOptions,
  LaunchDarklyUserContext,
  UserContextFactory,
  UnleashOptions,
  UnleashSubscriptionContext,
  SubscriptionContextFactory,
} from './types';

export { PostHogFeatureFlagService } from './providers/posthog';
export { LaunchDarklyFeatureFlagService } from './providers/launchdarkly';
export { UnleashFeatureFlagService } from './providers/unleash';

import { PostHogFeatureFlagService } from './providers/posthog';
import { LaunchDarklyFeatureFlagService } from './providers/launchdarkly';
import { UnleashFeatureFlagService } from './providers/unleash';
import { PostHogOptions, LaunchDarklyOptions, UnleashOptions } from './types';

/** Constructs the client eagerly and validates required options at construction time (spec §3.5). */
export function createPostHogFeatureFlagService(options: PostHogOptions): PostHogFeatureFlagService {
  return new PostHogFeatureFlagService(options);
}

export function createLaunchDarklyFeatureFlagService(
  options: LaunchDarklyOptions,
): LaunchDarklyFeatureFlagService {
  return new LaunchDarklyFeatureFlagService(options);
}

export function createUnleashFeatureFlagService(options: UnleashOptions): UnleashFeatureFlagService {
  return new UnleashFeatureFlagService(options);
}
