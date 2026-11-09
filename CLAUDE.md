# CLAUDE.md

npm-workspaces monorepo of `@promact/*` TypeScript packages under `packages/`. See `README.md`
for build/test/publish. The RAG work is specified in `docs/specs/rag-service-spec.md`, and its
progress is tracked in `docs/specs/rag-progress.md`.

## Conventions (match the existing packages)

- Node 22+, TypeScript strict (`tsconfig.base.json`), CommonJS output, `tsc -p tsconfig.json`.
- Each package: `package.json`, `tsconfig.json` (extends base, `rootDir: src`, excludes
  `*.test.ts`), `jest.config.js` (`displayName`, `ts-jest`, `src/**/*.test.ts`), `README.md`,
  `src/index.ts`. Copy `packages/file-service` as the template.
- Tests sit next to source as `*.test.ts`. No real network calls in tests.
- Wiring is via `createXxx(options)` factories that validate eagerly and throw on bad config.
- `npm run lint` must pass (ESLint, `@typescript-eslint/recommended`; unused args prefixed `_`).

## Rules for unattended RAG build runs

- Work **only** on branch `feat/rag-core`. Never push to `master`, never merge, never force-push,
  never run `npm publish` / `npm stage publish`, never change `.github/workflows/publish.yml`.
- New RAG packages are `"private": true` until a human decides to release them.
- Don't add a runtime dependency that isn't in spec §4–§5 or doesn't have a permissive licence
  (MIT / Apache-2.0 / BSD / ISC). Check with `npm view <pkg> version license` before adding.
- Read `docs/specs/rag-progress.md` first. Read only the spec sections it points to for the
  current item; don't read the whole spec.
- After each item: `npm run build && npm run lint && npx jest packages/rag-core` must pass, then
  commit (one commit per item) and update `docs/specs/rag-progress.md`.
- If a check still fails after two fix attempts, or the spec is ambiguous, record it under
  "Blocked / questions" in the progress file and move to the next independent item or stop.
  Never weaken a test or a security rule to make it pass.
