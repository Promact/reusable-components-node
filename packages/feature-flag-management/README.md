# feature-flag-management

Provider-agnostic feature flag checks for Node.js/TypeScript — PostHog, LaunchDarkly, and Unleash behind one `IFeatureFlagService` interface. Behavioral port of the .NET `nuget-packages/feature-flag-management` library; see `docs/specs/nuget-packages-spec.md` §3 for the full functional spec.

## Installation

```bash
npm install @promact/feature-flag-management
```

## Usage

```ts
import { createLaunchDarklyFeatureFlagService } from '@promact/feature-flag-management';

const featureFlags = createLaunchDarklyFeatureFlagService({
  sdkKey: process.env.LAUNCHDARKLY_SDK_KEY!,
  environment: 'production',
  userContextFactory: () => ({ userKey: currentUser.id, email: currentUser.email, subscription: 'Pro' }),
});

if (await featureFlags.isFeatureEnabled('new-checkout')) {
  // ...
}
```

The other providers:

```ts
import {
  createPostHogFeatureFlagService,
  createUnleashFeatureFlagService,
} from '@promact/feature-flag-management';

const posthog = createPostHogFeatureFlagService({
  apiKey: process.env.POSTHOG_API_KEY!,
  host: 'https://us.posthog.com',
  projectId: '12345',
});

const unleash = createUnleashFeatureFlagService({
  appName: 'my-app',
  unleashApi: 'https://unleash.example.com/api',
  apiToken: process.env.UNLEASH_API_TOKEN!,
});
```

## Behavior

- `isFeatureEnabled` **never throws**: an unknown flag, a network failure, or an unreachable provider resolves to `false`. Missing required options, however, throw at construction time.
- The service only reads flags; it never creates or changes them.

## Provider notes

- **PostHog** checks the flag's global `active` state via the project's feature-flags API (`Authorization: Bearer {apiKey}`). No user context is sent, so percentage rollouts, cohorts, and multivariate flags are not evaluated. Every call is an HTTP request.
- **LaunchDarkly** evaluates locally against the SDK's cached ruleset. The user/subscription context comes from `userContextFactory`, read once per service instance; missing values default to `User` / `user@example.com` / `Basic`. Set `offline: true` to never contact LaunchDarkly (all flags evaluate to `false`).
- **Unleash** evaluates locally against the SDK's cached ruleset. `apiToken` is sent as the raw `Authorization` header (no `Bearer` prefix). `UnleashFeatureFlagService` also has `isFeatureForSubscriptionEnabled(name)`, which evaluates with a `Subscription` property from `subscriptionContextFactory` (default `Basic`). It isn't on the shared interface, so depend on the concrete class to use it.
