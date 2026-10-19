import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { installLifecycle, checkCompatibility } from "../scripts/main.js";
import { build, ROOT, RUNTIME_FILES } from "../tools/build.mjs";
import { DataStore, registerDataSetting } from "../scripts/data-store.js";
import { emptyData, emptySystem } from "../scripts/data-model.js";

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
  assert.deepEqual([...entries.keys()], ["module.json", "scripts/main.js", "scripts/data-model.js", "scripts/data-store.js", "lang/en.json", "lang/ru.json"]);
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
  delete manifest.styles; manifest.version = "9.9.9"; await writeFile(resolve(root, "module.json"), JSON.stringify(manifest));
  await assert.rejects(build({ root }), /inconsistent/);
  await rm(resolve(root, "lang/ru.json")); await assert.rejects(build({ root }), /ENOENT/);
});

function storageFixture(initial) {
  let persisted = structuredClone(initial), writes = 0, nextId = 0, rejectSave = false;
  const registrations = [];
  const game = { user: { isGM: true }, settings: {
    register: (...args) => registrations.push(args),
    get(namespace, key) { assert.equal(namespace, "skybricate"); assert.equal(key, "data"); return persisted; },
    async set(namespace, key, data) {
      assert.equal(namespace, "skybricate"); assert.equal(key, "data");
      if (rejectSave) throw Error("Persistence rejected");
      persisted = structuredClone(data); writes++; return data;
    }
  } };
  const createStore = () => new DataStore({ getGame: () => game, idFactory: () => `property-${++nextId}` });
  return { game, registrations, createStore, store: createStore(), get writes() { return writes; },
    set rejectSave(value) { rejectSave = value; }, get persisted() { return structuredClone(persisted); },
    replace(value) { persisted = structuredClone(value); } };
}

test("init registers a hidden world setting and API is exposed only after readiness", async () => {
  const f = fixture(), storage = storageFixture();
  f.game.settings = storage.game.settings;
  f.game.modules.set("skybricate", {});
  f.hooks.fire("init");
  assert.equal(storage.registrations.length, 1);
  const [namespace, key, options] = storage.registrations[0];
  assert.equal(namespace, "skybricate"); assert.equal(key, "data");
  assert.equal(options.scope, "world"); assert.equal(options.config, false); assert.equal(options.type, Object);
  assert.deepEqual(options.default, emptyData());
  assert.equal(f.game.modules.get("skybricate").api, undefined);
  f.hooks.fire("ready"); f.finish(); await flush();
  const api = f.game.modules.get("skybricate").api;
  assert(api.data instanceof DataStore); assert(Object.isFrozen(api));
  assert.deepEqual(api.data.getSnapshot(), emptyData());
});

test("defaults are isolated, no write occurs on reading missing settings", async () => {
  const f = storageFixture();
  registerDataSetting(f.game.settings);
  const snapshot = f.store.getSnapshot(); snapshot.properties.fake = {};
  assert.deepEqual(f.store.getSnapshot(), emptyData()); assert.equal(f.writes, 0);
  await f.store.ensureSystem("alchemy");
  assert.deepEqual(f.createStore().getSnapshot().systems.alchemy, emptySystem());
  assert.equal(f.store.getSnapshot().systems.alchemy.rules.prioritySpecial, false);
});

test("CRUD roundtrip retains stable IDs, category and special assignments, system isolation", async () => {
  const f = storageFixture(), store = f.store;
  const healing = await store.createProperty({ name: "Лечение", description: "Восстановление" });
  const cold = await store.createProperty({ name: "Холод" });
  await store.setCategoryProperties("alchemy", "Грибы", [healing, cold]);
  await store.setCategoryProperties("alchemy", "Цветы", [healing]);
  await store.setComponentProperties("alchemy", "rare-mushroom", [cold]);
  await store.setCategoryProperties("cooking", "Грибы", [cold]);
  const otherSystem = store.getSnapshot().systems.cooking;
  await store.configureRules("alchemy", { limitByCheck: true, successLimit: 2,
    prioritySpecial: true, outcomeLimits: { "outcome-uuid": 1, "critical-uuid": 3 }, propertyOrder: [cold, healing] });
  await store.updateProperty(healing, { name: "Исцеление" });
  await store.renameCategory("alchemy", "Грибы", "Лесные грибы");
  const data = f.createStore().getSnapshot();
  assert.equal(data.properties[healing].name, "Исцеление");
  assert.equal(data.properties[healing].description, "Восстановление");
  assert.deepEqual(data.systems.alchemy.categories["Лесные грибы"], [healing, cold]);
  assert.deepEqual(data.systems.alchemy.components["rare-mushroom"], [cold]);
  assert.equal(Object.hasOwn(data.systems.alchemy.categories, "Грибы"), false);
  assert.deepEqual(data.systems.cooking, otherSystem);
  assert.deepEqual(data.systems.alchemy.rules.propertyOrder, [cold, healing]);
  data.systems.alchemy.categories["Цветы"].push(cold);
  assert.deepEqual(store.getSnapshot().systems.alchemy.categories["Цветы"], [healing]);
});

test("deleting a property cleans every system; narrow deletions preserve others and catalogue", async () => {
  const { store } = storageFixture();
  const first = await store.createProperty({ name: "First" }), second = await store.createProperty({ name: "Second" });
  for (const id of ["alchemy", "cooking"]) {
    await store.setCategoryProperties(id, "herbs", [first, second]);
    await store.setComponentProperties(id, "component", [first]);
    await store.configureRules(id, { propertyOrder: [first, second] });
  }
  await store.deleteProperty(first);
  const data = store.getSnapshot();
  assert.equal(Object.hasOwn(data.properties, first), false);
  for (const system of Object.values(data.systems)) {
    assert.deepEqual(system.categories.herbs, [second]); assert.deepEqual(system.components.component, []);
    assert.deepEqual(system.rules.propertyOrder, [second]);
  }
  await store.deleteCategory("alchemy", "herbs"); await store.deleteComponent("alchemy", "component");
  assert.deepEqual(store.getSnapshot().systems.alchemy.categories, {});
  assert.deepEqual(store.getSnapshot().systems.cooking, data.systems.cooking);
  await store.deleteSystem("alchemy");
  assert.deepEqual(Object.keys(store.getSnapshot().systems), ["cooking"]);
  assert.deepEqual(store.getSnapshot().properties, data.properties);
});

test("category rename conflicts reject atomically", async () => {
  const f = storageFixture(), store = f.store;
  await store.setCategoryProperties("a", "old", []); await store.setCategoryProperties("a", "new", []);
  const before = store.getSnapshot(), writes = f.writes;
  await assert.rejects(store.renameCategory("a", "old", "new"), /conflict/);
  await assert.rejects(store.renameCategory("missing", "old", "new"), /Unknown category/);
  assert.deepEqual(store.getSnapshot(), before); assert.equal(f.writes, writes);
});

test("invalid inputs, dangling/duplicate refs and dangerous keys are rejected without persistence", async () => {
  const f = storageFixture(), s = f.store;
  const id = await s.createProperty({ name: "valid" }); const writes = f.writes, before = f.persisted;
  for (const operation of [
    () => s.createProperty({ name: "  " }), () => s.createProperty({ name: "valid", description: null }),
    () => s.createProperty({ name: "valid", extra: true }), () => s.updateProperty(id, { name: 2 }),
    () => s.updateProperty("missing", { name: "valid" }),
    () => s.setCategoryProperties("a", "herbs", ["missing"]),
    () => s.setComponentProperties("a", "item", [id, id]),
    () => s.setCategoryProperties("a", "herbs", "invalid"),
    () => s.configureRules("a", { prioritySpecial: 1 }), () => s.configureRules("a", { limitByCheck: "yes" }),
    () => s.configureRules("a", { successLimit: -1 }), () => s.configureRules("a", { successLimit: 1.5 }),
    () => s.configureRules("a", { outcomeLimits: { critical: NaN } }),
    () => s.configureRules("a", { outcomeLimits: { critical: Infinity } }),
    () => s.configureRules("a", { propertyOrder: ["missing"] }),
    () => s.configureRules("a", { propertyOrder: [id, id] }),
    () => s.ensureSystem("__proto__"), () => s.setCategoryProperties("a", "constructor", []),
    () => s.setComponentProperties("prototype", "item", []),
    () => s.configureRules("a", { outcomeLimits: JSON.parse('{"__proto__":0}') }),
    () => s.updateProperty(id, JSON.parse('{"__proto__":{}}'))
  ]) await assert.rejects(operation());
  assert.equal(f.writes, writes); assert.deepEqual(f.persisted, before);
  assert.equal({}.polluted, undefined);
});

test("every write operation denies non-GM and checks permission when dequeued", async () => {
  const f = storageFixture(), s = f.store; f.game.user.isGM = false;
  for (const operation of [
    () => s.createProperty({ name: "x" }), () => s.updateProperty("x", { name: "y" }), () => s.deleteProperty("x"),
    () => s.ensureSystem("a"), () => s.setCategoryProperties("a", "b", []), () => s.setComponentProperties("a", "b", []),
    () => s.renameCategory("a", "b", "c"), () => s.deleteCategory("a", "b"), () => s.deleteComponent("a", "b"),
    () => s.configureRules("a", {}), () => s.deleteSystem("a")
  ]) await assert.rejects(operation(), /require a GM/);
  assert.equal(f.writes, 0);
  f.game.user.isGM = true; const queued = s.ensureSystem("a"); f.game.user.isGM = false;
  await assert.rejects(queued, /require a GM/); assert.equal(f.writes, 0);
});

test("corrupt and future schema fail closed for read and write without resetting data", async () => {
  for (const initial of [null, {}, { ...emptyData(), schemaVersion: 99 },
    { ...emptyData(), properties: { bad: { name: 0, description: "" } } },
    { ...emptyData(), systems: { alchemy: { ...emptySystem(), categories: { herbs: ["missing"] } } } },
    { ...emptyData(), systems: JSON.parse('{"__proto__":{}}') }]) {
    const f = storageFixture(initial); const before = f.persisted;
    assert.throws(() => f.store.getSnapshot());
    await assert.rejects(f.store.ensureSystem("new"));
    assert.equal(f.writes, 0); assert.deepEqual(f.persisted, before);
  }
});

test("rejected persistence reports failure, preserves data and does not poison the queue", async () => {
  const f = storageFixture(), s = f.store;
  const id = await s.createProperty({ name: "Before" }), before = s.getSnapshot();
  f.rejectSave = true;
  await assert.rejects(s.updateProperty(id, { name: "After" }), /Persistence rejected/);
  assert.deepEqual(s.getSnapshot(), before);
  f.rejectSave = false; await s.updateProperty(id, { name: "Saved" });
  assert.equal(s.getSnapshot().properties[id].name, "Saved");
});

test("queued writes read latest storage and snapshot caller-owned inputs", async () => {
  const f = storageFixture(), s = f.store;
  const [a, b] = await Promise.all([s.createProperty({ name: "A" }), s.createProperty({ name: "B" })]);
  const ids = [a], patch = { prioritySpecial: true };
  const operations = [s.setCategoryProperties("a", "herbs", ids), s.setComponentProperties("a", "item", [b]), s.configureRules("a", patch)];
  ids.push(b); patch.prioritySpecial = false;
  await Promise.all(operations);
  assert.deepEqual(s.getSnapshot().systems.a.categories.herbs, [a]);
  assert.deepEqual(s.getSnapshot().systems.a.components.item, [b]);
  assert.equal(s.getSnapshot().systems.a.rules.prioritySpecial, true);
  await f.createStore().updateProperty(b, { name: "External edit" });
  await s.updateProperty(a, { name: "Local edit" });
  assert.equal(s.getSnapshot().properties[b].name, "External edit");
});

test("ID collisions reject and preserve existing property", async () => {
  const f = storageFixture(); const s = new DataStore({ getGame: () => f.game, idFactory: () => "fixed" });
  await s.createProperty({ name: "Before" });
  await assert.rejects(s.createProperty({ name: "After" }), /collision/);
  assert.equal(s.getSnapshot().properties.fixed.name, "Before"); assert.equal(f.writes, 1);
});

test("build fails if a runtime import is omitted from allowlist", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "skybricate-import-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [...RUNTIME_FILES, "package.json"]) {
    await mkdir(dirname(resolve(root, path)), { recursive: true }); await copyFile(resolve(ROOT, path), resolve(root, path));
  }
  await writeFile(resolve(root, "scripts/data-store.js"), 'import "./unpackaged.js";');
  await assert.rejects(build({ root }), /Import is not packaged/);
});
