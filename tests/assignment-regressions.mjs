import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { DataStore } from '../scripts/data-store.js';
import { emptyData } from '../scripts/data-model.js';
import { persistedSystems, persistedComponents } from '../scripts/assignment-contract.js';
import { mountAssignmentPanel } from '../scripts/assignment-panel.js';
import { createAssignmentApplication, registerAssignmentMenu } from '../scripts/assignment-adapter.js';

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  let stored = emptyData(), writes = 0, reject = false, gate = null, readFailure = false;
  let corpus = ['a', 'b'].map(id => ({ id, name: 'Same', components: [{ id: 'same', name: '<img src=x>' }, { id: 'other', name: '<img src=x>' }] }));
  const game = { user: { isGM: true }, modules: new Map([['fabricate', { active: true, version: '1.9.10' }]]),
    i18n: { localize: key => key.split('.').at(-1) }, settings: {
      settings: new Map([['fabricate.craftingSystems', { scope: 'world', type: Array }]]),
      get: ns => { if (ns === 'fabricate') { if (readFailure) throw Error('read failure'); return structuredClone(corpus); } return structuredClone(stored); },
      set: async (ns, key, value) => { assert.equal(ns, 'skybricate'); if (gate) await gate;
        if (reject) throw Error('<img src=x>'); stored = structuredClone(value); writes++; }
    } };
  let next = 0;
  const data = new DataStore({ getGame: () => game, idFactory: () => `p${++next}` });
  const panels = [];
  const f = { window, root, game, data, get corpus() { return corpus; }, set corpus(value) { corpus = value; },
    get snapshot() { return structuredClone(stored); }, get writes() { return writes; },
    set reject(value) { reject = value; }, set gate(value) { gate = value; }, set readFailure(value) { readFailure = value; },
    mount(target = root) { const panel = mountAssignmentPanel({ target, getGame: () => game, data,
      canWrite: () => game.user.isGM, text: key => key }); panels.push(panel); return panel; },
    destroy() { panels.forEach(panel => panel.dispose()); window.happyDOM.abort(); } };
  return f;
}
const action = (root, name) => root.querySelector(`[data-sky-assignment-action="${name}"]`);
const chip = (root, id = 'p1') => root.querySelector(`[data-sky-property="${id}"]`);
function choose(f, root, kind, value) {
  const node = root.querySelector(`[data-sky-${kind}]`); node.value = value;
  node.dispatchEvent(new f.window.Event('change', { bubbles: true }));
}

test('standalone editor: saved IDs, scoped catalogs, own properties, clear, refresh, safe text and empty states', async t => {
  const f = fixture(); t.after(() => f.destroy());
  const p = await f.data.createProperty('a', { name: '<img src=x>', description: '<script>' });
  await f.data.createProperty('b', { name: 'B' }); await f.data.setCategoryProperties('a', 'category', [p]);
  f.mount(); await settle(); assert.equal(f.root.querySelector('img'), null);
  assert.match(f.root.querySelector('[data-sky-system]').textContent, /Same \[a\].*Same \[b\]/);
  assert.match(f.root.querySelector('[data-sky-component]').textContent, /\[same\].*\[other\]/);
  assert.equal(chip(f.root).getAttribute('aria-pressed'), 'false'); chip(f.root).click(); action(f.root, 'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components.same, [p]);
  choose(f, f.root, 'component', 'other'); assert.equal(chip(f.root).getAttribute('aria-pressed'), 'false');
  choose(f, f.root, 'component', 'same'); assert.equal(chip(f.root).getAttribute('aria-pressed'), 'true');
  action(f.root, 'clear').click(); action(f.root, 'save').click(); await settle(); assert.deepEqual(f.snapshot.systems.a.components.same, []);
  chip(f.root).click(); action(f.root, 'refresh').click(); await settle(); assert.equal(chip(f.root).getAttribute('aria-pressed'), 'false');
  choose(f, f.root, 'system', 'b'); assert.equal(chip(f.root), null); await f.data.deleteProperty('b', 'p2');
  action(f.root, 'refresh').click(); await settle(); assert.match(f.root.textContent, /AssignmentEmpty/);
  f.corpus[1].components = []; action(f.root, 'refresh').click(); await settle(); assert.match(f.root.textContent, /NoComponents/);
  f.corpus = []; action(f.root, 'refresh').click(); await settle(); assert.match(f.root.textContent, /NoSystems/);
});

test('save errors keep selection; pending blocks duplicate saves/navigation; stale DOM and GM loss cannot write', async t => {
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  const panel = f.mount(); await settle(); chip(f.root).click(); f.reject = true; action(f.root, 'save').click(); await settle();
  assert.match(f.root.querySelector('[role=status]').textContent, /Error/); assert.equal(chip(f.root).getAttribute('aria-pressed'), 'true');
  assert.equal(f.root.querySelector('img'), null); f.reject = false;
  let release; f.gate = new Promise(resolve => { release = resolve; }); const before = f.writes;
  action(f.root, 'save').click(); action(f.root, 'save').click(); choose(f, f.root, 'component', 'other');
  assert.equal(f.root.querySelector('[data-sky-component]').value, 'same');
  release(); f.gate = null; await settle(); assert.equal(f.writes, before + 1); assert.deepEqual(f.snapshot.systems.a.components.same, ['p1']);
  const stale = panel.element; panel.dispose(); action(stale, 'save').click(); await settle(); assert.equal(f.writes, before + 1);
  f.mount(); await settle(); f.game.user.isGM = false; action(f.root, 'save').click(); await settle(); assert.equal(f.writes, before + 2);
});

test('full persisted setting adapter refuses malformed/unknown contracts without clearing data', async t => {
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  await f.data.setComponentProperties('a', 'same', ['p1']); const before = f.snapshot, writes = f.writes, corpus = f.corpus;
  for (const invalid of [undefined, null, {}, [{ id: 'a' }], [{ id: 'a', components: null }],
    [{ id: 'a', components: [{ id: 'same' }, { id: 'same' }] }], [corpus[0], corpus[0]],
    [{ id: '__proto__', components: [] }], [{ id: 'a', components: [{ id: 1 }] }]]) {
    f.corpus = invalid; assert.throws(() => persistedSystems(f.game)); await assert.rejects(f.data.reconcileAllComponentProperties());
    assert.deepEqual(f.snapshot, before); assert.equal(f.writes, writes);
  }
  f.corpus = corpus;
  for (const mutate of [() => { f.game.modules.get('fabricate').version = '2'; },
    () => { f.game.modules.get('fabricate').version = '1.9.10'; f.game.settings.settings.get('fabricate.craftingSystems').scope = 'client'; },
    () => { f.game.settings.settings.clear(); }]) {
    mutate(); await assert.rejects(f.data.reconcileAllComponentProperties()); assert.deepEqual(f.snapshot, before);
  }
});

test('opening/reloading reconciles complete saved lists only, preserving absent systems and failed reads/writes', async t => {
  const f = fixture(); t.after(() => f.destroy());
  for (const id of ['a', 'b']) { const p = await f.data.createProperty(id, { name: 'P' }); await f.data.setComponentProperties(id, 'same', [p]); }
  f.corpus[0].components = []; const b = f.corpus.pop(); f.readFailure = true;
  const panel = f.mount(); await settle(); assert(f.snapshot.systems.a.components.same);
  f.readFailure = false; f.reject = true; await panel.refresh(); assert(f.snapshot.systems.a.components.same);
  f.reject = false; await panel.refresh(); assert.equal(f.snapshot.systems.a.components.same, undefined); assert(f.snapshot.systems.b.components.same);
  await assert.rejects(f.data.reconcileComponentProperties('b')); assert.throws(() => persistedComponents(f.game, 'b'));
  f.corpus.push(b); b.components = []; panel.dispose(); f.mount(); await settle(); assert.equal(f.snapshot.systems.b.components.same, undefined);
});

test('queued assignment/cleanup recheck component, GM, closed window and corpus at execution', async t => {
  for (const change of ['delete', 'GM', 'close', 'unknown']) {
    const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
    const panel = f.mount(); await settle(); chip(f.root).click();
    let release; f.gate = new Promise(resolve => { release = resolve; });
    const first = f.data.ensureSystem('b'); await settle(); action(f.root, 'save').click();
    if (change === 'delete') f.corpus[0].components = [];
    if (change === 'GM') f.game.user.isGM = false;
    if (change === 'close') panel.dispose();
    if (change === 'unknown') f.corpus = null;
    release(); f.gate = null; await first; await settle(); assert.equal(f.snapshot.systems.a.components.same, undefined);
  }
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  await f.data.setComponentProperties('a', 'same', ['p1']);
  const cleanup = f.data.reconcileAllComponentProperties(); f.readFailure = true;
  await assert.rejects(cleanup); assert(f.snapshot.systems.a.components.same);
});

test('two independent windows keep selections; no Fabricate window or hooks are needed', async t => {
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  const second = f.window.document.createElement('div'); f.window.document.body.append(second);
  const first = f.mount(); f.mount(second); await settle(); choose(f, second, 'component', 'other');
  chip(f.root).click(); assert.equal(chip(second).getAttribute('aria-pressed'), 'false');
  action(f.root, 'save').click(); await settle(); chip(second).click(); action(second, 'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components, { same: ['p1'], other: ['p1'] }); first.dispose(); assert(chip(second).isConnected);
});

test('ApplicationV2 settings menu/render lifecycle handles detached content, rerender, close/reopen and permissions', async t => {
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  class Base { _onRender() {} _onClose() {} async close() { this._onClose(); } }
  const Application = createAssignmentApplication({ ApplicationV2: Base, getGame: () => f.game, getData: () => f.data, compatible: () => true });
  let registration; registerAssignmentMenu({ registerMenu: (...args) => { registration = args; } }, Application);
  assert.equal(registration[0], 'skybricate'); assert.equal(registration[2].restricted, true); assert.equal(registration[2].type, Application);
  const app = new Application(), content = f.window.document.createElement('div');
  assert.equal(app._canRender(), undefined); app._replaceHTML(await app._renderHTML(), content); assert.equal(f.writes, 1);
  f.root.append(content); app._onRender(); await settle(); assert(chip(content)); chip(content).click();
  const before = app._assignments; app._replaceHTML(null, content); app._onRender(); await settle();
  assert.equal(app._assignments, before); assert.equal(chip(content).getAttribute('aria-pressed'), 'true');
  await app.close(); assert.equal(content.children.length, 0); app._replaceHTML(null, content); app._onRender(); await settle();
  assert.equal(chip(content).getAttribute('aria-pressed'), 'false'); f.game.user.isGM = false; assert.equal(app._canRender(), false);
  await app.close();
});
