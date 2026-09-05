# Plugins

The installer catalog is generated from each leaf workspace manifest with an `omp.extensions` entry. It currently contains:

- `agent-skills` — `@ultra-omp/agent-skills`: Native OMP engineering workflow skills, lifecycle commands, and personas.
- `pi-deepseek-cache` — `@ultra-omp/pi-deepseek-cache`: DeepSeek prefix cache optimization for OMP.
- `pi-reasonix` — `@ultra-omp/pi-reasonix`: DeepSeek-native optimizations for OMP.

Install an individual package directly through OMP:

```sh
omp plugin install @ultra-omp/agent-skills
omp plugin install @ultra-omp/pi-deepseek-cache
omp plugin install @ultra-omp/pi-reasonix
```

The generated catalog is the source of truth for installer selection; package names are not maintained in a second installer list.
