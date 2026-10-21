import { Window } from "happy-dom";
import { installManagerAdapter } from "../../scripts/manager-adapter.js";

// Minimal TagsCategoriesView 1.9.10 DOM; identity comes from stores, not DOM.
export function vocabularyMarkup(active = "recipe") {
  return '<main class="manager-main manager-tags-categories"><div class="manager-editor-tabs manager-vocabulary-tabs" role="tablist">'
    + ["recipe", "component", "tag"].map(id => '<button type="button" role="tab" id="vocabulary-tab-' + id
      + '" class="manager-editor-tab-button' + (id === active ? ' is-active' : '') + '" aria-selected="' + (id === active)
      + '" aria-controls="vocabulary-panel-' + id + '" tabindex="' + (id === active ? 0 : -1)
      + '" data-vocabulary-tab="' + id + '">' + id + '</button>').join('')
    + '</div><div class="manager-tags-categories-workspace" role="tabpanel" id="vocabulary-panel-' + active
    + '" aria-labelledby="vocabulary-tab-' + active + '"><p>Native vocabulary</p></div></main>';
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
const windows = new Set();
export const settleDOM = async () => {
  await Promise.resolve();
  await Promise.all([...windows].map(window => window.happyDOM.waitUntilComplete()));
  await Promise.resolve();
};
export function managerFixture(data, { isGM = true, mode = "alchemy", id = "a", openAssignments, openKnowledge } = {}) {
  const window = new Window(); windows.add(window);
  const root = window.document.createElement("div"); root.className = "fabricate-manager"; window.document.body.append(root);
  root.innerHTML = vocabularyMarkup();
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
    openAssignments, openKnowledge,
    notifications: () => ({ warn: message => warnings.push(message) }), Observer });
  return { window, root, app, hooks, game, selectedSystemId, viewState, warnings, dispose,
    set compatible(value) { compatible = value; },
    get observerCallbacks() { return observerCallbacks; }, get observerCount() { return observerCount; },
    panel: () => root.querySelector("[data-skybricate-panel]"),
    tab: () => root.querySelector("[data-skybricate-tab]"),
    open() { root.querySelector("[data-skybricate-tab]")?.click(); },
    render() { hooks.fire("renderApplicationV2", app, root, {}); },
    close() { hooks.fire("closeApplicationV2", app); },
    destroy() { dispose(); windows.delete(window); window.happyDOM.abort(); } };
}
