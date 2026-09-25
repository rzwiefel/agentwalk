# Contributor instructions

## Product and documentation

- Use **Agentwalk** as the product name. Live Activity is the fresh-install
  default and primary view; Architecture remains supported as a secondary mode.
  Architecture-only analysis controls are hidden in Live Activity, not removed.
- Keep `README.md` focused on user setup and behavior. Use `PROJECT_BRIEF.md`
  for the durable implementation handoff, `docs/` for design and event
  contracts, and the parser/producer READMEs for adapter-specific setup.
- Preserve existing package IDs, source namespaces, environment-variable names,
  and runtime/extension paths verbatim until their code owner confirms a
  replacement. Verify identifiers against the implementation; do not invent
  names.
- Keep examples synthetic. Do not add personal checkout paths, credentials,
  real session payloads, or private target-repository details to tracked files.
- Do not infer license or CI status; describe only artifacts that are actually
  present and selected.

## Setup and checks

The root Vite viewer requires Node.js `^20.19.0 || >=22.12.0`. Install root
dependencies with `npm install`; adapter-specific runtime requirements are
documented with each adapter.

For the observer-first Live Activity, start Agentwalk with:

```sh
npm run dev:live
```

No repository path is required; Live Activity observes all workspaces. To
preselect a default repository for Architecture analysis, optionally run
`npm run dev:live -- /path/to/repository`. For separate terminals, start the
API with `npm run serve` and the viewer with `npm run dev`; add
`--repo-root /path/to/repository` to the API command only when you want a
default repository. Running Vite alone does not provide the API-backed Analyze
flow.

Run `npm run check` for the integrated checks and `npm run build` to validate
the production Vite bundle. Use the smallest relevant adapter-specific checks
when changing parser or producer behavior.

## Change boundaries

Keep documentation-only work in documentation files. Changes to application
source, tests, package manifests, lockfiles, runtime configuration, and
code-owned file paths belong to their respective implementation owners.
Update directly related documentation when behavior or supported setup changes.
