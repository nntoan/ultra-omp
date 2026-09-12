# Installation

## Bootstrap

The canonical bootstrap checks for OMP, installs it through OMP's maintained installer when needed, then runs the disposable package installer:

```sh
curl -fsSL https://nntoan.com/ultra-omp/install | bash
```

The bootstrap prefers Bun when `bunx` is available and otherwise uses `npx`. It never installs the Ultra OMP installer globally.

## Direct execution

```sh
npx @nntoan/ultra-omp
bunx @nntoan/ultra-omp
```

With no flags, an interactive terminal offers all plugins or a custom selection. The default target is the user OMP profile. Add `--local` to target the current project's OMP configuration.

## Automation

- `--yes` installs all catalog entries without prompting.
- `--only proflow,pi-reasonix` installs only the listed IDs.
- `--local` forwards project-local scope to OMP.
- `--dry-run` prints exact `omp plugin install` commands without launching OMP.
- `--help` prints the complete command reference.

Non-interactive invocations must provide `--yes` or `--only`; the installer does not silently select all in automation. Re-running is safe because OMP owns install idempotency.
