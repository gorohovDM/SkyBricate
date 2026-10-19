import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../scripts/data-store.js";
import { emptyData } from "../scripts/data-model.js";
import { managerFixture, vocabularyMarkup, readable, settleDOM } from "./helpers/manager-fixture.mjs";

function fixture(options) {
  let persisted = emptyData(), writes = 0, reject = false, gate = null, next = 0;
  const storageGame = { user: { isGM: true }, fabricate: { getCraftingSystemManager: () => ({ componentAssignmentContract: {
    version: 'fabricate-component-assignments-v1', deletedHook: 'fabricate.componentsDeleted',
    readPersistedSystem: systemId => ({ systemId, complete: true, componentIds: ['special'] })
  } }) }, settings: {
    get() { return structuredClone(persisted); },
    async set(ns, key, value) { assert.equal(ns, "skybricate"); assert.equal(key, "data"); if (gate) await gate;
      if (reject) throw new Error("disk failure"); persisted = structuredClone(value); writes++; }
  } };
  const data = new DataStore({ getGame: () => storageGame, idFactory: () => `p-${++next}` });
  const f = managerFixture(data, options);
  return Object.assign(f, { data, getWrites: () => writes, reject: value => { reject = value; },
    gate: value => { gate = value; }, corrupt: value => { persisted = value; } });
}
const action = (f, name, container = f.panel()) => container.querySelector(`[data-sky-action="${name}"]`).click();
const field = (f, name, value) => { f.panel().querySelector(`[data-sky-field="${name}"]`).value = value; };
const status = f => f.panel().querySelector('[role="status"]').textContent;
const start = async f => { f.render(); await settleDOM(); f.open(); };
const native = (f, id) => f.root.querySelector(`[data-vocabulary-tab="${id}"]`);
const key = (f, node, key) => node.dispatchEvent(new f.window.KeyboardEvent("keydown", { key, bubbles: true }));
const legacy = () => ({ schemaVersion: 1, properties: { old: { name: "Old test", description: "" } }, systems: {} });

test("mount in Tags & Categories only, rerender/replacement, cleanup, no feedback loop", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  assert(f.tab()); assert.equal(f.panel(), null); assert.equal(f.getWrites(), 0);
  f.open(); const first = f.panel(); assert(first); assert.equal(f.observerCount, 1);
  for (let i = 0; i < 4; i++) f.render();
  await settleDOM(); assert.equal(f.panel(), first); assert.equal(f.root.querySelectorAll('[data-skybricate-tab]').length, 1);
  const before = f.observerCallbacks; await settleDOM(); assert.equal(f.observerCallbacks, before);
  f.root.innerHTML = '<main data-crafting-settings><section data-crafting-resolution-section></section></main>';
  await settleDOM(); assert.equal(f.panel(), null); assert.equal(f.tab(), null); assert.equal(f.warnings.length, 0);
  first.querySelector('[data-sky-action="save"]').click(); assert.equal(f.getWrites(), 0);
  f.root.innerHTML = vocabularyMarkup(); await settleDOM(); assert(f.tab()); assert.equal(f.panel(), null);
});

test("fourth tab ARIA/active, keyboard includes all four, native same-tab restoration", async t => {
  const f = fixture(); t.after(() => f.destroy()); await start(f);
  const workspace = f.root.querySelector('#vocabulary-panel-recipe');
  assert.equal(f.tab().getAttribute("aria-selected"), "true"); assert.equal(f.tab().tabIndex, 0);
  assert.equal(f.root.querySelectorAll('[role="tab"][aria-selected="true"]').length, 1);
  assert.equal(workspace.hidden, true); assert.equal(native(f,"recipe").classList.contains("is-active"), false);
  key(f, f.tab(), "ArrowRight"); assert.equal(f.panel(), null); assert.equal(workspace.hidden, false);
  assert.equal(native(f,"recipe").getAttribute("aria-selected"), "true"); assert.equal(native(f,"recipe").tabIndex, 0);
  key(f, native(f,"recipe"), "ArrowLeft"); assert(f.panel()); assert.equal(f.window.document.activeElement, f.tab());
  key(f, f.tab(), "ArrowLeft"); assert.equal(f.window.document.activeElement, native(f,"tag"));
  key(f, native(f,"tag"), "End"); assert(f.panel());
  key(f, f.tab(), "Home"); assert.equal(f.window.document.activeElement, native(f,"recipe"));
  f.open(); native(f,"recipe").click(); assert.equal(f.panel(), null); assert.equal(workspace.hidden, false);
  f.open(); native(f,"recipe").classList.add("external-class"); f.close(); assert.equal(workspace.hidden, false);
  assert(native(f,"recipe").classList.contains("external-class")); assert(native(f,"recipe").classList.contains("is-active")); assert.equal(native(f,"recipe").tabIndex, 0);
  assert.equal(native(f,"recipe").getAttribute("aria-selected"), "true"); assert.equal(f.tab(), null);
});

test("native selection update during overlay restores current native state without dual active tabs", async t => {
  const f=fixture(); t.after(()=>f.destroy()); await start(f); field(f,"name","stale");
  const workspace=f.root.querySelector('#vocabulary-panel-recipe');
  workspace.id="vocabulary-panel-tag"; workspace.setAttribute("aria-labelledby","vocabulary-tab-tag");
  native(f,"tag").setAttribute("aria-selected","true"); native(f,"tag").tabIndex=0; native(f,"tag").classList.add("is-active");
  action(f,"save"); assert.equal(f.getWrites(),0); await settleDOM(); assert.equal(f.panel(),null);
  assert.equal(f.root.querySelectorAll('[role="tab"][aria-selected="true"]').length,1);
  assert.equal(native(f,"tag").getAttribute("aria-selected"),"true"); assert.equal(native(f,"recipe").tabIndex,-1);
  assert.equal(native(f,"recipe").classList.contains("is-active"),false); assert.equal(workspace.hidden,false);
});

test("navigation outside tablist retains native dirty guard cancellation", async t => {
  const f = fixture(); t.after(() => f.destroy()); await start(f);
  let guarded = 0, accept = false;
  const nav = f.window.document.createElement("button"); nav.textContent = "Other route"; f.root.append(nav);
  nav.addEventListener("click", () => { guarded++; if (accept) f.root.innerHTML = '<main>Other route</main>'; });
  nav.click(); await settleDOM(); assert.equal(guarded, 1); assert(f.panel());
  accept = true; nav.click(); await settleDOM(); assert.equal(guarded, 2); assert.equal(f.panel(), null);
});

test("selection async gap immediately invalidates context; all resolution modes supported", async t => {
  const f = fixture(); t.after(() => f.destroy()); await start(f);
  const old = f.panel(); field(f,"name","must not save");
  f.selectedSystemId.set("b"); assert.equal(f.panel(), null); assert.equal(f.tab(), null);
  old.querySelector('[data-sky-action="save"]').click(); await settleDOM(); assert.equal(f.getWrites(), 0);
  f.viewState.set({ selectedSystem: { id: "b", resolutionMode: "simple" } }); await settleDOM(); f.open();
  assert.equal(f.panel().dataset.skybricatePanel, "b"); assert.equal(f.panel().querySelector('[data-sky-field="name"]').value, "");
  f.viewState.set({ selectedSystem: { id: "b", resolutionMode: "alchemy" } }); await settleDOM(); assert(f.panel());
});

test("stale permission/version/native contract checks deny writes; non-GM cleanup", async t => {
  const f = fixture(); t.after(() => f.destroy()); await start(f); field(f,"name","blocked");
  f.compatible = false; action(f,"save"); await settleDOM(); assert.equal(f.getWrites(),0);
  f.compatible = true; f.render(); await settleDOM(); f.open();
  native(f,"tag").dataset.vocabularyTab = "unknown";
  action(f,"save"); assert.equal(f.getWrites(),0); await settleDOM(); assert.equal(f.tab(),null); assert.equal(f.warnings.length,1);
  f.root.innerHTML = vocabularyMarkup(); await settleDOM(); f.open();
  f.game.user.isGM = false; f.hooks.fire("updateUser",{});
  assert.equal(f.panel(),null); assert.equal(f.selectedSystemId.count,0); assert.equal(f.observerCount,0);
});

test("non-GM, wrong app, unknown stores and ambiguous surface fail closed once", async t => {
  const player = fixture({isGM:false}); t.after(()=>player.destroy()); player.render(); await settleDOM();
  assert.equal(player.tab(),null); assert.equal(player.observerCount,0); assert.equal(player.warnings.length,0);
  const f = fixture(); t.after(()=>f.destroy()); f.app.options.id = "other"; f.render(); await settleDOM(); assert.equal(f.tab(),null);
  f.app.options.id = "fabricate-crafting-system-manager"; f.app._adminStore={}; f.render(); f.render(); assert.equal(f.warnings.length,1);
  for (const markup of ['<main class="manager-tags-categories"></main>', vocabularyMarkup()+vocabularyMarkup(), vocabularyMarkup().replace('role="tabpanel"','role="region"')]) {
    const g=fixture(); t.after(()=>g.destroy()); g.root.innerHTML=markup; g.render(); await settleDOM(); g.render(); await settleDOM();
    assert.equal(g.warnings.length,1); assert.equal(g.tab(),null); assert.equal(g.getWrites(),0);
  }
});

test("close cancels queued reconcile and cleans listeners/subscriptions; new store/element reopens", async t => {
  const f=fixture(); t.after(()=>f.destroy()); await start(f); const old=f.panel(), tab=f.tab();
  field(f,"name","stale"); f.selectedSystemId.set("b"); f.close(); await settleDOM();
  assert.equal(f.selectedSystemId.count,0); assert.equal(f.viewState.count,0); assert.equal(f.observerCount,0);
  old.querySelector('[data-sky-action="save"]').click(); tab.click(); assert.equal(f.getWrites(),0); assert.equal(f.panel(),null);
  f.app._adminStore={selectedSystemId:readable("c"),viewState:readable({selectedSystem:{id:"c",resolutionMode:"simple"}})};
  f.render(); await settleDOM(); f.open(); assert.equal(f.panel().dataset.skybricatePanel,"c");
  const newRoot=f.window.document.createElement("div"); newRoot.innerHTML=vocabularyMarkup(); f.window.document.body.append(newRoot);
  f.app.element=newRoot; f.hooks.fire("renderApplicationV2",f.app); await settleDOM(); assert.equal(f.panel(),null); assert(newRoot.querySelector('[data-skybricate-tab]'));
  f.dispose(); assert.equal(f.app._adminStore.viewState.count,0); assert.equal(f.hooks.count("renderApplicationV2"),0); assert.equal(f.observerCount,0);
});

test("scoped CRUD stable IDs, safe strings, pending, confirmation and cleanup only selected system", async t => {
  const f=fixture(); t.after(()=>f.destroy()); await start(f);
  const other=await f.data.createProperty("b",{name:"Other"}); await f.data.setCategoryProperties("b","herbs",[other]); const beforeOther=f.data.getSnapshot().systems.b;
  let finish; f.gate(new Promise(resolve=>{finish=resolve;}));
  field(f,"name","<img src=x onerror=alert(1)>"); field(f,"description","<script>bad()</script>"); action(f,"save"); await settleDOM();
  assert.equal(status(f),"Saving"); assert.equal(f.panel().getAttribute("aria-busy"),"true"); const writes=f.getWrites(); action(f,"save");
  finish(); await settleDOM(); assert.equal(status(f),"Saved"); assert.equal(f.getWrites(),writes+1); assert.equal(f.panel().querySelector("img,script"),null);
  const id=Object.keys(f.data.getSnapshot().systems.a.properties)[0];
  await f.data.setCategoryProperties("a","herbs",[id]); await f.data.setComponentProperties("a","special",[id]); await f.data.configureRules("a",{propertyOrder:[id]});
  action(f,"edit"); field(f,"name","renamed"); action(f,"save"); await settleDOM();
  assert.equal(f.data.getSnapshot().systems.a.properties[id].name,"renamed");
  const count=f.getWrites(); action(f,"delete"); assert.match(f.panel().textContent,/DeleteWarning.*renamed/); assert.equal(f.getWrites(),count);
  action(f,"cancel"); assert.equal(f.getWrites(),count); action(f,"delete"); action(f,"confirm-delete"); await settleDOM();
  const snapshot=f.data.getSnapshot(); assert.deepEqual(snapshot.systems.a.properties,{}); assert.deepEqual(snapshot.systems.a.categories.herbs,[]);
  assert.deepEqual(snapshot.systems.a.components.special,[]); assert.deepEqual(snapshot.systems.a.rules.propertyOrder,[]); assert.deepEqual(snapshot.systems.b,beforeOther);
  assert(f.panel().querySelector('input[type="search"]').disabled); assert.match(f.panel().textContent,/Entries: 0/);
});

test("native vocabulary styling, fixed tag icon, honest usage placeholder, no icon editor", async t=>{
  const f=fixture(); t.after(()=>f.destroy()); await f.data.createProperty("a",{name:"Healing"}); await start(f);
  assert(f.panel().classList.contains("manager-vocabulary-panel")); assert(f.panel().querySelector('.manager-vocabulary-form-fields'));
  assert(f.panel().querySelector('.manager-vocabulary-row .fas.fa-tag')); assert.match(f.panel().textContent,/UsageUnavailable/);
  assert.equal(f.panel().querySelector('[data-vocabulary-icon-picker],input[type="color"]'),null);
});

test("validation/rejected persistence visible and retry retains input; corrupt read never resets", async t=>{
  const f=fixture(); t.after(()=>f.destroy()); await start(f); action(f,"save"); assert.equal(status(f),"NameRequired");
  field(f,"name","draft"); f.reject(true); action(f,"save"); await settleDOM(); assert.match(status(f),/Error disk failure/);
  assert.equal(f.panel().querySelector('[data-sky-field="name"]').value,"draft"); assert.equal(f.panel().querySelector("fieldset").disabled,false);
  f.reject(false); action(f,"save"); await settleDOM(); assert.equal(status(f),"Saved");
  action(f,"delete"); f.reject(true); action(f,"confirm-delete"); await settleDOM(); assert.match(status(f),/disk failure/);
  for (const value of [{schemaVersion:999}, {schemaVersion:1}, null]) {
    f.corrupt(value); action(f,"refresh"); assert.match(status(f),/Error/); assert.equal(f.panel().querySelector("fieldset").disabled,true);
    assert.equal(f.panel().querySelector('[data-sky-action="reset"]'),null);
  }
  assert.equal(f.getWrites(),1);
});

test("legacy reset needs explicit confirmation, retry/pending, and refuses changed data", async t=>{
  const f=fixture(); t.after(()=>f.destroy()); f.corrupt(legacy()); await start(f);
  assert.match(f.panel().textContent,/LegacyWarning/); action(f,"reset"); assert.match(f.panel().textContent,/ResetWarning/); assert.equal(f.getWrites(),0);
  action(f,"cancel"); assert.equal(f.getWrites(),0); action(f,"reset"); f.reject(true); action(f,"confirm-reset"); await settleDOM();
  assert.match(status(f),/disk failure/); assert.equal(f.getWrites(),0); f.reject(false); action(f,"confirm-reset"); await settleDOM();
  assert.equal(status(f),"Saved"); assert.deepEqual(f.data.getSnapshot(),emptyData());
  f.corrupt(legacy()); action(f,"refresh"); action(f,"reset"); f.corrupt({...emptyData(),schemaVersion:99}); action(f,"confirm-reset"); await settleDOM();
  assert.match(status(f),/Error/); assert.equal(f.getWrites(),1);
});

test("authorized save after close/system change never updates stale panel or other system", async t=>{
  const f=fixture(); t.after(()=>f.destroy()); await start(f);
  let finish; f.gate(new Promise(resolve=>{finish=resolve;})); field(f,"name","authorized save"); action(f,"save"); await settleDOM();
  f.selectedSystemId.set("b"); f.viewState.set({selectedSystem:{id:"b",resolutionMode:"simple"}}); await settleDOM(); f.open(); assert.equal(f.panel().dataset.skybricatePanel,"b");
  f.close(); finish(); await settleDOM(); assert.equal(f.getWrites(),1); assert.equal(f.panel(),null); assert.equal(f.observerCount,0);
  assert.equal(Object.keys(f.data.getSnapshot().systems.a.properties).length,1); assert.equal(f.data.getSnapshot().systems.b,undefined);
});

test("independent sessions, malformed projection and pending document insertion", async t=>{
  const f=fixture(); t.after(()=>f.destroy()); f.root.remove(); f.render(); await settleDOM(); assert.equal(f.tab(),null); assert.equal(f.observerCount,2);
  f.window.document.body.append(f.root); await settleDOM(); f.open(); assert(f.panel()); assert.equal(f.observerCount,1);
  const secondRoot=f.window.document.createElement("div"); f.window.document.body.append(secondRoot); secondRoot.innerHTML=vocabularyMarkup();
  const store={selectedSystemId:readable("b"),viewState:readable({selectedSystem:{id:"b",resolutionMode:"simple"}})};
  const app={options:f.app.options,element:secondRoot,_adminStore:store}; f.hooks.fire("renderApplicationV2",app); await settleDOM();
  const tab=secondRoot.querySelector('[data-skybricate-tab]'); tab.click(); assert.notEqual(tab.id,f.tab().id); assert.equal(secondRoot.querySelector('[data-skybricate-panel]').dataset.skybricatePanel,"b");
  f.close(); assert.equal(f.observerCount,1); assert.equal(secondRoot.querySelector('#vocabulary-panel-recipe').hidden,true);
  store.viewState.set({selectedSystem:{wrong:"shape"}}); await settleDOM(); assert.equal(secondRoot.querySelector('[data-skybricate-tab]'),null);
  assert.equal(secondRoot.querySelector('#vocabulary-panel-recipe').hidden,false); assert.equal(f.warnings.length,1);
  f.hooks.fire("closeApplicationV2",app); assert.equal(f.observerCount,0); assert.equal(store.viewState.count,0);
});
