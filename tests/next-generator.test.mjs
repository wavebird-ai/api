import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { install, plan } from "../bin/wavebird-next.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = resolve(root, "artifacts", "generator-tests");

for (const [lang, appDir] of [["js", "app"], ["ts", "src/app"]]) {
  test(`${lang} installer creates explicit fail-closed Next routes and connectors`, async () => {
    await mkdir(scratch, { recursive: true });
    const project = await mkdtemp(join(scratch, `next-${lang}-`));
    await mkdir(join(project, appDir), { recursive: true });
    const args = ["init", "--lang", lang, "--root", project, "--app-dir", appDir];
    const candidate = await plan(args);
    assert.equal(candidate.files.length, 8);
    const result = await install(args);
    assert.equal(result.files.length, 8);
    for (const [, target] of result.files) await access(target, constants.R_OK);
    const base = dirname(join(project, appDir));
    const ext = lang === "ts" ? "ts" : "js";
    const model = await readFile(join(base, "lib", `model.${ext}`), "utf8");
    assert.match(model, /throw new Error\("Connect your existing authenticated generation stream/);
    const auth = await readFile(join(base, "lib", `auth.${ext}`), "utf8");
    assert.match(auth, /return false/);
    const publisher = await readFile(join(base, "lib", `publisher.${ext}`), "utf8");
    assert.match(publisher, /WAVEBIRD_PUBLIC_ORIGINS/);
    assert.match(publisher, /getPublisher\(\)/);
    assert.match(publisher, /responsiveSizeSelection: true/);
    assert.match(publisher, /width: 320, height: 50/);
    assert.doesNotMatch(publisher, /export const publisher = createPublisherServer/);
    const component = await readFile(join(base, "components", `WavebirdPlacement.${lang === "ts" ? "tsx" : "jsx"}`), "utf8");
    assert.match(component, /connectGeneration|onReady/);
    assert.doesNotMatch(component, /WAVEBIRD_SECRET_KEY|WAVEBIRD_PREFERENCE_SECRET/);
    await assert.rejects(install(args), /Refusing to overwrite/);
  });
}
