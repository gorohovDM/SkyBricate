import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { installLifecycle, checkCompatibility } from "../scripts/main.js";
import { build, ROOT, RUNTIME_FILES } from "../tools/build.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const handlers = new Map();
  const add = (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]);
  const hooks = { on: add, once: add, fire(name) { for (const fn of handlers.get(name) ?? []) fn(); } };
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const game = { modules: new Map([["fabricate", { active: true, version: "1.9.10" }]]),
    release: { generation: 13 }, user: { isGM: true }, i18n: { localize: key => key },
    fabricate: { whenReady: () => ready, getCraftingSystemManager() {}, getRecipeManager() {}, getCraftingRunManager() {},
      api: { playerExtensions: { registerPlayerNavProvider() { throw Error("Scaffold must not register UI"); } } } } };
  const warnings = [], infos = [];
  const status = installLifecycle({ hooks, getGame: () => game,
    notifications: () => ({ warn: text => warnings.push(text) }), logger: { warn() {}, info: text => infos.push(text) } });
  return { game, hooks, finish, status, warnings, infos };
}

for (const order of ["before", "after", "already-settled"]) test(`readiness: Fabricate ${order} Foundry ready`, async () => {
  const f = fixture();
  if (order !== "after") { f.finish(); if (order === "before") f.hooks.fire("fabricate.ready"); }
  f.hooks.fire("ready");
  if (order === "after") { await flush(); assert.equal(f.status.ready, false); f.finish(); f.hooks.fire("fabricate.ready"); }
  await flush();
  f.hooks.fire("fabricate.ready"); f.hooks.fire("ready"); await flush();
  assert.equal(f.status.ready, true); assert.equal(f.infos.length, 1); assert.equal(f.warnings.length, 0);
});

for (const [reason, mutate] of [
  ["dependency", g => g.modules.clear()], ["dependency", g => g.modules.get("fabricate").active = false],
  ["version", g => g.modules.get("fabricate").version = "1.9.11"],
  ["foundry", g => g.release.generation = 12], ["api", g => delete g.fabricate.api.playerExtensions],
  ["api", g => delete g.fabricate.whenReady]
]) test(`compatibility rejects ${reason}`, async () => {
  const f = fixture(); mutate(f.game); f.hooks.fire("ready"); f.hooks.fire("fabricate.ready"); await flush();
  assert.equal(f.status.reason, reason); assert.equal(f.status.ready, false); assert.equal(f.warnings.length, 1);
});

test("Foundry 14 accepted; players get no GM warning", () => {
  const f = fixture(); f.game.release.generation = 14; assert.equal(checkCompatibility(f.game), null);
  f.game.user.isGM = false; f.game.modules.clear(); f.hooks.fire("ready"); assert.equal(f.warnings.length, 0);
});

test("rejected readiness promise disables scaffold", async () => {
  const f = fixture(); f.game.fabricate.whenReady = async () => { throw Error("failed"); };
  f.hooks.fire("ready"); await flush(); assert.equal(f.status.reason, "initialization");
});

test("compatibility is rechecked after initialization", async () => {
  const f = fixture(); f.hooks.fire("ready"); delete f.game.fabricate.api; f.finish(); await flush();
  assert.equal(f.status.reason, "api"); assert.equal(f.status.ready, false);
});

function unzipStored(zip) {
  const entries = new Map(); let cursor = 0;
  while (zip.readUInt32LE(cursor) === 0x04034b50) {
    assert.equal(zip.readUInt16LE(cursor + 8), 0);
    const size = zip.readUInt32LE(cursor + 18), length = zip.readUInt16LE(cursor + 26);
    const name = zip.subarray(cursor + 30, cursor + 30 + length).toString();
    const start = cursor + 30 + length;
    entries.set(name, zip.subarray(start, start + size)); cursor = start + size;
  }
  assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), entries.size);
  return entries;
}

test("release ZIP is reproducible, exact allowlist and manifest paths exist", async t => {
  const out = await mkdtemp(resolve(tmpdir(), "skybricate-build-")); t.after(() => rm(out, { recursive: true, force: true }));
  const first = await build({ out }); const second = await build({ out }); assert.deepEqual(first.archive, second.archive);
  const entries = unzipStored(await readFile(resolve(out, "skybricate.zip")));
  assert.deepEqual([...entries.keys()], ["module.json", "scripts/main.js", "lang/en.json", "lang/ru.json"]);
  for (const [path, data] of entries) assert.deepEqual(data, await readFile(resolve(ROOT, path)));
  const manifest = JSON.parse(entries.get("module.json"));
  assert.deepEqual(await readFile(resolve(out, "module.json")), entries.get("module.json"));
  assert.equal(manifest.relationships.requires[0].id, "fabricate");
  assert.deepEqual(manifest.compatibility, { minimum: "13", maximum: "14" });
  for (const path of [...manifest.esmodules, ...manifest.languages.map(l => l.path)]) assert(entries.has(path));
  assert.equal(manifest.compatibility.verified, undefined);
  const en = JSON.parse(entries.get("lang/en.json")).SKYBRICATE.Compatibility;
  const ru = JSON.parse(entries.get("lang/ru.json")).SKYBRICATE.Compatibility;
  assert.deepEqual(Object.keys(en), Object.keys(ru));
});

test("build rejects missing runtime files, excluded paths and version drift", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "skybricate-invalid-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [...RUNTIME_FILES, "package.json"]) {
    await mkdir(dirname(resolve(root, path)), { recursive: true }); await copyFile(resolve(ROOT, path), resolve(root, path));
  }
  const manifest = JSON.parse(await readFile(resolve(root, "module.json")));
  manifest.styles = ["docs/leak.css"]; await writeFile(resolve(root, "module.json"), JSON.stringify(manifest));
  await assert.rejects(build({ root }), /not packaged/);
  delete manifest.styles; manifest.version = "0.2.0"; await writeFile(resolve(root, "module.json"), JSON.stringify(manifest));
  await assert.rejects(build({ root }), /inconsistent/);
  await rm(resolve(root, "lang/ru.json")); await assert.rejects(build({ root }), /ENOENT/);
});
