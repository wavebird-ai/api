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
    assert.equal(candidate.files.length, 10);
    const result = await install(args);
    assert.equal(result.files.length, 10);
    for (const [, target] of result.files) await access(target, constants.R_OK);
    const base = dirname(join(project, appDir));
    const ext = lang === "ts" ? "ts" : "js";
    const model = await readFile(join(base, "lib", `model.${ext}`), "utf8");
    assert.match(model, /throw new Error\("Connect your existing authenticated generation stream/);
    const auth = await readFile(join(base, "lib", `auth.${ext}`), "utf8");
    assert.match(auth, /x-publisher-session-id/);
    assert.match(auth, /return null/);
    const publisher = await readFile(join(base, "lib", `publisher.${ext}`), "utf8");
    assert.match(publisher, /WAVEBIRD_PUBLIC_ORIGINS/);
    assert.match(publisher, /getPublisher\(\)/);
    assert.match(publisher, /sessionIdForRequest/);
    assert.match(publisher, /createPublisherTurnJournal/);
    assert.match(publisher, /derivePublisherTurnKeySecret\(process\.env\.WAVEBIRD_PREFERENCE_SECRET/);
    assert.doesNotMatch(publisher, /WAVEBIRD_TURN_KEY_SECRET/);
    const store = await readFile(join(base, "lib", `turn-store.${ext}`), "utf8");
    assert.match(store, /Connect your existing durable turn store/);
    const sessionRoute = await readFile(join(project, appDir, "api", "sponsor-session", `route.${ext}`), "utf8");
    assert.match(sessionRoute, /sessionGET/);
    assert.match(publisher, /responsiveSizeSelection: true/);
    assert.match(publisher, /width: 320, height: 50/);
    assert.doesNotMatch(publisher, /export const publisher = createPublisherServer/);
    const component = await readFile(join(base, "components", `WavebirdPlacement.${lang === "ts" ? "tsx" : "jsx"}`), "utf8");
    assert.match(component, /connectGeneration|onReady/);
    assert.match(component, /turnBinding: true/);
    assert.match(component, /\/api\/sponsor-session/);
    assert.doesNotMatch(component, /WAVEBIRD_SECRET_KEY|WAVEBIRD_PREFERENCE_SECRET/);
    const setup = await readFile(join(project, "WAVEBIRD-SETUP.md"), "utf8");
    assert.match(setup, /Dashboard project domain at your real HTTPS host/);
    assert.match(setup, /local Server Test-key testing, include the exact loopback origin in `WAVEBIRD_PUBLIC_ORIGINS`/);
    assert.match(setup, /Browser Test Keys instead use their separate Allowed origins field/);
    assert.doesNotMatch(setup, /registered that hostname, scheme, and port in the Dashboard/);
    await assert.rejects(install(args), /Refusing to overwrite/);
  });
}
