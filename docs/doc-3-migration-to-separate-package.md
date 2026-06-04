# Extract `@nestjs/platform-bun` into a standalone repo

## Context

`packages/platform-bun` is a Bun HTTP platform adapter for NestJS. The user wants
to move it to its own repository with an independent release lifecycle and CI.

The package code itself is already cleanly decoupled — it depends on
`@nestjs/common` / `@nestjs/core` only as **peer dependencies**, uses real npm deps
(`path-to-regexp`, `tslib`), and tests via native `bun:test`. **All** coupling to
the monorepo lives in *tooling*, not source:

- `tsconfig*.json` `extends` `../tsconfig.build.json` and declares `paths` aliases +
  TypeScript project `references` to `../common` and `../core`.
- Build runs through the root `tsc -b -v packages` composite build.
- Versioning is lerna-managed (package.json has no `version`).
- Tests require the repo's `npm run build` + `move:node_modules` dance to expose
  sibling packages as compiled `.js` under `node_modules/@nestjs`.
- Compiled `.js` / `.d.ts` / `.tsbuildinfo` artifacts are committed next to sources.

Decisions (confirmed with user): **Bun-native** toolchain, **GitHub Actions** CI
with publish-on-tag, **gitignore** the build artifacts (build on publish).

## Source-level dependencies (must keep resolvable, no code change)

External npm: `path-to-regexp@8.4.2`, `tslib@2.8.1`, `stream` (node builtin).
Peer (NestJS): deep imports that must resolve against the *published* packages —

- `@nestjs/common`, `@nestjs/common/interfaces`, `@nestjs/common/utils/shared.utils`
- `@nestjs/core/adapters/http-adapter`, `@nestjs/core/router/legacy-route-converter`

These deep subpaths already work against published NestJS packages (Nest publishes
flattened dist at package root), so source files need **no edits**.

## Target repo layout

```
platform-bun/                 # new repo root (current package contents move up)
├── adapters/                 # *.ts only (drop committed .js/.d.ts)
├── interfaces/               # *.ts only
├── test/
├── docs/
├── index.ts
├── package.json
├── tsconfig.json             # standalone, no extends/paths/references
├── bunfig.toml               # optional bun test config
├── .gitignore
├── LICENSE
├── Readme.md
└── .github/workflows/
    ├── ci.yml
    └── release.yml
```

## Changes

### 1. `tsconfig.json` — make standalone

Replace both `tsconfig.json` and `tsconfig.build.json` with a single self-contained
config. Inline the settings currently inherited from `packages/tsconfig.build.json`
(composite/declaration/decorators/target ES2021/strict, etc.), **remove**:

- `extends: ../tsconfig.build.json`
- `paths` aliases for `@nestjs/common` / `@nestjs/core`
- project `references` to `../common` / `../core`

Keep `types: ["node", "bun"]`, set `outDir: ./dist`, `rootDir: .`, exclude
`test/**`, `dist`, `node_modules`. Resolve `@nestjs/*` via plain `node_modules`.

### 2. `package.json` — independent lifecycle

- Add `"version"` (start `0.1.0` — see Open question) since lerna no longer manages it.
- Update `repository.url` / `repository.directory` to the new repo (drop `directory`).
- Add `"main": "dist/index.js"`, `"types": "dist/index.d.ts"`, `"files": ["dist"]`.
- Add `devDependencies`: `typescript`, `@nestjs/common`, `@nestjs/core` (dev copies so
  builds/tests resolve the peers locally), keep `@types/bun`.
- Add scripts (Bun-native):
  - `"build": "bun run clean && tsc -p tsconfig.json"` (tsc for correct `.d.ts`)
  - `"clean": "rm -rf dist"`
  - `"test": "bun test"`
  - `"prepublishOnly": "bun run build"`
- Keep `peerDependencies` as-is.

### 3. Tests — drop the monorepo `move:node_modules` requirement

With dev copies of `@nestjs/common`/`@nestjs/core` installed in `node_modules`, the
README's build + `move:node_modules` step is unnecessary. Update `test/` only if any
import assumes monorepo layout (none found — tests import `@nestjs/common`, `bun:test`,
and local relative paths). Add `bunfig.toml` if test globbing/setup needs tuning.
Update Readme "Running the unit tests" section to just `bun install && bun test`.

### 4. Remove committed build artifacts

Delete tracked `*.js`, `*.d.ts`, `tsconfig.build.tsbuildinfo` (keep `index.d.ts` only
if intentionally hand-authored — verify; otherwise it's generated, drop it). Add
`.gitignore`: `node_modules/`, `dist/`, `*.tsbuildinfo`, `bun.lockb` (keep or ignore
per preference).

### 5. Add repo metadata

- `LICENSE` (MIT — copy from monorepo root LICENSE).
- README tweaks: install/test/build instructions for standalone, badge for CI.

### 6. CI — `.github/workflows/`

- `ci.yml`: on push/PR → `oven-sh/setup-bun`, `bun install`, `bun run build`,
  `bun test`. Matrix on a couple Bun versions if desired.
- `release.yml`: on tag `v*` → setup-bun, build, `npm publish --access public`
  using `NPM_TOKEN` secret (Bun can publish, but `npm publish` is the safe path for
  provenance). Gate on `ci` passing.

## Migration mechanics (when executing)

1. Create new repo dir; `git` init (optionally `git filter-repo`/`subtree split` to
   preserve `packages/platform-bun` history — see Open question).
2. Move package contents to repo root, apply changes 1–6.
3. `bun install` → `bun run build` → `bun test` to validate locally.
4. In the **monorepo**, after extraction: remove `packages/platform-bun`, its entry
   from `packages/tsconfig.json` references, and the `@nestjs/platform-bun` path
   aliases in root `tsconfig.json` (and any lerna/workspace listing). *(Optional —
   only if the user wants it removed from the monorepo now.)*

## Verification

```bash
cd platform-bun
bun install
bun run build          # tsc emits dist/index.js + dist/index.d.ts, no path-alias errors
bun test               # all bun-adapter.test.ts cases pass without move:node_modules
node -e "require('./dist/index.js')"   # CJS entry loads
```

Confirm `dist/` resolves `@nestjs/core/adapters/http-adapter` etc. against installed
NestJS packages (build succeeds = subpaths resolve). Push a branch and confirm
`ci.yml` is green; dry-run publish with `npm publish --dry-run`.

## Open questions (low-risk defaults chosen)

- **Starting version**: defaulting to `0.1.0`. Could mirror current Nest `11.x` to
  signal peer compatibility instead.
- **History preservation**: plan assumes a fresh-copy repo; switch to
  `git subtree split` / `git filter-repo` if commit history matters.
- **Remove from monorepo now?**: step 4 of migration is optional; left out by default.

------------------------------------------------------------------------------------------

Done. `packages/platform-bun` now self-contained, ready to move to its own repo. Verified:
`bun run build` emits `dist/`, `bun test` → **21 pass / 0 fail**, CJS entry loads with
correct exports.

## What changed

**`tsconfig.json`** — collapsed the two configs into one standalone file. Inlined the
settings previously inherited from `packages/tsconfig.build.json`. Removed `extends`, the
`@nestjs/common`/`@nestjs/core` path aliases, and project `references` to `../common`/
`../core`. `@nestjs/*` now resolves via plain `node_modules`. Deleted
`tsconfig.build.json` + `tsconfig.build.tsbuildinfo`.

**`package.json`** — added `version: 0.1.0`, `main`/`types`/`files`, repo url pointed at a
standalone `nestjs/platform-bun`. Dev copies of `@nestjs/common`/`@nestjs/core` +
`typescript` so build/test resolve peers locally. Bun-native scripts: `build` (`tsc`),
`clean`, `test` (`bun test`), `prepublishOnly`. Peer deps unchanged.

**Removed monorepo coupling** — deleted all committed `.js`/`.d.ts` artifacts (were
untracked); added `.gitignore` (`dist/`, `node_modules/`, `*.tsbuildinfo`). The README
`move:node_modules` dance is gone — now just `bun install && bun test`.

**Metadata** — `LICENSE` (MIT, copied from root), `bunfig.toml`.

**CI** — `.github/workflows/ci.yml` (setup-bun → install → build → test, Bun version
matrix) and `release.yml` (publish on `v*` tag via `npm publish --provenance`, needs
`NPM_TOKEN` secret).

**No source edits.** The deep peer imports (`@nestjs/common/utils/shared.utils`,
`@nestjs/core/adapters/http-adapter`, `@nestjs/core/router/legacy-route-converter`)
resolve fine against published packages — proven by the successful tsc build.

## Note / leftover decisions

- **Starting version `0.1.0`** — say the word if you'd rather mirror Nest `11.x`.
- **History**: this is an in-place restructure. To carry git history into the new repo,
  use `git subtree split --prefix=packages/platform-bun` (or `git filter-repo`) instead of
  a plain copy.
- **Monorepo cleanup** (optional, not done): once moved, remove `packages/platform-bun`
  from `packages/tsconfig.json` references and the `@nestjs/platform-bun` aliases in root
  `tsconfig.json`.
- Before publishing, claim/confirm the `nestjs/platform-bun` GitHub repo + npm org
  access — `repository.url` is a placeholder guess.

Didn't commit — flagging that `git status` shows these changes already staged in the
index (some hook, not me). Want me to commit, or run the subtree split into a fresh repo?
