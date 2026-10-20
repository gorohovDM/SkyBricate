import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, dirname } from "node:path";
import { installLifecycle, checkCompatibility } from "../scripts/main.js";
import { build, ROOT, RUNTIME_FILES } from "../tools/build.mjs";
import { DataStore, registerDataSetting } from "../scripts/data-store.js";
import { emptyData, emptySystem } from "../scripts/data-model.js";
import "./editor-regressions.mjs";
import "./assignment-regressions.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ getApplicationV2 } = {}) {
  const handlers = new Map();
  const add = (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]);
  const hooks = { on: add, once: add, fire(name) { for (const fn of handlers.get(name) ?? []) fn(); },
    count(name) { return handlers.get(name)?.length ?? 0; } };
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const game = { modules: new Map([["fabricate", { active: true, version: "1.9.10" }]]),
    release: { generation: 13 }, user: { isGM: true }, i18n: { localize: key => key },
    fabricate: { whenReady: () => ready, getCraftingSystemManager() {}, getRecipeManager() {}, getCraftingRunManager() {},
      api: { playerExtensions: { registerPlayerNavProvider() { throw Error("Scaffold must not register UI"); } } } } };
  const warnings = [], infos = [];
  const status = installLifecycle({ hooks, getGame: () => game,
    notifications: () => ({ warn: text => warnings.push(text) }), logger: { warn() {}, info: text => infos.push(text) }, getApplicationV2 });
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

test("manager hooks are registered only for GM after readiness and compatibility checks", async () => {
  for (const isGM of [true, false]) {
    const f = fixture(); f.game.user.isGM = isGM;
    assert.equal(f.hooks.count("renderApplicationV2"), 0);
    f.hooks.fire("ready"); await flush(); assert.equal(f.hooks.count("renderApplicationV2"), 0);
    f.finish(); await flush();
    assert.equal(f.hooks.count("renderApplicationV2"), isGM ? 1 : 0);
    assert.equal(f.hooks.count("closeApplicationV2"), isGM ? 1 : 0);
  }
  const f = fixture(); f.game.modules.get("fabricate").version = "2.0.0";
  f.finish(); f.hooks.fire("ready"); await flush(); assert.equal(f.hooks.count("renderApplicationV2"), 0);
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
  assert.deepEqual([...entries.keys()], ["module.json", "scripts/main.js", "scripts/data-model.js", "scripts/data-store.js", "scripts/manager-adapter.js", "scripts/property-panel.js", "scripts/assignment-contract.js", "scripts/assignment-panel.js", "scripts/assignment-adapter.js", "styles/skybricate.css", "lang/en.json", "lang/ru.json"]);
  for (const [path, data] of entries) assert.deepEqual(data, await readFile(resolve(ROOT, path)));
  const manifest = JSON.parse(entries.get("module.json"));
  assert.deepEqual(await readFile(resolve(out, "module.json")), entries.get("module.json"));
  assert.equal(manifest.relationships.requires[0].id, "fabricate");
  assert.deepEqual(manifest.compatibility, { minimum: "13", maximum: "14" });
  for (const path of [...manifest.esmodules, ...manifest.styles, ...manifest.languages.map(l => l.path)]) assert(entries.has(path));
  assert.equal(manifest.compatibility.verified, undefined);
  const en = JSON.parse(entries.get("lang/en.json")).SKYBRICATE.Compatibility;
  const ru = JSON.parse(entries.get("lang/ru.json")).SKYBRICATE.Compatibility;
  assert.deepEqual(Object.keys(en), Object.keys(ru));
  assert.deepEqual(Object.keys(JSON.parse(entries.get("lang/en.json")).SKYBRICATE.Editor),
    Object.keys(JSON.parse(entries.get("lang/ru.json")).SKYBRICATE.Editor));
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
  const game = { user: { isGM: true }, modules: new Map([['fabricate', { active: true, version: '1.9.10' }]]), settings: {
    settings: new Map([['fabricate.craftingSystems', { scope: 'world', type: Array }]]),
    register: (...args) => registrations.push(args),
    get(namespace, key) { if (namespace === 'fabricate') return ['a','b'].map(id => ({ id, components: ['rare-mushroom', 'special', 'item', 'b', 'component'].map(id => ({id})) })); assert.equal(namespace, "skybricate"); if (key === "showSpecialProperties") return false; assert.equal(key, "data"); return persisted; },
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
  assert.equal(storage.registrations.length, 2);
  const [namespace, key, options] = storage.registrations.find(([, key]) => key === "data");
  assert.equal(namespace, "skybricate"); assert.equal(key, "data");
  assert.equal(options.scope, "world"); assert.equal(options.config, false); assert.equal(options.type, Object);
  assert.deepEqual(options.default, emptyData());
  assert.equal(f.game.modules.get("skybricate").api, undefined);
  f.hooks.fire("ready"); f.finish(); await flush();
  const api = f.game.modules.get("skybricate").api;
  assert(api.data instanceof DataStore); assert(Object.isFrozen(api));
  assert.deepEqual(api.data.getSnapshot(), emptyData());
});

test('lifecycle registers restricted standalone menu at init and exposes guarded openAssignments after ready', async () => {
  class Base { render(options) { this.renderOptions = options; return this; } }
  const f = fixture({ getApplicationV2: () => Base }), storage = storageFixture();
  let menu;
  f.game.settings = { ...storage.game.settings, registerMenu: (ns, key, options) => { menu = { ns, key, ...options }; } };
  f.game.modules.set('skybricate', {}); f.hooks.fire('init');
  assert.equal(menu.ns, 'skybricate'); assert.equal(menu.key, 'assignments'); assert.equal(menu.restricted, true);
  assert.equal(new menu.type()._canRender(), false);
  f.hooks.fire('ready'); f.finish(); await flush();
  const api = f.game.modules.get('skybricate').api, app = api.openAssignments();
  assert(app instanceof menu.type); assert.deepEqual(app.renderOptions, { force: true });
  assert.equal(app._canRender(), undefined);
  f.game.user.isGM = false; assert.throws(() => api.openAssignments()); assert.equal(app._canRender(), false);
  f.game.user.isGM = true; f.game.modules.get('fabricate').version = '2'; assert.throws(() => api.openAssignments());
});

test("defaults are isolated, no write occurs on reading missing settings", async () => {
  const f = storageFixture();
  registerDataSetting(f.game.settings);
  const snapshot = f.store.getSnapshot(); snapshot.systems.fake = {};
  assert.deepEqual(f.store.getSnapshot(), emptyData()); assert.equal(f.writes, 0);
  await f.store.ensureSystem("a");
  assert.deepEqual(f.createStore().getSnapshot().systems.a, emptySystem());
  assert.equal(f.store.getSnapshot().systems.a.rules.prioritySpecial, false);
});

test("CRUD roundtrip retains stable IDs, category and special assignments, system isolation", async () => {
  const f = storageFixture(), store = f.store;
  const healing = await store.createProperty("a", { name: "Лечение", description: "Восстановление" });
  const cold = await store.createProperty("a", { name: "Холод" });
  await store.setCategoryProperties("a", "Грибы", [healing, cold]);
  await store.setCategoryProperties("a", "Цветы", [healing]);
  await store.setComponentProperties("a", "rare-mushroom", [cold]);
  await store.setCategoryProperties("cooking", "Грибы", []);
  const otherSystem = store.getSnapshot().systems.cooking;
  await store.configureRules("a", { limitByCheck: true, successLimit: 2,
    prioritySpecial: true, outcomeLimits: { "outcome-uuid": 1, "critical-uuid": 3 }, propertyOrder: [cold, healing] });
  await store.updateProperty("a", healing, { name: "Исцеление" });
  await store.renameCategory("a", "Грибы", "Лесные грибы");
  const data = f.createStore().getSnapshot();
  assert.equal(data.systems.a.properties[healing].name, "Исцеление");
  assert.equal(data.systems.a.properties[healing].description, "Восстановление");
  assert.deepEqual(data.systems.a.categories["Лесные грибы"], [healing, cold]);
  assert.deepEqual(data.systems.a.components["rare-mushroom"], [cold]);
  assert.equal(Object.hasOwn(data.systems.a.categories, "Грибы"), false);
  assert.deepEqual(data.systems.cooking, otherSystem);
  assert.deepEqual(data.systems.a.rules.propertyOrder, [cold, healing]);
  data.systems.a.categories["Цветы"].push(cold);
  assert.deepEqual(store.getSnapshot().systems.a.categories["Цветы"], [healing]);
});

test("deleting scoped property cleans only its system even when IDs coincide", async () => {
  const f=storageFixture(), store=new DataStore({getGame:()=>f.game,idFactory:()=>"same"});
  for (const system of ["a","b"]) {
    await store.createProperty(system,{name:system}); await store.setCategoryProperties(system,"herbs",["same"]);
    await store.setComponentProperties(system,"special",["same"]); await store.configureRules(system,{propertyOrder:["same"]});
  }
  const before=store.getSnapshot().systems.b;
  await store.deleteProperty("a","same"); const data=store.getSnapshot();
  assert.deepEqual(data.systems.a.properties,{}); assert.deepEqual(data.systems.a.categories.herbs,[]);
  assert.deepEqual(data.systems.a.components.special,[]); assert.deepEqual(data.systems.a.rules.propertyOrder,[]);
  assert.deepEqual(data.systems.b,before);
  await store.deleteCategory("a","herbs"); await store.deleteComponent("a","special");
  assert.deepEqual(store.getSnapshot().systems.a.categories,{}); assert.deepEqual(store.getSnapshot().systems.a.components,{});
  await store.deleteSystem("a"); assert.deepEqual(store.getSnapshot().systems,{b:before});
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
  const id = await s.createProperty("a", { name: "valid" }); const writes = f.writes, before = f.persisted;
  for (const operation of [
    () => s.createProperty("a", { name: "  " }), () => s.createProperty("a", { name: "valid", description: null }),
    () => s.createProperty("a", { name: "valid", extra: true }), () => s.updateProperty("a", id, { name: 2 }),
    () => s.updateProperty("a", "missing", { name: "valid" }),
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
    () => s.updateProperty("a", id, JSON.parse('{"__proto__":{}}'))
  ]) await assert.rejects(operation());
  assert.equal(f.writes, writes); assert.deepEqual(f.persisted, before);
  assert.equal({}.polluted, undefined);
});

test("every write operation denies non-GM and checks permission when dequeued", async () => {
  const f = storageFixture(), s = f.store; f.game.user.isGM = false;
  for (const operation of [
    () => s.createProperty("a", { name: "x" }), () => s.updateProperty("a", "x", { name: "y" }), () => s.deleteProperty("a", "x"),
    () => s.ensureSystem("a"), () => s.setCategoryProperties("a", "b", []), () => s.setComponentProperties("a", "b", []),
    () => s.renameCategory("a", "b", "c"), () => s.deleteCategory("a", "b"), () => s.deleteComponent("a", "b"),
    () => s.configureRules("a", {}), () => s.deleteSystem("a"), () => s.resetLegacyData()
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
  const id = await s.createProperty("a", { name: "Before" }), before = s.getSnapshot();
  f.rejectSave = true;
  await assert.rejects(s.updateProperty("a", id, { name: "After" }), /Persistence rejected/);
  assert.deepEqual(s.getSnapshot(), before);
  f.rejectSave = false; await s.updateProperty("a", id, { name: "Saved" });
  assert.equal(s.getSnapshot().systems.a.properties[id].name, "Saved");
});

test("queued writes read latest storage and snapshot caller-owned inputs", async () => {
  const f = storageFixture(), s = f.store;
  const [a, b] = await Promise.all([s.createProperty("a", { name: "A" }), s.createProperty("a", { name: "B" })]);
  const ids = [a], patch = { prioritySpecial: true };
  const operations = [s.setCategoryProperties("a", "herbs", ids), s.setComponentProperties("a", "item", [b]), s.configureRules("a", patch)];
  ids.push(b); patch.prioritySpecial = false;
  await Promise.all(operations);
  assert.deepEqual(s.getSnapshot().systems.a.categories.herbs, [a]);
  assert.deepEqual(s.getSnapshot().systems.a.components.item, [b]);
  assert.equal(s.getSnapshot().systems.a.rules.prioritySpecial, true);
  await f.createStore().updateProperty("a", b, { name: "External edit" });
  await s.updateProperty("a", a, { name: "Local edit" });
  assert.equal(s.getSnapshot().systems.a.properties[b].name, "External edit");
});

test("ID collisions reject and preserve existing property", async () => {
  const f = storageFixture(); const s = new DataStore({ getGame: () => f.game, idFactory: () => "fixed" });
  await s.createProperty("a", { name: "Before" });
  await assert.rejects(s.createProperty("a", { name: "After" }), /collision/);
  assert.equal(s.getSnapshot().systems.a.properties.fixed.name, "Before"); assert.equal(f.writes, 1);
});

test("cross-system references and CRUD cannot reach another catalog", async () => {
  const f=storageFixture(), s=f.store, id=await s.createProperty("a",{name:"A"});
  const before=s.getSnapshot(), writes=f.writes;
  for (const op of [()=>s.setCategoryProperties("b","herbs",[id]), ()=>s.setComponentProperties("b","component",[id]),
    ()=>s.configureRules("b",{propertyOrder:[id]}), ()=>s.updateProperty("b",id,{name:"B"}), ()=>s.deleteProperty("b",id),
    ()=>s.createProperty("constructor",{name:"X"}), ()=>s.updateProperty("__proto__",id,{name:"X"}), ()=>s.deleteProperty("prototype",id)]) {
    await assert.rejects(op());
  }
  assert.deepEqual(s.getSnapshot(),before); assert.equal(f.writes,writes);
});

test("property input/patch copies are captured before queued scoped writes", async () => {
  const f=storageFixture(), input={name:"Before",description:"Original"};
  const create=f.store.createProperty("a",input); input.name="Changed"; const id=await create;
  const patch={description:"Copied"}, update=f.store.updateProperty("a",id,patch); patch.description="Changed"; await update;
  assert.deepEqual(f.store.getSnapshot().systems.a.properties[id],{name:"Before",description:"Copied"});
});

test("explicit reset recognizes only complete valid legacy and clears only own setting", async () => {
  const oldSystem=emptySystem(); delete oldSystem.properties; delete oldSystem.specialComponents;
  oldSystem.categories.herbs=["old"]; oldSystem.rules.propertyOrder=["old"];
  const legacy={schemaVersion:1,properties:{old:{name:"Test",description:""}},systems:{a:oldSystem}};
  const f=storageFixture(legacy); assert(f.store.hasLegacyData()); assert.throws(()=>f.store.getSnapshot()); assert.equal(f.writes,0);
  f.rejectSave=true; await assert.rejects(f.store.resetLegacyData(),/Persistence/); assert.deepEqual(f.persisted,legacy);
  f.rejectSave=false; await f.store.resetLegacyData(); assert.deepEqual(f.persisted,emptyData()); assert.equal(f.writes,1);
  for (const data of [null,{}, {...legacy,extra:true}, {...legacy,schemaVersion:99}, emptyData(),
    {...legacy,properties:{old:{name:3,description:""}}}, {...legacy,systems:{a:{...oldSystem,extra:true}}},
    {...legacy,properties:{}}]) {
    f.replace(data); const writes=f.writes;
    assert.equal(f.store.hasLegacyData(),false); await assert.rejects(f.store.resetLegacyData());
    assert.deepEqual(f.persisted,data); assert.equal(f.writes,writes);
  }
});

test("queued reset rechecks schema/GM and a rejection leaves queue usable", async () => {
  const legacy={schemaVersion:1,properties:{},systems:{}}, f=storageFixture(legacy);
  const reset=f.store.resetLegacyData(); f.replace(emptyData()); await assert.rejects(reset); assert.equal(f.writes,0);
  await f.store.ensureSystem("a"); assert.equal(f.writes,1);
  f.replace(legacy); const denied=f.store.resetLegacyData(); f.game.user.isGM=false; await assert.rejects(denied,/require a GM/);
  assert.deepEqual(f.persisted,legacy); f.game.user.isGM=true; await f.store.resetLegacyData(); assert.deepEqual(f.persisted,emptyData());
});

test("build fails if a runtime import is omitted from allowlist", async t => {
  const root = await mkdtemp(resolve(tmpdir(), "skybricate-import-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [...RUNTIME_FILES, "package.json"]) {
    await mkdir(dirname(resolve(root, path)), { recursive: true }); await copyFile(resolve(ROOT, path), resolve(root, path));
  }
  await writeFile(resolve(root, "scripts/data-store.js"), 'import "./unpackaged.js";');
  await assert.rejects(build({ root }), /Import is not packaged/);
});

test('schema 2 reads losslessly as ordinary links without writes; first successful edit persists schema 3', async () => {
  const system=emptySystem(); delete system.specialComponents;
  system.properties.p={name:'P',description:'Description'}; system.components.item=['p']; system.categories.herbs=['p'];
  system.rules.prioritySpecial=true; system.rules.propertyOrder=['p'];
  const old={schemaVersion:2,systems:{a:system}}, f=storageFixture(old);
  const snapshot=f.store.getSnapshot(); assert.equal(snapshot.schemaVersion,3); assert.deepEqual(snapshot.systems.a.specialComponents,{});
  assert.deepEqual(snapshot.systems.a.components,system.components); assert.deepEqual(snapshot.systems.a.rules,system.rules);
  assert.deepEqual(f.persisted,old); assert.equal(f.writes,0);
  f.rejectSave=true; await assert.rejects(f.store.updateProperty('a','p',{name:'Renamed'})); assert.deepEqual(f.persisted,old);
  f.rejectSave=false; await f.store.updateProperty('a','p',{name:'Renamed'});
  assert.equal(f.persisted.schemaVersion,3); assert.deepEqual(f.persisted.systems.a.components.item,['p']); assert.deepEqual(f.persisted.systems.a.specialComponents,{});
});

test('strict schema 2/3 recognition never drops unknown fields, malformed special links or conflicting types', async () => {
  const base={...emptyData(),systems:{a:emptySystem()}}; base.systems.a.properties.p={name:'P',description:''};
  const cases=[];
  for (const mutate of [s=>delete s.specialComponents, s=>s.specialComponents=null,
    s=>s.specialComponents={item:['p','p']}, s=>s.specialComponents={item:['missing']},
    s=>{s.components.item=['p'];s.specialComponents.item=['p'];},
    s=>s.specialComponents=JSON.parse('{"__proto__":[]}'),s=>s.properties.p.special=true]) {
    const value=structuredClone(base); mutate(value.systems.a); cases.push(value);
  }
  const old=structuredClone(base); old.schemaVersion=2; delete old.systems.a.specialComponents;
  cases.push({...old,extra:true}, {...old,systems:{a:{...old.systems.a,specialComponents:{}}}});
  for(const initial of cases) {
    const f=storageFixture(initial); assert.throws(()=>f.store.getSnapshot()); await assert.rejects(f.store.ensureSystem('b'));
    assert.deepEqual(f.persisted,initial); assert.equal(f.writes,0); assert.equal(f.store.hasLegacyData(),false);
  }
});

test('special section is a visible world setting defaulting off, independent of algorithm rules', () => {
  const f=storageFixture(); registerDataSetting(f.game.settings);
  const [ns,key,options]=f.registrations.find(([,key])=>key==='showSpecialProperties');
  assert.equal(ns,'skybricate'); assert.equal(key,'showSpecialProperties');
  assert.equal(options.scope,'world'); assert.equal(options.config,true); assert.equal(options.default,false); assert.equal(options.type,Boolean);
  assert.equal(typeof options.onChange,'function'); assert.equal(emptySystem().rules.prioritySpecial,false);
});
