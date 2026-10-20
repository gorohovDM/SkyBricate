// Stock Fabricate persistence probe. Does not run or modify Foundry/Fabricate.
// node --conditions=browser tools/check-fabricate-assignments.mjs [stock source checkout]
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stockSources } from './fabricate-source.mjs';
import { DataStore } from '../scripts/data-store.js';
import { emptyData } from '../scripts/data-model.js';
import { mountAssignmentPanel } from '../scripts/assignment-panel.js';
import { managerFixture, settleDOM } from '../tests/helpers/manager-fixture.mjs';

const { upstream, read } = stockSources(process.argv[2]);
const cacheRoot = resolve('node_modules/.cache'); await mkdir(cacheRoot, { recursive: true });
const temp = await mkdtemp(resolve(cacheRoot, 'skybricate-stock-'));
const f = managerFixture({ getSnapshot: emptyData }), copied = new Set();
async function prepare(path) {
  if (copied.has(path)) return; copied.add(path);
  const source = read(path), out = resolve(temp, path); await mkdir(dirname(out), { recursive: true });
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) await prepare(relative(upstream, resolve(upstream, dirname(path), match[1])).replaceAll('\\', '/'));
  }
  await writeFile(out, source);
}
let panel;
try {
  globalThis.game = f.game; globalThis.Hooks = { callAll: (name, ...args) => f.hooks.fire(name, ...args) };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.foundry = { utils: { deepClone: structuredClone, randomID: () => crypto.randomUUID() } };
  await prepare('src/systems/CraftingSystemManager.js'); await prepare('src/ui/svelte/stores/adminStore.js');
  const { CraftingSystemManager } = await import(pathToFileURL(resolve(temp, 'src/systems/CraftingSystemManager.js')));
  const { SettingsCraftingDefinitionRepository } = await import(pathToFileURL(resolve(temp, 'src/systems/SettingsCraftingDefinitionRepository.js')));
  const { createAdminStore } = await import(pathToFileURL(resolve(temp, 'src/ui/svelte/stores/adminStore.js')));
  const settingsSource = read('src/config/settings.js');
  assert.match(settingsSource, /\[SETTING_KEYS.CRAFTING_SYSTEMS\]:\s*\{\s*name: 'Crafting Systems',\s*scope: 'world',\s*config: false,\s*type: Array,/);
  assert.match(settingsSource, /return game.settings.get\(FABRICATE_SETTINGS_NAMESPACE, key\)/);
  assert(!read('src/systems/SettingsCraftingDefinitionRepository.js').includes('componentsDeleted'));
  const initial = ['a', 'b'].map(id => ({ id, name: 'Same', components: ['one', 'two'].map(id => ({ id, name: 'Same', category: 'general', tags: ['native'] })) }));
  let persisted = structuredClone(initial), sky = emptyData(), reject = false, rejectSky = false, nativeWrites = 0;
  const game = f.game; game.i18n.format = key => key;
  game.modules = new Map([['fabricate', { active: true, version: '1.9.10' }]]);
  game.settings = {
    settings: new Map([['fabricate.craftingSystems', { scope: 'world', type: Array }]]),
    get: (ns, key) => key === 'showSpecialProperties' ? true : structuredClone(ns === 'fabricate' ? persisted : sky),
    set: async (ns, key, value) => {
      if (ns === 'fabricate') { assert.equal(key, 'craftingSystems'); if (reject) throw Error('native disk failure'); persisted = structuredClone(value); nativeWrites++; }
      else { assert.equal(ns, 'skybricate'); if (rejectSky) throw Error('sky disk failure'); sky = structuredClone(value); }
    }
  };
  const manager = new CraftingSystemManager({ getRecipes: () => [], save: async () => {}, notifyRecipesChanged() {}, disableSignatureConflicts: async () => [] });
  for (const system of initial) manager.systems.set(system.id, structuredClone(system));
  manager._cleanupSalvageRunsForComponent = async () => {};
  game.fabricate = { getCraftingSystemManager: () => manager };
  assert.equal(manager.componentAssignmentContract, undefined);
  const data = new DataStore({ getGame: () => game, idFactory: () => 'p' });
  const specialCatalog = new DataStore({ getGame: () => game, idFactory: () => 's' });
  const assign = (system, component) => data.setComponentAssignments(system, component, { ordinary: ['p'], special: ['s'] }, { editSpecial: true });
  for (const id of ['a', 'b']) {
    await data.createProperty(id, { name: 'Hidden' });
    await specialCatalog.createProperty(id, { name: 'Special' });
    for (const component of ['one', 'two']) await assign(id, component);
  }
  const mount = () => mountAssignmentPanel({ target: f.root, getGame: () => game, data, canWrite: () => game.user.isGM, text: key => key });
  panel = mount(); await settleDOM();
  assert.equal(nativeWrites, 0, 'opening editor writes only SkyBricate');
  let confirmDelete = false;
  const admin = createAdminStore({ getSetting: key => key === 'lastManagedCraftingSystem' ? 'a' : undefined,
    getCraftingSystemManager: () => manager, getRecipeManager: () => manager.recipeManager,
    isFabricateReady: () => false, confirmDialog: async () => confirmDelete });
  await admin.deleteComponent('one'); await panel.refresh();
  assert(persisted[0].components.some(row => row.id === 'one')); assert.deepEqual(sky.systems.a.components.one, ['p']); admin.destroy();
  reject = true; await assert.rejects(manager.deleteItem('a', 'one')); await panel.refresh();
  assert(persisted[0].components.some(row => row.id === 'one')); assert.deepEqual(sky.systems.a.components.one, ['p']);
  reject = false; manager.systems.get('a').components = structuredClone(initial[0].components);
  await manager.deleteItem('a', 'one');
  assert.deepEqual(sky.systems.a.components.one, ['p'], 'explicit reconciliation has no fabricated deletion hook');
  rejectSky = true; await panel.refresh(); assert(sky.systems.a.components.one);
  rejectSky = false; await panel.refresh(); assert.equal(sky.systems.a.components.one, undefined); assert.equal(sky.systems.a.specialComponents.one, undefined);
  assert.deepEqual(sky.systems.a.components.two, ['p']); assert.deepEqual(sky.systems.b.components.one, ['p']); assert.deepEqual(sky.systems.b.specialComponents.one, ['s']);
  // Rename/category changes preserve the saved ID and its assignment.
  const system = manager.systems.get('a'); system.components[0].name = 'Renamed'; system.components[0].category = 'herb';
  await manager.save({ put: system }); await panel.refresh(); assert.deepEqual(sky.systems.a.components.two, ['p']);
  const bulk = [{ id: 'two', name: 'Same' }, { id: 'three', name: 'Same' }];
  system.components = structuredClone(bulk); await manager.save({ put: system }); await assign('a', 'three');
  reject = true; await assert.rejects(manager.deleteComponents('a', ['two', 'three'])); await panel.refresh();
  assert(sky.systems.a.components.two); assert(sky.systems.a.components.three);
  reject = false; system.components = structuredClone(bulk);
  await manager.deleteComponents('a', ['two', 'three']); await panel.refresh(); assert.deepEqual(sky.systems.a.components, {}); assert.deepEqual(sky.systems.a.specialComponents, {});
  assert.deepEqual(sky.systems.b.components.one, ['p']); assert.deepEqual(sky.systems.b.specialComponents.one, ['s']);
  // Actual stock repository batch writes one complete array; SkyBricate uses its persisted result.
  const corpus = new Map([['a', { id: 'a', components: [{ id: 'x' }, { id: 'y' }] }], ['b', persisted[1]]]);
  const repo = new SettingsCraftingDefinitionRepository({ settingKey: 'craftingSystems', corpus: () => corpus });
  await repo.putAll([...corpus.values()]);
  await assign('a', 'x'); await assign('a', 'y');
  const before = nativeWrites;
  await repo.runBatch(async () => { corpus.get('a').components = []; await repo.put(corpus.get('a')); assert.equal(nativeWrites, before); });
  assert.equal(nativeWrites, before + 1); await panel.refresh(); assert.deepEqual(sky.systems.a.components, {}); assert.deepEqual(sky.systems.a.specialComponents, {});
  // Closed client misses a deletion; opening a fresh editor repairs from persisted bytes.
  corpus.get('a').components = [{ id: 'missed' }]; await repo.put(corpus.get('a'));
  await assign('a', 'missed'); panel.dispose(); panel = null;
  corpus.get('a').components = []; await repo.put(corpus.get('a')); assert(sky.systems.a.components.missed);
  panel = mount(); await settleDOM(); assert.equal(sky.systems.a.components.missed, undefined); assert.equal(sky.systems.a.specialComponents.missed, undefined);
  console.log('PASS stock 1.9.10: strict setting contract, standalone editor, cancelled/failed/successful single + bulk deletion, rename/category, failed cleanup/retry, repository batch, source-system isolation, reopen reconciliation.');
} finally { panel?.dispose(); f.destroy(); await rm(temp, { recursive: true, force: true }); }
