# Publishing @maw/sdk

## One-time setup (run once, not in CI)

### 1. Claim the `@maw` npm scope

```bash
npm login  # authenticate as neo-oracle
npm org create maw
```

If `maw` scope is already taken on npm, use `@maw-sdk` as fallback and update `name` in `package.json`.

### 2. Set the NPM_TOKEN secret

Generate a granular access token on npmjs.com (Automation type, scoped to `@maw/sdk`), then:

```bash
gh secret set NPM_TOKEN --repo Soul-Brews-Studio/maw-js
# paste token at prompt
```

## Publishing a new version

1. Update `version` in `packages/sdk/package.json`
2. Commit: `git commit -m "sdk: bump to X.Y.Z"`
3. Tag and push:
   ```bash
   git tag sdk-vX.Y.Z
   git push origin sdk-vX.Y.Z
   ```
4. GitHub Actions workflow `publish-sdk.yml` triggers automatically.
5. Verify: `npm view @maw/sdk`

## Rollback / unpublish window

npm allows unpublish within **72 hours** of publish:

```bash
npm unpublish @maw/sdk@X.Y.Z
```

After 72 hours, deprecate instead:

```bash
npm deprecate @maw/sdk@X.Y.Z "use X.Y.Z+1"
```

## Phase B graduation (see #340)

Alpha releases (`1.0.0-alpha.*`) ship types-only. Phase B ships runtime + types together and promotes to a stable `1.0.0` release. See `DECISION-339.md` for rationale.
