# reusable-components-node

Reusable Node.js service libraries, behaviorally ported from Promact's .NET
`nuget-packages` (`email-service`, `file-service`, `feature-flag-management`).
See `docs/specs/nuget-packages-spec.md` in the sibling `reusable-components`
repo for the full functional/technical spec these packages implement.

This is an npm workspaces monorepo with three independent packages under
`packages/`:

| Package | Providers | Spec section |
|---|---|---|
| [`@promact/email-service`](packages/email-service) | AWS SES, SendGrid, SMTP, Azure Communication Services | §1 |
| [`@promact/file-service`](packages/file-service) | AWS S3, Azure Blob Storage | §2 |
| [`@promact/feature-flag-management`](packages/feature-flag-management) | PostHog, LaunchDarkly, Unleash | §3 |

Each package exposes one provider-agnostic interface (`IEmailService`,
`IFileService<TFileModel>`, `IFeatureFlagService`); the concrete provider is
selected at wiring time via a `createXxxService(options)` factory. See each
package's own README/source for usage.

## Installation

```bash
npm install @promact/email-service
npm install @promact/file-service
npm install @promact/feature-flag-management
```

## Development

Requires Node.js 22+.

```bash
npm install              # installs and links all three workspace packages
npm run build             # tsc -p tsconfig.json in every package
npm test                  # jest, run across all three packages
npm run lint               # eslint over packages/**/*.ts
```

Every package is TypeScript, strict mode, with a Jest suite covering the
spec's §5 error-handling table (construction-time config validation,
existence-precondition checks, provider "not supported" rejections, etc.).
No real network/cloud calls are made in tests — provider SDKs are mocked.

## CI

`.github/workflows/ci.yml` runs `npm ci`, `npm run build`, `npm run lint`,
and `npm test` on every push and pull request against `master`.

## Publishing

Packages are published to npm under the `@promact` scope by
`.github/workflows/publish.yml`, which runs when a GitHub Release is published
(or manually via "Run workflow"). It builds, lints, tests, and then runs
`npm publish` for each package with provenance, using the `NPM_TOKEN` repo secret.

To release:

1. Bump the `version` of each package you changed (e.g.
   `npm version patch -w @promact/email-service`) and merge to `master`.
2. Create a GitHub Release. Versions already on npm are skipped, so only
   bumped packages are published.
