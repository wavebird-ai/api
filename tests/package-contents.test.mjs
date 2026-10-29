import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;

test("packed package contains its advertised build inputs and prebuilt exports", { skip: !npmCli }, () => {
  const packed = spawnSync(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--ignore-scripts", "--json"],
    { cwd: root, encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.error?.message);
  const [{ files }] = JSON.parse(packed.stdout);
  const names = new Set(files.map(({ path }) => path));
  for (const path of [
    "build.mjs",
    "src/generation.js",
    "src/browser.js",
    "src/server.js",
    "src/server.d.ts",
    "src/browser.d.ts",
    "dist/generation.js",
    "dist/browser.js",
    "dist/server.js",
    "dist/server.d.ts",
    "dist/browser.d.ts",
  ]) {
    assert.ok(names.has(path), `missing from published package: ${path}`);
  }
});
