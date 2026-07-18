#!/usr/bin/env node
// Set every package in the monorepo to one version, in lockstep. Rewrites the
// `version` of the root and each packages/* package.json, bumps any internal
// `@petersr/claude-pty-web-harness-*` dependency ranges to `^<version>` (so a
// published package pins its siblings correctly), and updates the Python
// pyproject.toml `version`. Run before tagging a release:
//
//   node scripts/version.mjs 0.2.0
//
// Idempotent, so CI can re-run it from the tag as a safety net.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`usage: node scripts/version.mjs <x.y.z>  (got: ${version ?? "nothing"})`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL = /^@petersr\/claude-pty-web-harness-/;

function bumpPackageJson(path) {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (INTERNAL.test(name)) deps[name] = `^${version}`;
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${pkg.name}@${version}`);
}

// Root + every packages/*/package.json.
const targets = [join(root, "package.json")];
const pkgsDir = join(root, "packages");
for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const p = join(pkgsDir, entry.name, "package.json");
  if (existsSync(p)) targets.push(p);
}

console.log(`Setting version ${version}:`);
for (const p of targets) bumpPackageJson(p);

// Python pyproject.toml: the first top-level `version = "..."` under [project].
const pyproject = join(pkgsDir, "python", "pyproject.toml");
if (existsSync(pyproject)) {
  const before = readFileSync(pyproject, "utf8");
  const re = /^version = "[^"]*"/m;
  if (!re.test(before)) {
    console.error("  WARNING: no version line found in pyproject.toml");
  } else {
    writeFileSync(pyproject, before.replace(re, `version = "${version}"`));
    console.log(`  claude-pty-web-harness (python)@${version}`);
  }
}
