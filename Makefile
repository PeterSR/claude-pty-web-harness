# Thin wrappers over the npm workspaces and the Python package. The npm scripts
# and `uv`/`pytest` are the source of truth; these targets just mirror CI.
.PHONY: install build typecheck test test-js test-py ci clean

install:
	npm install
	cd packages/python && uv sync --extra dev 2>/dev/null || uv pip install -e .

build:
	npm run build:libs

typecheck:
	npm run typecheck

test: test-js test-py

test-js:
	npm run test --workspace @petersr/claude-pty-web-harness-core

test-py:
	cd packages/python && uv run python -m unittest discover -s tests

# Mirror the checks the CI workflow runs.
ci: typecheck test

clean:
	rm -rf packages/*/dist packages/python/dist
	find packages/python -name __pycache__ -type d -prune -exec rm -rf {} +
