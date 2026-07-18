# Publishing

`claude-pty-web-harness` ships these public artifacts, all versioned in lockstep
with the project release (the `vX.Y.Z` git tag):

| Artifact | Registry | Source | Auth (steady state) |
| --- | --- | --- | --- |
| `@petersr/claude-pty-web-harness-protocol` | npm | `packages/protocol` | npm OIDC trusted publishing |
| `@petersr/claude-pty-web-harness-core` | npm | `packages/core` | npm OIDC trusted publishing |
| `@petersr/claude-pty-web-harness-react` | npm | `packages/react` | npm OIDC trusted publishing |
| `@petersr/claude-pty-web-harness-server` | npm | `packages/server` | npm OIDC trusted publishing |
| `claude-pty-web-harness` | PyPI | `packages/python` | PyPI OIDC trusted publishing |

The `@petersr/claude-pty-web-harness-app` package is the reference UI; it is
`private` and never published. The npm packages depend on each other, so they are
always published in dependency order: **protocol -> core -> react -> server**.

The goal is **tokenless** releases via OIDC trusted publishing, driven by
`v*.*.*` tags through [`.github/workflows/release.yml`](.github/workflows/release.yml).
The publish jobs are gated behind repo variables so the workflow is safe to land
before the registries are set up:

- `PUBLISH_NPM=1` enables the npm job.
- `PUBLISH_PYPI=1` enables the PyPI job.

(Set them under **Settings -> Secrets and variables -> Actions -> Variables**.)

## First release (one-time bootstrap)

### PyPI - tokenless from the start

PyPI supports a *pending* trusted publisher, so the very first publish can be
CI-driven with no token:

1. On PyPI: **Your projects -> Publishing -> Add a pending publisher**. Owner
   `PeterSR`, repo `claude-pty-web-harness`, workflow `release.yml`, environment
   blank. Project name `claude-pty-web-harness`.
2. Set repo variable `PUBLISH_PYPI=1`.
3. Tag and push (below). The `publish-pypi` job builds and uploads; the project
   is created on first use.

### npm - manual first publish, then trusted publishing

npm has no pending-publisher equivalent: trusted publishing must be enabled on a
package that already exists, so each package's **first** publish is done by hand
from a logged-in machine.

```sh
npm login          # or: npm whoami to confirm you're already logged in

npm ci
npm run build:libs
node scripts/version.mjs 0.1.0     # the real version; keeps all packages in lockstep

# Publish in dependency order.
for pkg in protocol core react server; do
  npm publish --access public --workspace "@petersr/claude-pty-web-harness-$pkg"
done
```

Then enable OIDC for each package so CI handles every later release:

3. For each of the four `@petersr/claude-pty-web-harness-*` packages: on
   npmjs.com open the package **Settings -> Trusted publishing -> GitHub
   Actions**, owner `PeterSR`, repo `claude-pty-web-harness`, workflow
   `release.yml`.
4. Set repo variable `PUBLISH_NPM=1`.

(Prefer a token over OIDC for the first automated run? Skip steps 3-4, add an
`NPM_TOKEN` granular automation secret, and set
`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the npm job instead. OIDC is
recommended: no long-lived secret, and `--provenance` works out of the box.)

## Every release after that

1. Set the version everywhere in one step:

   ```sh
   node scripts/version.mjs X.Y.Z
   ```

   This rewrites the `version` of the root and every `packages/*` package.json,
   bumps the internal `@petersr/claude-pty-web-harness-*` dependency ranges to
   `^X.Y.Z`, and updates `packages/python/pyproject.toml`.
2. Commit, then tag and push:

   ```sh
   git commit -am "Release vX.Y.Z"
   git tag vX.Y.Z && git push origin main --tags
   ```
3. The `release` workflow publishes everything. The PyPI job fails fast if the
   pyproject version does not equal the tag; the npm job re-runs
   `scripts/version.mjs` from the tag as a safety net before publishing.

## Local validation (no upload)

```sh
# npm: inspect the exact tarball contents for each library.
npm run build:libs
for pkg in protocol core react server; do
  npm pack --dry-run --workspace "@petersr/claude-pty-web-harness-$pkg"
done

# Python: build + metadata check.
cd packages/python
python -m build && python -m twine check dist/*
```
