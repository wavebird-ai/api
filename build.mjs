import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "dist");
await mkdir(dist, { recursive: true });
for (const file of ["generation.js", "browser.js", "server.js", "server.d.ts", "browser.d.ts"]) {
  await copyFile(resolve(root, "src", file), resolve(dist, file));
}
