# Release runbook

This repository publishes four public npm packages:

- `@ultra-omp/proflow`
- `@ultra-omp/pi-reasonix`
- `@ultra-omp/pi-deepseek-cache`
- `@nntoan/ultra-omp`

The root package is private and is never published.

## Initial publication

Run from a clean checkout of `main` with Bun 1.4 and Node 22 available:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run pack:check
```

Authenticate to npm using an account or organization member that can publish all four scopes. Prefer an npm access token stored in the local credential store; never put a token in the repository or command history.

```sh
npm login
npm whoami
```

Publish each package once, in this order:

```sh
npm publish --workspace packages/proflow --access public
npm publish --workspace packages/pi-reasonix --access public
npm publish --workspace packages/pi-deepseek-cache --access public
npm publish --workspace packages/installer --access public
```

Confirm each package is visible before configuring automation:

```sh
npm view @ultra-omp/proflow version
npm view @ultra-omp/pi-reasonix version
npm view @ultra-omp/pi-deepseek-cache version
npm view @nntoan/ultra-omp version
```

The old `@ultra-omp/agent-skills` name is not the published package name after this migration. Update consumers to `@ultra-omp/proflow` and installer selections to `proflow`.

## Configure npm trusted publishing

The release workflow uses GitHub Actions OIDC and `npm publish --provenance`; it does not use a long-lived `NPM_TOKEN`.

For each package on npm, open **Package settings → Trusted publishing** and add:

- Provider: GitHub Actions
- Organization/user: `nntoan`
- Repository: `ultra-omp`
- Workflow filename: `release-please.yml`
- Environment: empty

Keep repository Actions permissions set to read/write workflow permissions so Release Please can create or update its release pull request. The workflow also requires `id-token: write` for npm provenance.

After configuring all four packages, perform a future release through the normal workflow and verify the publish job before relying on it for production releases.

## Future releases

1. Create a conventional commit on a branch and open a pull request.
2. Wait for CI. It runs frozen installation, checks, tests, documentation build, and package dry-runs.
3. Merge the pull request into `main`.
4. Release Please analyzes the merged commits and opens or updates a release pull request.
5. Merge the Release Please pull request. It updates package versions, changelog entries, and the release manifest.
6. The `publish` job runs only when Release Please reports released package paths. It checks the repository again, configures npm for the registry, and publishes each released package with public access and provenance.
7. Verify the GitHub release, npm versions, and package tarball contents.

Use scoped package paths in commit changes so Release Please can identify the component. The configured components are `proflow`, `pi-reasonix`, `pi-deepseek-cache`, and `ultra-omp`.

## Release verification

```sh
gh run list --workflow release-please.yml --limit 5
npm view @ultra-omp/proflow version
npm view @ultra-omp/pi-reasonix version
npm view @ultra-omp/pi-deepseek-cache version
npm view @nntoan/ultra-omp version
```

For a package release, inspect the published file list without installing it into the workspace:

```sh
npm pack @ultra-omp/proflow --dry-run
```

If publishing fails, do not rerun with a different authentication mechanism without recording the cause. Check the package trusted-publisher configuration, workflow filename, repository owner, `id-token: write`, and whether the target version already exists. Release Please is idempotent; fix the cause and rerun the failed workflow.

## Pages deployment

The documentation is a project site at `https://nntoan.com/ultra-omp/`. Do not configure a repository CNAME or a custom domain: the apex domain is already bound to another GitHub Pages repository.

The Pages workflow builds with `bun run docs:build`, uploads the VitePress artifact, and deploys through the `github-pages` environment. Its VitePress base is `/ultra-omp/`, and the bootstrap endpoint is:

```sh
curl -fsSL https://nntoan.com/ultra-omp/install | bash
```

Verify both the site and installer endpoint after documentation changes.
