import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../scripts/data-store.js';
import { emptyData } from '../scripts/data-model.js';
import { installAssignmentAdapter } from '../scripts/assignment-adapter.js';
import { managerFixture, settleDOM } from './helpers/manager-fixture.mjs';

function fixture() {
  let stored = emptyData(), writes = 0, reject = false, gate = null, readFailure = false;
  const f = managerFixture({ getSnapshot: () => stored });
  const systems = { a: ['same', 'other'], b: ['same', 'other'] };
  const contract = { version: 'fabricate-component-assignments-v1', deletedHook: 'fabricate.componentsDeleted',
    readPersistedSystem: systemId => {
      if (readFailure) throw Error('read failed');
      return { systemId, complete: true, componentIds: [...systems[systemId]] };
    } };
  f.game.fabricate = { getCraftingSystemManager: () => ({ componentAssignmentContract: contract }) };
  f.game.settings = { get: () => structuredClone(stored), set: async (ns, key, value) => {
    if (gate) await gate; if (reject) throw Error('<img src=x onerror=alert(1)>');
    stored = structuredClone(value); writes++;
  } };
  let next = 0;
  const data = new DataStore({ getGame: () => f.game, idFactory: () => `p${++next}` });
  // The assignment adapter has an independent application lifetime from vocabulary.
  const disposeAssignments = installAssignmentAdapter({ hooks: f.hooks, getGame: () => f.game, data,
    compatible: () => true, notifications: () => ({ warn: text => f.warnings.push(text) }), Observer: f.window.MutationObserver });
  const panel = () => f.root.querySelector('[data-skybricate-assignments]');
  const form = () => f.root.querySelector('form');
  const open = (systemId = 'a', componentId = 'same') => {
    f.selectedSystemId.set(systemId); f.viewState.set({ selectedSystem: { id: systemId, resolutionMode: 'simple' } });
    f.root.innerHTML = `<form id="manager-component-edit-form" class="manager-component-edit-view" data-crafting-system-id="${systemId}" data-component-id="${componentId}"><section data-component-edit-section="tags">Native tags</section><input name="native" value="Native"></form>`;
    f.render();
  };
  return Object.assign(f, { data, systems, contract, panel, form, open, writes: () => writes,
    snapshot: () => structuredClone(stored), reject: value => { reject = value; }, gate: value => { gate = value; },
    readFailure: value => { readFailure = value; },
    destroyAll() { disposeAssignments(); f.destroy(); } });
}
const button = (f, action) => f.panel().querySelector(`[data-sky-assignment-action="${action}"]`);
const toggle = (f, id) => f.panel().querySelector(`[data-sky-property="${id}"]`);
const save = f => button(f, 'save').click();
const status = f => f.panel().querySelector('[role="status"]').textContent;

test('component assignments: isolated persisted IDs, own assignments only, safe strings, empty selection/catalog', async t => {
  const f = fixture(); t.after(() => f.destroyAll());
  const p = await f.data.createProperty('a', { name: '<img src=x>', description: '<script>' });
  await f.data.createProperty('b', { name: 'Other system' });
  await f.data.setCategoryProperties('a', 'category', [p]);
  f.open(); await settleDOM(); assert(f.panel()); assert.equal(toggle(f, p).getAttribute('aria-pressed'), 'false');
  assert.equal(f.panel().querySelector('img'), null); assert.equal(toggle(f, p).textContent, '<img src=x>');
  toggle(f, p).click(); save(f); await settleDOM(); assert.equal(status(f), 'Saved');
  assert.deepEqual(f.snapshot().systems.a.components.same, [p]);
  f.open('a', 'other'); await settleDOM(); assert.equal(toggle(f, p).getAttribute('aria-pressed'), 'false');
  f.open('a', 'same'); await settleDOM(); assert.equal(toggle(f, p).getAttribute('aria-pressed'), 'true');
  toggle(f, p).click(); save(f); await settleDOM();
  f.open(); await settleDOM(); assert.equal(toggle(f, p).getAttribute('aria-pressed'), 'false');
  assert.deepEqual(f.snapshot().systems.a.components.same, []);
  f.open('b'); await settleDOM(); assert.equal(toggle(f, p), null);
  await f.data.deleteProperty('b', 'p2'); f.open('b'); await settleDOM(); assert.match(f.panel().textContent, /AssignmentEmpty/);
  assert.equal(f.panel().querySelectorAll('[data-sky-property]').length, 0);
});

test('assignment async saves: pending/retry, navigation, stale detached actions, close and GM loss', async t => {
  const f = fixture(); t.after(() => f.destroyAll()); const p = await f.data.createProperty('a', { name: 'P' });
  f.open(); await settleDOM(); toggle(f, p).click(); f.reject(true); save(f); await settleDOM();
  assert.match(status(f), /Error/); assert.equal(toggle(f, p).getAttribute('aria-pressed'), 'true'); assert.equal(f.panel().querySelector('img'), null);
  f.reject(false); let finish; f.gate(new Promise(resolve => { finish = resolve; }));
  const old = f.panel(); save(f); save(f); await Promise.resolve(); assert.equal(old.getAttribute('aria-busy'), 'true');
  const count = f.writes(); f.form().dataset.componentId = 'other'; await settleDOM(); assert.notEqual(f.panel(), old);
  finish(); f.gate(null); await settleDOM(); assert.equal(f.writes(), count + 1);
  assert.deepEqual(f.snapshot().systems.a.components.same, [p]); assert.equal(status(f), '');
  old.querySelector('button').click(); await settleDOM(); assert.equal(f.writes(), count + 1);
  const current = f.panel(); f.render(); await settleDOM(); assert.equal(f.panel(), current);
  const observerCount = f.observerCallbacks; await settleDOM(); assert.equal(f.observerCallbacks, observerCount);
  f.game.user.isGM = false; save(f); await settleDOM(); assert.equal(f.writes(), count + 1);
  f.hooks.fire('updateUser'); await settleDOM(); assert.equal(f.panel(), null);
  f.game.user.isGM = true; f.render(); await settleDOM(); assert(f.panel());
  const stale = f.panel(); f.close(); stale.querySelector('button').click(); await settleDOM(); assert.equal(f.panel(), null);
});

test('assignment form contracts fail closed on absent/mismatched/partial IDs and unsupported contract', async t => {
  const f = fixture(); t.after(() => f.destroyAll()); await f.data.createProperty('a', { name: 'P' });
  f.open(); await settleDOM();
  for (const change of [() => { f.form().dataset.componentId = 'missing'; },
    () => { delete f.form().dataset.craftingSystemId; }, () => { f.form().dataset.craftingSystemId = 'b'; }]) {
    change(); await settleDOM(); assert.equal(f.panel(), null);
    assert.match(f.root.querySelector('[data-skybricate-sync]').textContent, /AssignmentContract/);
  }
  f.open(); f.contract.version = 'unknown'; await settleDOM(); assert.equal(f.panel(), null);
  assert.match(f.root.textContent, /AssignmentContract/);
  assert.equal(f.writes(), 1);
});

test('cleanup confirmed IDs only, idempotence, failure/retry, missed events and invalid full snapshot', async t => {
  const f = fixture(); t.after(() => f.destroyAll());
  for (const systemId of ['a', 'b']) { const p = await f.data.createProperty(systemId, { name: 'P' });
    await f.data.setComponentProperties(systemId, 'same', [p]); await f.data.setComponentProperties(systemId, 'other', [p]); }
  f.open(); await settleDOM(); f.systems.a = ['other']; f.reject(true);
  f.hooks.fire('fabricate.componentsDeleted', { systemId: 'a', componentIds: ['same', 'other'] }); await settleDOM();
  assert(f.snapshot().systems.a.components.same); assert.match(f.warnings.at(-1), /SyncError/);
  f.reject(false); f.readFailure(true);
  f.root.querySelector('[data-skybricate-sync] button').click(); await settleDOM(); assert(f.snapshot().systems.a.components.same);
  f.readFailure(false); f.root.querySelector('[data-skybricate-sync] button').click(); await settleDOM();
  assert.equal(f.snapshot().systems.a.components.same, undefined); assert(f.snapshot().systems.a.components.other);
  assert(f.snapshot().systems.b.components.same);
  for (let i = 0; i < 2; i++) f.hooks.fire('fabricate.componentsDeleted', { systemId: 'a', componentIds: ['same'] });
  await settleDOM(); assert(f.snapshot().systems.a.components.other);
  // Reopen/refresh restores synchronization after a missed event, including a reload.
  f.systems.b = ['other']; f.close(); f.open('b', 'other'); await settleDOM();
  f.root.querySelector('[data-skybricate-sync] button').click(); await settleDOM(); assert.equal(f.snapshot().systems.b.components.same, undefined);
  const original = f.contract.readPersistedSystem;
  f.contract.readPersistedSystem = systemId => ({ systemId, complete: false, componentIds: [] });
  await assert.rejects(f.data.reconcileComponentProperties('b')); assert(f.snapshot().systems.b.components.other);
  f.contract.readPersistedSystem = original;
  f.systems.a.push('new'); f.open('a', 'new'); await settleDOM(); assert.equal(toggle(f, 'p1').getAttribute('aria-pressed'), 'false');
  assert.equal(f.hooks.count('fabricate.componentsDeleted'), 1);
});

test('DataStore validates component existence and context when queued; property deletion/GM/contract refuse writes', async t => {
  const f = fixture(); t.after(() => f.destroyAll()); const p = await f.data.createProperty('a', { name: 'P' });
  await assert.rejects(f.data.setComponentProperties('a', 'missing', [p]));
  let valid = true; const save = f.data.setComponentProperties('a', 'same', [p], { canWrite: () => valid }); valid = false;
  await assert.rejects(save); await f.data.deleteProperty('a', p);
  await assert.rejects(f.data.setComponentProperties('a', 'same', [p]));
  f.game.user.isGM = false; await assert.rejects(f.data.reconcileComponentProperties('a'));
  f.game.user.isGM = true; f.contract.version = 'unknown'; await assert.rejects(f.data.setComponentProperties('a', 'same', []));
});

test('queued UI save refuses changed form, deleted component or GM loss before its write begins', async t => {
  for (const change of ['navigation', 'deletion', 'permission']) {
    const f = fixture(); t.after(() => f.destroyAll()); const p = await f.data.createProperty('a', { name: 'P' });
    f.open(); await settleDOM(); toggle(f, p).click();
    let release; f.gate(new Promise(resolve => { release = resolve; }));
    const first = f.data.ensureSystem('b'); await Promise.resolve();
    save(f); const before = f.writes();
    if (change === 'navigation') f.form().dataset.componentId = 'other';
    if (change === 'deletion') f.systems.a = ['other'];
    if (change === 'permission') f.game.user.isGM = false;
    release(); f.gate(null); await first; await settleDOM();
    assert.equal(f.writes(), before + 1); assert.equal(f.snapshot().systems.a.components.same, undefined);
  }
});

test('two manager windows keep independent selections and dispose without duplicate global deletion subscriptions', async t => {
  const f = fixture(); t.after(() => f.destroyAll()); const p = await f.data.createProperty('a', { name: 'P' });
  f.open(); await settleDOM();
  const root2 = f.root.cloneNode(false); f.window.document.body.append(root2);
  const app2 = { ...f.app, element: root2 };
  root2.innerHTML = '<form id="manager-component-edit-form" class="manager-component-edit-view" data-crafting-system-id="a" data-component-id="other"></form>';
  f.hooks.fire('renderApplicationV2', app2, root2); await settleDOM();
  const second = root2.querySelector('[data-skybricate-assignments]'); assert(second);
  toggle(f, p).click(); assert.equal(second.querySelector('[data-sky-property]').getAttribute('aria-pressed'), 'false');
  save(f); await settleDOM(); second.querySelector('[data-sky-property]').click();
  second.querySelector('[data-sky-assignment-action="save"]').click(); await settleDOM();
  assert.deepEqual(f.snapshot().systems.a.components, { same: [p], other: [p] });
  f.close(); assert.equal(f.panel(), null); assert(second.isConnected);
  f.hooks.fire('renderApplicationV2', app2, root2); await settleDOM();
  assert.equal(root2.querySelectorAll('[data-skybricate-assignments]').length, 1);
  assert.equal(f.hooks.count('fabricate.componentsDeleted'), 1);
  f.hooks.fire('closeApplicationV2', app2); assert.equal(second.isConnected, false); root2.remove();
});
