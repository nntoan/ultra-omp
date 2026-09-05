# Ultra OMP

Ultra OMP is a native [OMP](https://omp.sh) extension suite for engineering workflows, DeepSeek-oriented reasoning, and prefix-cache optimization.

## Install

Run the disposable interactive installer without installing an Ultra OMP CLI globally:

```sh
npx @nntoan/ultra-omp
# or
bunx @nntoan/ultra-omp
```

The installer selects all published plugins by default. Use `--local` for project-scoped configuration, `--yes` for non-interactive installation, `--only <id,id>` for a subset, or `--dry-run` to print the delegated OMP commands.

The canonical bootstrap is:

```sh
curl -fsSL https://ultra-omp.nntoan.com/install | bash
```

## Packages

- [`@ultra-omp/agent-skills`](packages/agent-skills) — engineering workflow skills, lifecycle commands, and personas.
- [`@ultra-omp/pi-reasonix`](packages/pi-reasonix) — DeepSeek-native prefix stabilization, tool-call repair, and cost control.
- [`@ultra-omp/pi-deepseek-cache`](packages/pi-deepseek-cache) — DeepSeek prefix-cache optimization and telemetry.
- [`@nntoan/ultra-omp`](packages/installer) — disposable interactive installer for the three OMP extensions.

The installer catalog is generated from the workspace manifests; plugin package names are not maintained in a second list.

## Documentation

The documentation site is published at [ultra-omp.nntoan.com](https://ultra-omp.nntoan.com/).

## Credits

Ultra OMP's packaging, OMP integration, installer, and documentation are maintained by [nntoan](https://github.com/nntoan).

The project also credits the original authors whose work the published extensions are based on:

- **TheTrebor and the Reasonix contributors** for the DeepSeek-native reasoning, prefix-cache, tool-call repair, and cost-control architecture in [`pi-reasonix`](https://github.com/TheTrebor/pi-reasonix).
- **rohaquinlop** for the DeepSeek prefix-cache implementation and telemetry in [`pi-deepseek-cache`](https://github.com/rohaquinlop/pi-deepseek-cache).

See each package README and license for package-specific attribution and terms. All packages are distributed under the MIT License.
