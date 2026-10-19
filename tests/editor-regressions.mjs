import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../scripts/data-store.js";
import { emptyData } from "../scripts/data-model.js";
import { managerFixture, settingsMarkup, readable, settleDOM } from "./helpers/manager-fixture.mjs";

function fixture(options) {
  let persisted = emptyData(), writes = 0, reject = false, gate = null, next = 0;
  const storageGame = { user: { isGM: true }, settings: {
    get() { return structuredClone(persisted); },
    async set(_ns, _key, data) { if (gate) await gate; if (reject) throw new Error("disk failure"); persisted = structuredClone(data); writes++; }
  } };
  const data = new DataStore({ getGame: () => storageGame, idFactory: () => `p-${++next}` });
  const f = managerFixture(data, options);
  return Object.assign(f, { data, getWrites: () => writes, reject: value => { reject = value; },
    gate: value => { gate = value; }, corrupt: value => { persisted = value; } });
}
const action = (f, name, container = f.panel()) => container.querySelector(`[data-sky-action="${name}"]`).click();
const field = (f, name, value) => { f.panel().querySelector(`[data-sky-field="${name}"]`).value = value; };
const status = f => f.panel().querySelector('[role="status"]').textContent;

test("manager mounts once, observes Svelte replacement/navigation, no observer feedback loop", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  const first = f.panel(); assert(first); assert.equal(f.observerCount, 1);
  for (let i = 0; i < 4; i++) f.render();
  await settleDOM(); assert.equal(f.panel(), first); assert.equal(f.root.querySelectorAll('[data-skybricate-panel]').length, 1);
  const before = f.observerCallbacks; await settleDOM(); assert.equal(f.observerCallbacks, before);
  f.root.innerHTML = "<main>Other page</main>"; await settleDOM(); assert.equal(f.panel(), null);
  // A detached former button must have no listener left.
  first.querySelector('[data-sky-action="save"]').click(); await settleDOM(); assert.equal(f.getWrites(), 0);
  f.root.innerHTML = settingsMarkup(); await settleDOM(); assert(f.panel()); assert.notEqual(f.panel(), first);
  assert.equal(f.getWrites(), 0);
});

test("selection emission before async viewState refresh invalidates old context immediately", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  const old = f.panel(); field(f, "name", "must not save");
  f.selectedSystemId.set("b"); assert.equal(f.panel(), null);
  old.querySelector('[data-sky-action="save"]').click();
  await settleDOM(); assert.equal(f.panel(), null); assert.equal(f.getWrites(), 0);
  f.viewState.set({ selectedSystem: { id: "b", resolutionMode: "alchemy" } });
  await settleDOM(); assert.equal(f.panel().dataset.skybricatePanel, "b");
  assert.equal(f.panel().querySelector('[data-sky-field="name"]').value, "");
  f.viewState.set({ selectedSystem: { id: "b", resolutionMode: "simple" } });
  assert.equal(f.panel(), null); await settleDOM(); assert.equal(f.panel(), null);
  f.root.innerHTML = settingsMarkup("simple");
  f.viewState.set({ selectedSystem: { id: "b", resolutionMode: "alchemy" } });
  await settleDOM(); assert.equal(f.panel(), null); // DOM/store disagreement fails closed.
  f.root.innerHTML = settingsMarkup(); await settleDOM(); assert(f.panel());
});

test("optimistic native radio, stale click, permission/version changes cannot write", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  field(f, "name", "blocked");
  const native = f.root.querySelector('input[value="simple"]'); native.checked = true;
  action(f, "save"); await settleDOM(); assert.equal(f.getWrites(), 0);
  native.dispatchEvent(new f.window.Event("change", { bubbles: true })); await settleDOM(); assert.equal(f.panel(), null);
  f.root.innerHTML = settingsMarkup(); await settleDOM(); field(f, "name", "blocked");
  f.compatible = false; action(f, "save"); await settleDOM(); assert.equal(f.getWrites(), 0);
  f.compatible = true; f.game.user.isGM = false; f.hooks.fire("updateUser", {});
  assert.equal(f.panel(), null); assert.equal(f.selectedSystemId.count, 0); assert.equal(f.observerCount, 0);
});

test("non-GM, wrong app, unsupported store/selector contract fail closed with one GM warning", async t => {
  const player = fixture({ isGM: false }); t.after(() => player.destroy()); player.render(); await settleDOM();
  assert.equal(player.panel(), null); assert.equal(player.observerCount, 0); assert.equal(player.warnings.length, 0);
  const f = fixture(); t.after(() => f.destroy()); f.app.options.id = "another-app"; f.render(); await settleDOM();
  assert.equal(f.panel(), null); assert.equal(f.observerCount, 0);
  f.app.options.id = "fabricate-crafting-system-manager"; f.app._adminStore = {}; f.render(); f.render();
  assert.equal(f.warnings.length, 1); assert.equal(f.getWrites(), 0);
  const g = fixture(); t.after(() => g.destroy()); g.root.innerHTML = '<main data-crafting-settings><section></section></main>';
  g.render(); await settleDOM(); g.render(); await settleDOM(); assert.equal(g.warnings.length, 1); assert.equal(g.panel(), null);
  assert.equal(g.getWrites(), 0);
});

test("close cancels queued reconcile and cleans subscriptions/observer/listeners; reopen supports new store", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM(); const old = f.panel();
  field(f, "name", "stale"); f.selectedSystemId.set("b"); f.close(); await settleDOM();
  assert.equal(f.selectedSystemId.count, 0); assert.equal(f.viewState.count, 0); assert.equal(f.observerCount, 0);
  old.querySelector('[data-sky-action="save"]').click();
  f.root.innerHTML = settingsMarkup(); await settleDOM(); assert.equal(f.panel(), null); assert.equal(f.getWrites(), 0);
  f.app._adminStore = { selectedSystemId: readable("c"), viewState: readable({ selectedSystem: { id: "c", resolutionMode: "alchemy" } }) };
  f.render(); await settleDOM(); assert.equal(f.panel().dataset.skybricatePanel, "c");
  f.dispose(); assert.equal(f.app._adminStore.viewState.count, 0); assert.equal(f.hooks.count("renderApplicationV2"), 0);
  assert.equal(f.observerCount, 0); assert.equal(f.panel(), null);
});

test("catalog CRUD awaits persistence, edits stable ID and confirms global reference cleanup", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  let finish; f.gate(new Promise(resolve => { finish = resolve; }));
  field(f, "name", "<img src=x onerror=alert(1)>"); field(f, "description", "<script>bad()</script>");
  action(f, "save"); await settleDOM(); assert.equal(status(f), "Saving"); assert.equal(f.panel().getAttribute("aria-busy"), "true");
  assert.equal(f.getWrites(), 0); action(f, "save");
  finish(); await settleDOM(); assert.equal(status(f), "Saved"); assert.equal(f.getWrites(), 1);
  assert.equal(f.panel().querySelector("img,script"), null);
  const id = Object.keys(f.data.getSnapshot().properties)[0];
  for (const system of ["a", "b"]) {
    await f.data.setCategoryProperties(system, "herbs", [id]); await f.data.setComponentProperties(system, "special", [id]);
    await f.data.configureRules(system, { propertyOrder: [id] });
  }
  action(f, "edit"); field(f, "name", "renamed"); action(f, "save"); await settleDOM();
  assert.deepEqual(f.data.getSnapshot().properties, { [id]: { name: "renamed", description: "<script>bad()</script>" } });
  const before = f.getWrites(); action(f, "delete"); assert.match(f.panel().textContent, /DeleteWarning.*renamed/);
  assert.equal(f.getWrites(), before); action(f, "cancel"); assert.equal(f.getWrites(), before);
  action(f, "delete"); action(f, "confirm-delete"); await settleDOM(); assert.equal(status(f), "Saved");
  const snapshot = f.data.getSnapshot(); assert.deepEqual(snapshot.properties, {});
  for (const system of Object.values(snapshot.systems)) {
    assert.deepEqual(system.categories.herbs, []); assert.deepEqual(system.components.special, []); assert.deepEqual(system.rules.propertyOrder, []);
  }
});

test("validation, rejected persistence and corrupt data are visible; retry retains input", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  action(f, "save"); assert.equal(status(f), "NameRequired"); assert.equal(f.getWrites(), 0);
  field(f, "name", "draft"); f.reject(true); action(f, "save"); await settleDOM();
  assert.match(status(f), /Error disk failure/); assert.equal(f.getWrites(), 0);
  assert.equal(f.panel().querySelector('[data-sky-field="name"]').value, "draft");
  assert.equal(f.panel().querySelector("fieldset").disabled, false);
  f.reject(false); action(f, "save"); await settleDOM(); assert.equal(status(f), "Saved"); assert.equal(f.getWrites(), 1);
  action(f, "delete"); f.reject(true); action(f, "confirm-delete"); await settleDOM();
  assert.match(status(f), /disk failure/); assert.equal(Object.keys(f.data.getSnapshot().properties).length, 1);
  f.corrupt({ schemaVersion: 999 }); action(f, "refresh"); assert.match(status(f), /Error/);
  assert.equal(f.panel().querySelector("fieldset").disabled, true); assert.equal(f.getWrites(), 1);
});

test("completion after close never updates/remounts disposed UI", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  let finish; f.gate(new Promise(resolve => { finish = resolve; }));
  field(f, "name", "authorized global save"); action(f, "save"); await settleDOM(); f.close();
  finish(); await settleDOM(); assert.equal(f.getWrites(), 1); assert.equal(f.panel(), null); assert.equal(f.observerCount, 0);
});

test("independent app sessions and malformed projected context", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.render(); await settleDOM();
  const secondRoot = f.window.document.createElement("div"); f.window.document.body.append(secondRoot);
  secondRoot.innerHTML = settingsMarkup();
  const secondStore = { selectedSystemId: readable("b"), viewState: readable({ selectedSystem: { id: "b", resolutionMode: "alchemy" } }) };
  const secondApp = { options: f.app.options, element: secondRoot, _adminStore: secondStore };
  f.hooks.fire("renderApplicationV2", secondApp); await settleDOM();
  assert.equal(secondRoot.querySelector('[data-skybricate-panel]').dataset.skybricatePanel, "b");
  assert.equal(f.observerCount, 2); f.close();
  assert.equal(f.observerCount, 1); assert.equal(secondStore.viewState.count, 1);
  secondStore.viewState.set({ selectedSystem: { wrong: "shape" } }); await settleDOM();
  assert.equal(secondRoot.querySelector('[data-skybricate-panel]'), null); assert.equal(f.warnings.length, 1);
  assert.equal(f.getWrites(), 0); f.hooks.fire("closeApplicationV2", secondApp);
  assert.equal(f.observerCount, 0); assert.equal(secondStore.selectedSystemId.count, 0);
});

test("render hook supports pending HTML before document insertion, then releases connection observer", async t => {
  const f = fixture(); t.after(() => f.destroy()); f.root.remove(); f.render(); await settleDOM();
  assert.equal(f.panel(), null); assert.equal(f.observerCount, 2); assert.equal(f.warnings.length, 0);
  f.window.document.body.append(f.root); await settleDOM(); assert(f.panel()); assert.equal(f.observerCount, 1);
  f.close(); assert.equal(f.observerCount, 0);
});
