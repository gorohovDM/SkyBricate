// Mounts committed stock 1.9.10 browser/editor and runs stock recipe persistence/checks.
// No Foundry launch, Fabricate patch or third-party build.
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { Window } from 'happy-dom';
import { stockSources } from './fabricate-source.mjs';
import { DataStore } from '../scripts/data-store.js';
import { emptyData } from '../scripts/data-model.js';
import { mountRecipePanel } from '../scripts/recipe-panel.js';
import { recipeContext } from '../scripts/recipe-contract.js';
import { installManagerAdapter } from '../scripts/manager-adapter.js';
import { hookBus, readable } from '../tests/helpers/manager-fixture.mjs';

const { upstream, read } = stockSources(process.argv[2]);
const cache = resolve('node_modules/.cache'); await mkdir(cache, { recursive: true });
const temp = await mkdtemp(resolve(cache, 'skybricate-recipes-')), copied = new Set(), window = new Window();
let dispose = () => {}, panel = null, component = null, unmount;
async function prepare(path) {
  if (copied.has(path)) return; copied.add(path);
  const source = read(path), out = resolve(temp, path + (path.endsWith('.svelte') ? '.js' : '')); await mkdir(dirname(out), { recursive: true });
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) await prepare(relative(upstream, resolve(upstream, dirname(path), match[1])).replaceAll('\\', '/'));
  }
  const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', css: 'external' }).js.code : source;
  await writeFile(out, code.replace(/(from\s*['"][^'"]+)\.svelte(['"])/g, '$1.svelte.js$2'));
}
try {
  for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLMediaElement', 'HTMLInputElement', 'HTMLFormElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? window[key].bind(window) : window[key] });
  }
  const root = window.document.createElement('div'), rulesTarget = window.document.createElement('div'); window.document.body.append(root, rulesTarget);
  const hooks = hookBus(), warnings = [], game = { user: { isGM: true }, modules: new Map([['fabricate', { active: true, version: '1.9.10' }]]),
    i18n: { localize: key => key, format: key => key }, actors: { contents: [] } };
  const systems = ['a', 'b'].map(id => ({ id, name: id, resolutionMode: 'simple', craftingCheck: { enabled: true, simple: { rollFormula: "1d20" } },
    components: [], featureConfig: { currency: { enabled: false } } }));
  let sky = emptyData(), savedRecipes = [], nativeWrites = 0, idCount = 0;
  game.settings = {
    settings: new Map(['craftingSystems', 'recipes'].map(key => [`fabricate.${key}`, { scope: 'world', type: Array }])),
    get: (ns, key) => structuredClone(ns === 'skybricate' ? sky : key === 'craftingSystems' ? systems : key === 'recipes' ? savedRecipes : null),
    set: async (ns, key, value) => {
      if (ns === 'skybricate') { sky = structuredClone(value); return; }
      assert.equal(key, 'recipes'); savedRecipes = structuredClone(value); nativeWrites++;
      hooks.fire('updateSetting', { key: 'fabricate.recipes' });
    }
  };
  globalThis.game = game; globalThis.Hooks = { callAll: (name, ...args) => hooks.fire(name, ...args) };
  globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
  globalThis.foundry = { utils: { deepClone: structuredClone, randomID: () => `native${++idCount}` } };
  await prepare('src/ui/svelte/apps/manager/RecipesBrowserView.svelte');
  await prepare('src/ui/svelte/apps/manager/RecipeEditView.svelte');
  await prepare('src/systems/RecipeManager.js'); await prepare('src/systems/checkRoll.js');
  const stock = path => import(pathToFileURL(resolve(temp, path)));
  const { RecipeManager } = await stock('src/systems/RecipeManager.js');
  const manager = new RecipeManager({ getCraftingSystem: id => systems.find(row => row.id === id),
    getCraftingSystemManager: () => ({ getSystem: id => systems.find(row => row.id === id) }) });
  game.fabricate = { getRecipeManager: () => manager };
  const created = await manager.createRecipe({ craftingSystemId: 'a', enabled: false }, { allowIncomplete: true });
  const second = await manager.createRecipe({ craftingSystemId: 'a', name: 'Second', enabled: false }, { allowIncomplete: true });
  const other = await manager.createRecipe({ craftingSystemId: 'b', name: 'Other', enabled: false }, { allowIncomplete: true });
  assert.equal(savedRecipes.find(row => row.id === created.id).enabled, false);
  assert(read('src/ui/svelte/stores/adminStore.js').includes('{ craftingSystemId: sysId, enabled: false }'));
  const data = new DataStore({ getGame: () => game, idFactory: () => 'property' });
  await data.createProperty('a', { name: 'Property' });
  const app = { options: { id: 'fabricate-crafting-system-manager' }, element: root,
    _adminStore: { selectedSystemId: readable('a'), viewState: readable({ selectedSystem: { id: 'a', resolutionMode: 'simple' } }) } };
  const opens = [];
  dispose = installManagerAdapter({ hooks, getGame: () => game, data, compatible: () => true,
    notifications: () => ({ warn: warning => warnings.push(warning) }), Observer: window.MutationObserver,
    openRecipeRules: (systemId, recipeId, canWrite) => {
      opens.push([systemId, recipeId]); panel?.dispose();
      panel = mountRecipePanel({ target: rulesTarget, getGame: () => game, data, systemId, recipeId, canWrite, text: key => key });
    } });
  const wrapper = `<script>
    import Browser from './src/ui/svelte/apps/manager/RecipesBrowserView.svelte.js';
    import Editor from './src/ui/svelte/apps/manager/RecipeEditView.svelte.js';
    let { state, onEdit, onUpdate, onSave } = $props();
    const value = state;
    </script>
    {#if $value.editing}<button data-native-save onclick={onSave}>Save</button><Editor recipe={$value.draft} onUpdateRecipe={onUpdate}/>
    {:else}<Browser recipes={$value.recipes} selectedSystemId={$value.systemId} onEditRecipe={onEdit}/>{/if}`;
  await writeFile(resolve(temp, 'Wrapper.js'), compile(wrapper, { filename: 'Wrapper.svelte', generate: 'client' }).js.code);
  const svelte = await import('svelte'); unmount = svelte.unmount;
  const { writable } = await import('svelte/store'), { default: Wrapper } = await stock('Wrapper.js');
  const state = writable({ systemId: 'a', recipes: [created.toJSON(), second.toJSON()], editing: false });
  let editedId = null, draft = null;
  component = svelte.mount(Wrapper, { target: root, props: { state,
    onEdit: id => { editedId = id; draft = structuredClone(manager.getRecipe(id).toJSON()); state.set({ editing: true, draft }); },
    onUpdate: patch => { draft = { ...draft, ...patch }; state.set({ editing: true, draft }); },
    onSave: async () => { await manager.updateRecipe(editedId, draft, { allowIncomplete: true }); }
  } });
  const settle = async () => { await svelte.tick(); await window.happyDOM.waitUntilComplete(); };
  await settle(); hooks.fire('renderApplicationV2', app, root); await settle();
  const button = id => root.querySelector(`[data-skybricate-recipe="${id}"]`);
  assert(button(created.id)); assert(button(second.id));
  button(created.id).click(); await settle(); assert.deepEqual(opens.at(-1), ['a', created.id]);
  const count = nativeWrites;
  rulesTarget.querySelector('[data-sky-recipe-action="add"]').click();
  const strength = rulesTarget.querySelector('[data-sky-strength="pass"]'); assert(strength); assert.equal(strength.disabled, false);
  strength.value = '2.5'; rulesTarget.querySelector('[data-sky-strength="fail"]').value = '0.5';
  rulesTarget.querySelector('[data-sky-recipe-action="save"]').click();
  await settle(); assert.deepEqual(sky.systems.a.recipeRules[created.id].allowedPropertyIds, ['property']); assert.equal(nativeWrites, count);
  assert.deepEqual(sky.systems.a.recipeRules[created.id].outcomeStrengths, { fail: 0.5, pass: 2.5 });
  assert.equal(sky.systems.a.recipeRules[created.id].limitByCheck, false); assert.equal(sky.schemaVersion, 7);
  assert.equal(sky.systems.a.recipeRules[second.id], undefined);
  hooks.fire('renderApplicationV2', app, root); await settle(); assert.equal(root.querySelectorAll('[data-skybricate-recipe]').length, 2);
  // Native editor still receives the row ID and stages its own draft independently.
  root.querySelector(`[data-recipe-edit="${created.id}"]`).click(); await settle();
  assert.equal(editedId, created.id); assert(root.querySelector('[data-recipe-editor]'));
  // Drive the actual stock overview identity input, then native persistence.
  const input = root.querySelector('[data-recipe-editor] input[type="text"]');
  assert(input); input.value = 'Native renamed'; input.dispatchEvent(new window.Event('input', { bubbles: true })); await settle();
  assert.equal(draft.name, 'Native renamed'); assert.notEqual(savedRecipes.find(row => row.id === created.id).name, draft.name);
  root.querySelector('[data-native-save]').click(); await settle();
  assert.equal(savedRecipes.find(row => row.id === created.id).name, 'Native renamed');
  assert.deepEqual(sky.systems.a.recipeRules[created.id].allowedPropertyIds, ['property']);
  app._adminStore.selectedSystemId.set('b');
  app._adminStore.viewState.set({ selectedSystem: { id: 'b', resolutionMode: 'simple' } });
  state.set({ editing: false, systemId: 'b', recipes: [other.toJSON()] }); await settle();
  assert(button(other.id)); assert.equal(button(created.id), null); button(other.id).click(); await settle(); assert.deepEqual(opens.at(-1), ['b', other.id]);
  const { runFormulaPassFail, runFormulaRouted } = await stock('src/systems/checkRoll.js');
  const simple = await runFormulaPassFail({ formula: '', dc: 0 }); assert.equal(simple.outcome, 'pass');
  assert.deepEqual(recipeContext(game, 'a', created.id).outcomes.map(row => row.id), ['fail', 'pass']);
  const routed = await runFormulaRouted({ formula: '', dc: 0, type: 'relative', relativeOutcomes: [{ id: 'tier', name: 'Display name', dc: 0, success: true }] });
  assert.equal(routed.outcome, 'Display name'); assert.equal(routed.data.outcomeId, 'tier');
  assert.deepEqual(warnings, []);
  console.log('PASS stock 1.9.10: saved disabled recipe IDs, real mounted recipe rows/editor, exact rule identity/isolation, separate strength/count fields and schema7 save, native draft/save, repeated render/system switch, pass/fail and routed outcome IDs.');
} finally {
  dispose(); panel?.dispose(); if (component) await unmount(component); window.happyDOM.abort(); await rm(temp, { recursive: true, force: true });
}
