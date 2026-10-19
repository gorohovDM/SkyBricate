// Real upstream Svelte and persistence-path probe; does not run Foundry.
// node --conditions=browser tools/check-fabricate-assignments.mjs [patched checkout]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compile, compileModule } from 'svelte/compiler';
import { managerFixture, settleDOM } from '../tests/helpers/manager-fixture.mjs';
import { DataStore } from '../scripts/data-store.js';
import { emptyData } from '../scripts/data-model.js';
import { installAssignmentAdapter } from '../scripts/assignment-adapter.js';
import { verifyFabricatePatch } from './build-fabricate.mjs';

const upstream = resolve(process.argv[2] ?? '.reference/fabricate');
assert.equal(execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  '5bf36ddf950619317e41737acd3bfa1305591a26');
await verifyFabricatePatch(upstream);
const cacheRoot = resolve('node_modules/.cache'); await mkdir(cacheRoot, { recursive: true });
const temp = await mkdtemp(resolve(cacheRoot, 'skybricate-assignments-'));
const f = managerFixture({ getSnapshot: emptyData });
const copied = new Set();
async function prepare(path) {
  if (copied.has(path)) return;
  copied.add(path);
  const source = await readFile(resolve(upstream, path), 'utf8');
  const out = resolve(temp, path + (path.endsWith('.svelte') ? '.js' : ''));
  await mkdir(dirname(out), { recursive: true });
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) await prepare(relative(upstream, resolve(upstream, dirname(path), match[1])).replaceAll('\\', '/'));
  }
  const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', css: 'external' }).js.code
    : path.endsWith('.svelte.js') ? compileModule(source, { filename: path, generate: 'client' }).js.code : source;
  await writeFile(out, code.replace(/(from\s*['"][^'"]+)\.svelte(['"])/g, '$1.svelte.js$2'));
}
let component, dispose;
try {
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLMediaElement', 'HTMLInputElement', 'HTMLFormElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'])
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof f.window[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? f.window[key].bind(f.window) : f.window[key] });
  globalThis.game = f.game; globalThis.Hooks = { callAll: (name, payload) => f.hooks.fire(name, payload) };
  globalThis.foundry = { utils: { deepClone: structuredClone, randomID: () => crypto.randomUUID() } };
  await prepare('src/ui/svelte/apps/manager/CraftingSystemManagerRoot.svelte');
  await prepare('src/systems/CraftingSystemManager.js');
  await prepare('src/ui/svelte/stores/adminStore.js');
  const { mount, tick, unmount } = await import('svelte');
  const { writable } = await import('svelte/store');
  const { default: Root } = await import(pathToFileURL(resolve(temp, 'src/ui/svelte/apps/manager/CraftingSystemManagerRoot.svelte.js')));
  const { CraftingSystemManager } = await import(pathToFileURL(resolve(temp, 'src/systems/CraftingSystemManager.js')));
  const { SettingsCraftingDefinitionRepository } = await import(pathToFileURL(resolve(temp, 'src/systems/SettingsCraftingDefinitionRepository.js')));
  const { createAdminStore } = await import(pathToFileURL(resolve(temp, 'src/ui/svelte/stores/adminStore.js')));
  let persisted = [{ id: 'a', components: [{ id: 'one', name: 'Same', category: 'general', tags: ['native'] },
    { id: 'two', name: 'Same', category: 'general', tags: ['native'] }] }], sky = emptyData(), reject = false, rejectSky = false;
  const game = f.game; game.i18n.format = key => key;
  game.settings = { get: ns => ns === 'fabricate' ? structuredClone(persisted) : structuredClone(sky),
    set: async (ns, key, value) => { if ((reject && ns === 'fabricate') || (rejectSky && ns === 'skybricate')) throw Error('disk failure');
      if (ns === 'fabricate') persisted = structuredClone(value); else sky = structuredClone(value); } };
  const manager = new CraftingSystemManager({ getRecipes: () => [], save: async () => {}, notifyRecipesChanged() {},
    disableSignatureConflicts: async () => [] });
  manager.systems.set('a', structuredClone(persisted[0]));
  manager._cleanupSalvageRunsForComponent = async () => {};
  game.fabricate = { getCraftingSystemManager: () => manager };
  const data = new DataStore({ getGame: () => game, idFactory: () => 'p' }); await data.createProperty('a', { name: 'Hidden' });
  const selectedSystem = { id: 'a', name: 'A', resolutionMode: 'simple', features: { tags: true }, componentCategories: ['herb'], itemTags: ['native'] };
  const initial = { selectedSystem, systems: [{ ...selectedSystem, selected: true }], itemCards: structuredClone(persisted[0].components), recipes: [], environments: [] };
  const viewState = writable(initial), selectedSystemId = writable('a');
  let discard = false, confirmations = 0, nativeSaves = 0, nativePayload;
  const store = { viewState, selectedSystemId,
    confirmDiscardDirtyComponentDraft: () => { confirmations++; return discard; },
    updateComponent: async (id, updates) => { nativeSaves++; nativePayload = { id, updates }; return true; } };
  f.app._adminStore = store; f.root.replaceChildren();
  dispose = installAssignmentAdapter({ hooks: f.hooks, getGame: () => game, data, compatible: () => true,
    notifications: () => ({ warn: message => f.warnings.push(message) }), Observer: f.window.MutationObserver });
  component = mount(Root, { target: f.root, props: { store } });
  const settle = async () => { await tick(); await settleDOM(); };
  await settle(); f.render(); await settle();
  const nav = [...f.root.querySelectorAll('.manager-nav-button')].find(node => node.textContent.includes('Components'));
  assert(nav, 'real Components navigation'); nav.click(); await settle();
  f.root.querySelector('[data-component-edit="one"]').click(); await settle();
  const form = () => f.root.querySelector('#manager-component-edit-form');
  const panel = () => f.root.querySelector('[data-skybricate-assignments]');
  assert.equal(form().dataset.craftingSystemId, 'a'); assert.equal(form().dataset.componentId, 'one'); assert(panel());
  panel().querySelector('[data-sky-property="p"]').click(); panel().querySelector('[data-sky-assignment-action="save"]').click(); await settle();
  assert.deepEqual(sky.systems.a.components.one, ['p']);
  // Native tags remain native drafts and keep the existing navigation confirmation.
  const nativeTag = form().querySelector('[data-component-edit-tag-toggle="native"]');
  assert(nativeTag); nativeTag.click(); await settle();
  const back = f.root.querySelector('[data-component-edit-back]');
  assert(back, 'real native editor Back action'); back.click(); await settle();
  assert(confirmations > 0); assert.equal(form().dataset.componentId, 'one', 'cancelled native navigation keeps the original ID');
  discard = true; back.click(); await settle(); assert.equal(form(), null); assert.equal(panel(), null);
  f.root.querySelector('[data-component-edit="two"]').click(); await settle();
  assert.equal(form().dataset.componentId, 'two'); assert.equal(panel().querySelector('[data-sky-property="p"]').getAttribute('aria-pressed'), 'false');
  assert.equal(nativeSaves, 0, 'SkyBricate never saves native drafts');
  const mounted = panel(); f.render(); await settle(); assert.equal(panel(), mounted);
  const category = form().querySelector('[data-component-edit-category]'); category.value = 'herb';
  category.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.equal(nativeSaves, 1); assert.equal(nativePayload.id, 'two'); assert.equal(nativePayload.updates.category, 'herb');
  assert.deepEqual(sky.systems.a.components.one, ['p']);
  f.root.querySelector('[data-component-edit="one"]').click(); await settle();
  const renamed = { ...initial, itemCards: initial.itemCards.map(row => ({ ...row, name: 'Renamed', category: 'herb' })) };
  viewState.set(renamed); await settle(); assert.equal(form().dataset.componentId, 'one');
  assert.equal(panel().querySelector('[data-sky-property="p"]').getAttribute('aria-pressed'), 'true');
  f.close(); await settle(); assert.equal(panel(), null);
  await unmount(component); component = null;
  // Compile the ordinary upstream editor too: version 1.9.10 alone is insufficient.
  const originalPath = 'src/ui/svelte/apps/manager/ComponentEditView.svelte';
  const original = execFileSync('git', ['-C', upstream, 'show', `HEAD:${originalPath}`], { encoding: 'utf8' });
  const plainPath = resolve(temp, 'src/ui/svelte/apps/manager/ComponentEditView.unpatched.js');
  await writeFile(plainPath, compile(original, { filename: originalPath, generate: 'client', css: 'external' }).js.code
    .replace(/(from\s*['"][^'"]+)\.svelte(['"])/g, '$1.svelte.js$2'));
  const { default: Plain } = await import(pathToFileURL(plainPath));
  Object.defineProperty(manager, 'componentAssignmentContract', { configurable: true, value: undefined });
  component = mount(Plain, { target: f.root, props: { component: initial.itemCards[0], showTags: true } });
  f.render(); await settle(); assert.equal(form().hasAttribute('data-component-id'), false);
  assert.equal(panel(), null); assert.match(f.root.textContent, /AssignmentContract/);
  f.close(); await unmount(component); component = null; delete manager.componentAssignmentContract;
  console.log('PASS real manager/editor: identical component fields distinguished by IDs, native tag draft + cancelled/accepted navigation, remount and close.');

  // The real public deletion APIs share the actual repository write path.
  const events = []; f.hooks.on('fabricate.componentsDeleted', payload => events.push(payload));
  let confirmDelete = false;
  const admin = createAdminStore({ getSetting: key => key === 'lastManagedCraftingSystem' ? 'a' : undefined,
    getCraftingSystemManager: () => manager, getRecipeManager: () => manager.recipeManager,
    isFabricateReady: () => false, confirmDialog: async () => confirmDelete });
  await admin.deleteComponent('one'); await settle(); assert.equal(events.length, 0);
  assert(persisted[0].components.some(row => row.id === 'one'), 'cancelled native delete keeps component and assignments');
  assert.deepEqual(sky.systems.a.components.one, ['p']); admin.destroy();
  await data.setComponentProperties('a', 'two', ['p']);
  rejectSky = true;
  await manager.deleteItem('a', 'one'); await settle();
  assert.deepEqual(events, [{ systemId: 'a', componentIds: ['one'] }]);
  assert(!persisted[0].components.some(row => row.id === 'one')); assert(sky.systems.a.components.one);
  assert.match(f.warnings.at(-1), /SyncError/); rejectSky = false;
  await data.reconcileComponentProperties('a');
  assert.equal(sky.systems.a.components.one, undefined); assert.deepEqual(sky.systems.a.components.two, ['p']);
  const bulk = [{ id: 'two', name: 'Same' }, { id: 'three', name: 'Same' }];
  manager.systems.get('a').components = bulk; await manager.save({ put: manager.systems.get('a') });
  await data.setComponentProperties('a', 'three', ['p']);
  reject = true; await assert.rejects(manager.deleteComponents('a', ['two', 'three'])); await settle();
  assert.equal(events.length, 1); assert(sky.systems.a.components.two); assert(sky.systems.a.components.three);
  reject = false; manager.systems.get('a').components = structuredClone(bulk);
  await manager.deleteComponents('a', ['two', 'three']); await settle();
  assert.deepEqual(events.at(-1), { systemId: 'a', componentIds: ['two', 'three'] });
  assert.deepEqual(sky.systems.a.components, {});
  const count = events.length; await manager.deleteComponents('a', ['two']); assert.equal(events.length, count);
  // Direct/batched repository writes also use the contract and only announce after flush.
  const corpus = new Map([['a', { id: 'a', components: [{ id: 'x' }, { id: 'y' }] }]]);
  persisted = structuredClone([...corpus.values()]);
  const repo = new SettingsCraftingDefinitionRepository({ settingKey: 'craftingSystems', corpus: () => corpus });
  await repo.runBatch(async () => {
    corpus.get('a').components = []; await repo.put(corpus.get('a')); assert.equal(events.length, count);
  });
  assert.deepEqual(events.at(-1), { systemId: 'a', componentIds: ['x', 'y'] });
  // A closed/reloaded client can reconcile a missed notification from full storage.
  manager.systems.get('a').components = [{ id: 'missed', name: 'Same' }]; await manager.save({ put: manager.systems.get('a') });
  await data.setComponentProperties('a', 'missed', ['p']); dispose(); dispose = null;
  await manager.deleteItem('a', 'missed'); assert(sky.systems.a.components.missed);
  const afterReload = new DataStore({ getGame: () => game }); await afterReload.reconcileComponentProperties('a');
  assert.equal(sky.systems.a.components.missed, undefined);
  console.log('PASS real single/bulk deletion APIs + repository batch, rejected persistence and absent IDs, confirmed cleanup through SkyBricate.');
} finally {
  dispose?.(); f.destroy(); await rm(temp, { recursive: true, force: true });
}
