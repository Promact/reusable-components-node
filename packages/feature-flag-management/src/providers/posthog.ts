import { IFeatureFlagService, PostHogOptions } from '../types';

interface PostHogFeatureFlag {
  key: string;
  active: boolean;
}

interface PostHogFeatureFlagsResponse {
  results: PostHogFeatureFlag[];
}

/**
 * Global on/off check against PostHog's "list feature flags" endpoint —
 * NOT a per-user rollout evaluation. No distinct-id/context is sent, so
 * percentage rollouts, cohort targeting, and multivariate flags are not
 * reflected here (spec §3.4.2). This is a genuine capability gap versus
 * LaunchDarkly/Unleash, preserved deliberately.
 */
export class PostHogFeatureFlagService implements IFeatureFlagService {
  constructor(private readonly options: PostHogOptions) {
    if (!options.apiKey) {
      throw new Error('PostHog feature flag service requires "apiKey"');
    }
    if (!options.host) {
      throw new Error('PostHog feature flag service requires "host"');
    }
    if (!options.projectId) {
      throw new Error('PostHog feature flag service requires "projectId"');
    }
  }

  async isFeatureEnabled(featureName: string): Promise<boolean> {
    try {
      const url = new URL(
        `api/projects/${this.options.projectId}/feature_flags/`,
        this.options.host.endsWith('/') ? this.options.host : `${this.options.host}/`,
      );
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
        },
      });

      if (!response.ok) {
        return false;
      }

      const body = (await response.json()) as PostHogFeatureFlagsResponse;
      const flag = body.results?.find((f) => f.key === featureName);
      return flag?.active ?? false;
    } catch {
      return false;
    }
  }
}
