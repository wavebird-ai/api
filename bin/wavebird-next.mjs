#!/usr/bin/env node
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: wavebird-next init --lang js|ts --root <existing Next.js project> [--app-dir app|src/app]";

function options(argv) {
  if (argv[0] !== "init") throw new Error(usage);
  const out = { appDir: "app" };
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    const field = key === "--app-dir" ? "appDir" : key.slice(2);
    if (!value || !["--lang", "--root", "--app-dir"].includes(key) || (field !== "appDir" && out[field] !== undefined)) throw new Error(usage);
    if (key === "--app-dir") out.appDir = value;
    else out[key.slice(2)] = value;
  }
  if (!["js", "ts"].includes(out.lang) || !out.root || !["app", "src/app"].includes(out.appDir)) throw new Error(usage);
  return out;
}

export async function plan(argv) {
  const { lang, root, appDir } = options(argv);
  const projectRoot = resolve(root);
  await access(projectRoot, constants.R_OK | constants.W_OK);
  const appPath = resolve(projectRoot, appDir);
  await access(appPath, constants.R_OK);
  const base = dirname(appPath);
  const ext = lang === "ts" ? "ts" : "js";
  const componentExt = lang === "ts" ? "tsx" : "jsx";
  const example = resolve(packageRoot, "examples", `next-${lang}`);
  const files = [
    [join(example, "lib", `publisher.${ext}`), join(base, "lib", `publisher.${ext}`)],
    [join(example, "lib", `auth.${ext}`), join(base, "lib", `auth.${ext}`)],
    [resolve(packageRoot, "templates", `model.${ext}`), join(base, "lib", `model.${ext}`)],
    [join(example, "app", "api", "generate", `route.${ext}`), join(appPath, "api", "generate", `route.${ext}`)],
    [join(example, "app", "api", "sponsor-slot", `route.${ext}`), join(appPath, "api", "sponsor-slot", `route.${ext}`)],
    [join(example, "app", "api", "sponsor-consent", `route.${ext}`), join(appPath, "api", "sponsor-consent", `route.${ext}`)],
    [resolve(packageRoot, "templates", `WavebirdPlacement.${componentExt}`), join(base, "components", `WavebirdPlacement.${componentExt}`)],
    [resolve(packageRoot, "templates", "NEXT-SETUP.md"), join(projectRoot, "WAVEBIRD-SETUP.md")]
  ];
  for (const [source, dest] of files) {
    await access(source, constants.R_OK);
    try { await access(dest); throw new Error(`Refusing to overwrite ${dest}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { lang, projectRoot, appDir, files };
}

export async function install(argv) {
  const result = await plan(argv);
  for (const [source, dest] of result.files) {
    await mkdir(dirname(dest), { recursive: true });
    if (source.endsWith("NEXT-SETUP.md")) await writeFile(dest, await readFile(source, "utf8"), { flag: "wx" });
    else await copyFile(source, dest, constants.COPYFILE_EXCL);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install(process.argv.slice(2)).then(result => {
    process.stdout.write(`Installed ${result.lang.toUpperCase()} wavebird routes and connectors in ${result.projectRoot}. Read WAVEBIRD-SETUP.md.\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
