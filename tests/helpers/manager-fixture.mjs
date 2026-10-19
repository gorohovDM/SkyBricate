import { Window } from "happy-dom";
import { installManagerAdapter } from "../../scripts/manager-adapter.js";

// Minimal DOM emitted by Fabricate v1.9.10 CraftingSettingsView ->
// ResolutionModeCard -> RadioCardGroup (SHA 5bf36dd). No invented systemId
// DOM attribute: identity comes from selectedSystemId + viewState.selectedSystem.
export function settingsMarkup(mode = "alchemy") {
  return `<main data-crafting-settings><section data-crafting-resolution-section>
    <fieldset data-crafting-resolution-mode><label><input type="radio" name="manager-crafting-resolution-mode" value="alchemy" ${mode === "alchemy" ? "checked" : ""}></label>
    <label><input type="radio" name="manager-crafting-resolution-mode" value="simple" ${mode === "simple" ? "checked" : ""}></label></fieldset>
    </section></main>`;
}
export function readable(initial) {
  let value = initial;
  const subscribers = new Set();
  return { subscribe(fn) { subscribers.add(fn); fn(value); return () => subscribers.delete(fn); },
    set(next) { value = next; for (const fn of subscribers) fn(value); },
    get count() { return subscribers.size; } };
}
export function hookBus() {
  const handlers = new Map();
  return {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); return fn; },
    off(name, fn) { handlers.get(name)?.delete(fn); },
    fire(name, ...args) { for (const fn of handlers.get(name) ?? []) fn(...args); },
    count(name) { return handlers.get(name)?.size ?? 0; }
  };
}
export const settleDOM = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 5)); };
export function managerFixture(data, { isGM = true, mode = "alchemy", id = "a" } = {}) {
  const window = new Window();
  const root = window.document.createElement("div"); window.document.body.append(root);
  root.innerHTML = settingsMarkup(mode);
  const selectedSystemId = readable(id), viewState = readable({ selectedSystem: { id, resolutionMode: mode } });
  const store = { selectedSystemId, viewState };
  const app = { options: { id: "fabricate-crafting-system-manager" }, element: root, _adminStore: store };
  const hooks = hookBus(), warnings = [], game = { user: { isGM }, i18n: { localize: key => key.split(".").at(-1) } };
  let compatible = true, observerCallbacks = 0, observerCount = 0;
  class Observer extends window.MutationObserver {
    constructor(callback) { super((...args) => { observerCallbacks++; callback(...args); }); observerCount++; }
    disconnect() { super.disconnect(); observerCount--; }
  }
  const dispose = installManagerAdapter({ hooks, getGame: () => game, data, compatible: () => compatible,
    notifications: () => ({ warn: message => warnings.push(message) }), Observer });
  return { window, root, app, hooks, game, selectedSystemId, viewState, warnings, dispose,
    set compatible(value) { compatible = value; },
    get observerCallbacks() { return observerCallbacks; }, get observerCount() { return observerCount; },
    panel: () => root.querySelector("[data-skybricate-panel]"),
    render() { hooks.fire("renderApplicationV2", app, root, {}); },
    close() { hooks.fire("closeApplicationV2", app); },
    destroy() { dispose(); window.happyDOM.abort(); } };
}
