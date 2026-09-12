# Ultra OMP

Ultra OMP is a native plugin suite for OMP, with an ephemeral installer that keeps OMP responsible for plugin configuration.

## Install the suite

```sh
curl -fsSL https://nntoan.com/ultra-omp/install | bash
```

The installer selects all published plugins by default. See [Installation](/installation) for project-local installs and automation flags.

## Why Ultra OMP

- Native OMP extensions published as independent packages.
- A disposable `npx`/`bunx` installer; no global Ultra OMP CLI.
- A generated catalog sourced from the repository workspace manifests.

Browse the [Plugins](/plugins) and [Proflow](/proflow). See the [release runbook](/release-runbook) for npm publication and CI/CD operations.
