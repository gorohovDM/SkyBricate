import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { DataStore, registerDataSetting } from '../scripts/data-store.js';
import { emptyData } from '../scripts/data-model.js';
import { persistedSystems, persistedComponents } from '../scripts/assignment-contract.js';
import { mountAssignmentPanel } from '../scripts/assignment-panel.js';
import { createAssignmentApplication, registerAssignmentMenu } from '../scripts/assignment-adapter.js';

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function fixture() {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  let specialEnabled = false; const registrations = new Map();
  let stored = emptyData(), writes = 0, reject = false, gate = null, readFailure = false;
  let corpus = ['a', 'b'].map(id => ({ id, name: 'Same', components: [{ id: 'same', name: '<img src=x>' }, { id: 'other', name: '<img src=x>' }] }));
  const game = { user: { isGM: true }, modules: new Map([['fabricate', { active: true, version: '1.9.10' }]]),
    i18n: { localize: key => key.split('.').at(-1) }, settings: {
      register: (ns, key, options) => registrations.set(key, options),
      settings: new Map([['fabricate.craftingSystems', { scope: 'world', type: Array }]]),
      get: (ns, key) => { if (key === 'showSpecialProperties') return specialEnabled; if (ns === 'fabricate') { if (readFailure) throw Error('read failure'); return structuredClone(corpus); } return structuredClone(stored); },
      set: async (ns, key, value) => { assert.equal(ns, 'skybricate'); if (gate) await gate;
        if (reject) throw Error('<img src=x>'); stored = structuredClone(value); writes++; }
    } };
  registerDataSetting(game.settings);
  let next = 0;
  const data = new DataStore({ getGame: () => game, idFactory: () => `p${++next}` });
  const panels = [];
  const f = { window, root, game, data, get corpus() { return corpus; }, set corpus(value) { corpus = value; },
    set specialEnabled(value) { specialEnabled = value; registrations.get("showSpecialProperties").onChange(value); },
    get snapshot() { return structuredClone(stored); }, get writes() { return writes; },
    set reject(value) { reject = value; }, set gate(value) { gate = value; }, set readFailure(value) { readFailure = value; },
    mount(target = root) { const panel = mountAssignmentPanel({ target, getGame: () => game, data,
      canWrite: () => game.user.isGM, text: key => key }); panels.push(panel); return panel; },
    destroy() { panels.forEach(panel => panel.dispose()); window.happyDOM.abort(); } };
  return f;
}
const action = (root, name) => root.querySelector(`[data-sky-assignment-action="${name}"]`);
const row = root => root.querySelector('[data-sky-kind="ordinary"]');
const selected = (root, id = 'p1') => [...root.querySelectorAll('select[data-sky-kind="ordinary"]')].some(node => node.value === id);
function selectProperty(f, root, id = 'p1', kind = 'ordinary') {
  action(root, 'add-' + kind).click();
  const nodes = root.querySelectorAll('select[data-sky-kind="' + kind + '"]'), node = nodes[nodes.length - 1];
  node.value = id; node.dispatchEvent(new f.window.Event('change', {bubbles:true}));
}
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
  assert.equal(selected(f.root), false); selectProperty(f, f.root); action(f.root, 'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components.same, [p]);
  choose(f, f.root, 'component', 'other'); assert.equal(selected(f.root), false);
  choose(f, f.root, 'component', 'same'); assert.equal(selected(f.root), true);
  action(f.root, 'clear').click(); action(f.root, 'save').click(); await settle(); assert.deepEqual(f.snapshot.systems.a.components.same, []);
  selectProperty(f, f.root); action(f.root, 'refresh').click(); await settle(); assert.equal(selected(f.root), false);
  choose(f, f.root, 'system', 'b'); assert.equal(selected(f.root), false); await f.data.deleteProperty('b', 'p2');
  action(f.root, 'refresh').click(); await settle(); assert.match(f.root.textContent, /AssignmentEmpty/);
  f.corpus[1].components = []; action(f.root, 'refresh').click(); await settle(); assert.match(f.root.textContent, /NoComponents/);
  f.corpus = []; action(f.root, 'refresh').click(); await settle(); assert.match(f.root.textContent, /NoSystems/);
});

test('save errors keep selection; pending blocks duplicate saves/navigation; stale DOM and GM loss cannot write', async t => {
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  const panel = f.mount(); await settle(); selectProperty(f, f.root); f.reject = true; action(f.root, 'save').click(); await settle();
  assert.match(f.root.querySelector('[role=status]').textContent, /Error/); assert.equal(selected(f.root), true);
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
    const panel = f.mount(); await settle(); selectProperty(f, f.root);
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
  selectProperty(f, f.root); assert.equal(selected(second), false);
  action(f.root, 'save').click(); await settle(); selectProperty(f, second); action(second, 'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components, { same: ['p1'], other: ['p1'] }); first.dispose(); assert(row(second).isConnected);
});

test('ApplicationV2 settings menu/render lifecycle handles detached content, rerender, close/reopen and permissions', async t => {
  const f = fixture(); t.after(() => f.destroy()); await f.data.createProperty('a', { name: 'P' });
  class Base { _onRender() {} _onClose() {} async close() { this._onClose(); } }
  const Application = createAssignmentApplication({ ApplicationV2: Base, getGame: () => f.game, getData: () => f.data, compatible: () => true });
  let registration; registerAssignmentMenu({ registerMenu: (...args) => { registration = args; } }, Application);
  assert.equal(registration[0], 'skybricate'); assert.equal(registration[2].restricted, true); assert.equal(registration[2].type, Application);
  const app = new Application(), content = f.window.document.createElement('div');
  assert.equal(app._canRender(), undefined); app._replaceHTML(await app._renderHTML(), content); assert.equal(f.writes, 1);
  f.root.append(content); app._onRender(); await settle(); assert(content.querySelector('[data-sky-zone=ordinary]')); selectProperty(f, content);
  const before = app._assignments; app._replaceHTML(null, content); app._onRender(); await settle();
  assert.equal(app._assignments, before); assert.equal(selected(content), true);
  await app.close(); assert.equal(content.children.length, 0); app._replaceHTML(null, content); app._onRender(); await settle();
  assert.equal(selected(content), false); f.game.user.isGM = false; assert.equal(app._canRender(), false);
  await app.close();
});

test('typed rows exclude choices across both zones, ignore blanks and release deleted choices', async t => {
  const f = fixture(); t.after(() => f.destroy()); f.specialEnabled = true;
  for (const name of ['P', '<script>', 'Third']) await f.data.createProperty('a', {name});
  f.mount(); await settle();
  assert.equal(f.root.querySelector('[data-sky-zone=special]').hidden, false);
  selectProperty(f, f.root, 'p1'); selectProperty(f, f.root, 'p2', 'special');
  action(f.root, 'add-ordinary').click(); action(f.root, 'add-special').click();
  const selects = [...f.root.querySelectorAll('select[data-sky-kind]')];
  for (const select of selects) {
    const choices = [...select.options].map(option => option.value);
    assert.equal(choices.includes('p1'), select.value === 'p1');
    assert.equal(choices.includes('p2'), select.value === 'p2');
    assert(choices.includes('p3')); assert(choices.includes(''));
  }
  assert.equal(f.root.querySelector('script'), null);
  const remove = f.root.querySelector('[data-sky-zone=ordinary] [data-sky-assignment-action=remove]');
  assert(remove.getAttribute('aria-label')); remove.querySelector('i').click();
  assert([...f.root.querySelector('select[data-sky-kind=ordinary]').options].some(option => option.value === 'p1'));
  action(f.root, 'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components.same, []);
  assert.deepEqual(f.snapshot.systems.a.specialComponents.same, ['p2']);
  choose(f, f.root, 'component', 'other'); selectProperty(f, f.root, 'p2'); action(f.root, 'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components.other, ['p2']);
  assert.deepEqual(f.snapshot.systems.a.specialComponents.same, ['p2']);
});

test('special visibility defaults off and changes live; hidden clear preserves typed links and priority', async t => {
  const f = fixture(); t.after(() => f.destroy());
  for (const name of ['P', 'Special']) await f.data.createProperty('a', {name});
  f.specialEnabled = true;
  await f.data.setComponentAssignments('a','same',{ordinary:['p1'],special:['p2']},{editSpecial:true});
  f.specialEnabled = false; f.mount(); await settle();
  const zone = f.root.querySelector('[data-sky-zone=special]'); assert.equal(zone.hidden,true);
  action(f.root,'add-ordinary').click();
  assert(![...f.root.querySelectorAll('select[data-sky-kind=ordinary]')].at(-1).querySelector('option[value=p2]'));
  action(f.root,'clear').click(); action(f.root,'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.components.same,[]); assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p2']);
  assert.equal(f.snapshot.systems.a.rules.prioritySpecial,false);
  f.specialEnabled=true; assert.equal(zone.hidden,false);
  assert.equal(f.root.querySelector('select[data-sky-kind=special]').value,'p2');
  action(f.root,'clear').click(); action(f.root,'save').click(); await settle();
  assert.deepEqual(f.snapshot.systems.a.specialComponents.same,[]);
});

test('special writes validate both types, duplicates, scoped references and permissions atomically', async t => {
  const f=fixture(); t.after(()=>f.destroy()); f.specialEnabled=true;
  await f.data.createProperty('a',{name:'A'}); await f.data.createProperty('b',{name:'B'});
  const before=f.snapshot, writes=f.writes;
  for (const input of [{ordinary:['p1'],special:['p1']}, {ordinary:[],special:['p1','p1']},
    {ordinary:[],special:['p2']}, {ordinary:[],special:'p1'}, {ordinary:[],special:['missing']},
    {special:[]}, {ordinary:[],special:[],extra:true}, {ordinary:'p1',special:[]}]) {
    await assert.rejects(f.data.setComponentAssignments('a','same',input,{editSpecial:true}));
  }
  f.game.user.isGM=false;
  await assert.rejects(f.data.setComponentAssignments('a','same',{ordinary:[],special:['p1']},{editSpecial:true}));
  assert.deepEqual(f.snapshot,before); assert.equal(f.writes,writes);
});

test('special cleanup covers property deletion, component removal and complete-system reconcile only', async t => {
  const f=fixture(); t.after(()=>f.destroy()); f.specialEnabled=true;
  for (const system of ['a','b']) {
    const p=await f.data.createProperty(system,{name:'P'});
    await f.data.setComponentAssignments(system,'same',{ordinary:[],special:[p]},{editSpecial:true});
  }
  const other=f.snapshot.systems.b;
  await f.data.updateProperty('a','p1',{name:'Renamed'}); assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p1']);
  await f.data.deleteProperty('a','p1'); assert.deepEqual(f.snapshot.systems.a.specialComponents.same,[]);
  assert.deepEqual(f.snapshot.systems.b,other);
  await f.data.deleteComponent('a','same'); assert.equal(f.snapshot.systems.a.specialComponents.same,undefined);
  const absent=f.corpus.pop(); await f.data.reconcileAllComponentProperties(); assert.deepEqual(f.snapshot.systems.b,other);
  f.corpus.push(absent); absent.components=[]; await f.data.reconcileComponentProperties('b');
  assert.equal(f.snapshot.systems.b.specialComponents.same,undefined);
});

test('queued ordinary writes preserve freshest special links and reject hidden collisions', async t => {
  const f=fixture(); t.after(()=>f.destroy()); f.specialEnabled=true;
  for(const name of ['A','B','C']) await f.data.createProperty('a',{name});
  const first=f.data.setComponentAssignments('a','same',{ordinary:[],special:['p2']},{editSpecial:true});
  const second=f.data.setComponentProperties('a','same',['p1']); await Promise.all([first,second]);
  assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p2']);
  f.specialEnabled=false;
  const before=f.snapshot; await assert.rejects(f.data.setComponentProperties('a','same',['p2'])); assert.deepEqual(f.snapshot,before);
  await f.data.setComponentProperties('a','same',[]); assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p2']);
});

test('setting toggles and stale windows cannot overwrite hidden links in a queued save', async t => {
  for (const toggle of ['off','off-on']) {
    const f=fixture(); t.after(()=>f.destroy()); f.specialEnabled=true;
    for (const name of ['A','B','C']) await f.data.createProperty('a',{name});
    await f.data.setComponentAssignments('a','same',{ordinary:[],special:['p2']},{editSpecial:true});
    f.mount(); await settle(); action(f.root,'clear').click();
    let release; f.gate=new Promise(resolve=>{release=resolve;}); const blocker=f.data.ensureSystem('b'); await settle();
    action(f.root,'save').click(); f.specialEnabled=false; if(toggle==='off-on') f.specialEnabled=true;
    release(); f.gate=null; await blocker; await settle();
    assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p2']);
  }
  const f=fixture(); t.after(()=>f.destroy()); await f.data.createProperty('a',{name:'P'});
  let release; f.gate=new Promise(resolve=>{release=resolve;}); const blocker=f.data.ensureSystem('b'); await settle();
  const queued=f.data.setComponentAssignments('a','same',{ordinary:[],special:[]},{editSpecial:false});
  f.specialEnabled=true; release(); f.gate=null; await blocker; await queued;
  // A hidden caller does not create or replace a special assignment collection.
  assert.equal(f.snapshot.systems.a.specialComponents.same,undefined);
});

test('typed row errors keep drafts, pending blocks edits, and lost permission blocks special saves', async t => {
  const f=fixture(); t.after(()=>f.destroy()); f.specialEnabled=true;
  await f.data.createProperty('a',{name:'P'}); const panel=f.mount(); await settle(); selectProperty(f,f.root,'p1','special');
  f.reject=true; action(f.root,'save').click(); await settle();
  assert.match(f.root.querySelector('[role=status]').textContent,/Error/);
  assert.equal(f.root.querySelector('select[data-sky-kind=special]').value,'p1');
  f.reject=false; f.game.user.isGM=false; const before=f.writes; action(f.root,'save').click(); await settle(); assert.equal(f.writes,before);
  f.game.user.isGM=true; panel.dispose(); f.mount(); await settle(); selectProperty(f,f.root,'p1','special'); action(f.root,'save').click(); await settle(); assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p1']);
});

test('hidden stale window, setting change and rejected save preserve latest special links', async t => {
  const f=fixture(); t.after(()=>f.destroy()); for (const name of ['A','B']) await f.data.createProperty('a',{name});
  f.mount(); await settle(); selectProperty(f,f.root,'p1');
  f.specialEnabled=true;
  await f.data.setComponentAssignments('a','same',{ordinary:[],special:['p2']},{editSpecial:true});
  f.specialEnabled=false;
  assert.equal(f.root.querySelector('select[data-sky-kind=ordinary]').value,'p1');
  assert.equal(f.root.querySelector('[data-sky-zone=special]').hidden,true);
  const before=f.snapshot; f.reject=true; action(f.root,'save').click(); await settle();
  assert.deepEqual(f.snapshot,before); assert.equal(selected(f.root),true);
  f.reject=false;
  let release; f.gate=new Promise(resolve=>{release=resolve;}); action(f.root,'save').click(); await settle();
  const count=f.root.querySelectorAll('select[data-sky-kind=ordinary]').length;
  action(f.root,'add-ordinary').click(); action(f.root,'clear').click();
  assert.equal(f.root.querySelectorAll('select[data-sky-kind=ordinary]').length,count);
  release(); f.gate=null; await settle();
  assert.deepEqual(f.snapshot.systems.a.components.same,['p1']); assert.deepEqual(f.snapshot.systems.a.specialComponents.same,['p2']);
});
