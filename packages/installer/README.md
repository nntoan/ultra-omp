# Ultra OMP installer

`@nntoan/ultra-omp` is a disposable interactive installer for the published Ultra OMP plugins. Run it without a global install:

```sh
npx @nntoan/ultra-omp
bunx @nntoan/ultra-omp
```

The picker starts with all catalog entries selected: `agent-skills`, `pi-reasonix`, and `pi-deepseek-cache`. The default target is the user OMP profile. Add `--local` to install into the current project configuration instead.

In automation, use `--yes` to install every plugin or `--only agent-skills,pi-reasonix` to select specific IDs. `--dry-run` prints the exact OMP commands without launching them. Re-running delegates idempotency and configuration ownership to OMP.

After npx or bunx exits, only the selected OMP plugins persist; the installer itself is not a persistent global CLI.
