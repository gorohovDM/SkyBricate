import { mountPropertyPanel } from "./property-panel.js";
import { persistedRecipes } from './recipe-contract.js';

const MANAGER_ID = "fabricate-crafting-system-manager";
let surfaceId = 0;
const NATIVE_IDS = ["recipe", "component", "tag"];

// Private DOM contract of TagsCategoriesView 1.9.10. Fail closed on drift.
function vocabularySurface(root) {
  const hosts = root.querySelectorAll(".manager-tags-categories");
  if (!hosts.length) return null;
  if (hosts.length !== 1) throw new Error("Ambiguous vocabulary host");
  const host = hosts[0];
  const strips = host.querySelectorAll('.manager-vocabulary-tabs[role="tablist"]');
  const workspaces = host.querySelectorAll('.manager-tags-categories-workspace[role="tabpanel"]:not(.skybricate-workspace)');
  if (strips.length !== 1 || workspaces.length !== 1) throw new Error("Unknown vocabulary surface");
  const strip = strips[0], workspace = workspaces[0];
  const tabs = [...strip.querySelectorAll('[role="tab"]')].filter(node => !node.hasAttribute("data-skybricate-tab"));
  if (tabs.length !== 3 || tabs.some((tab, i) => tab.tagName !== "BUTTON"
    || !tab.classList.contains("manager-editor-tab-button")
    || !["true", "false"].includes(tab.getAttribute("aria-selected")) || !["0", "-1"].includes(tab.getAttribute("tabindex"))
    || tab.dataset.vocabularyTab !== NATIVE_IDS[i] || tab.id !== `vocabulary-tab-${NATIVE_IDS[i]}`
    || tab.getAttribute("aria-controls") !== `vocabulary-panel-${NATIVE_IDS[i]}`)
    || !NATIVE_IDS.some(id => workspace.id === `vocabulary-panel-${id}`)
    || workspace.getAttribute("aria-labelledby") !== workspace.id.replace("panel", "tab")) {
    throw new Error("Unknown vocabulary tabs");
  }
  const selected = tabs.filter(tab => tab.getAttribute("aria-selected") === "true");
  if (!strip.querySelector('[data-skybricate-tab][aria-selected="true"]')
    && (selected.length !== 1 || selected[0].getAttribute("aria-controls") !== workspace.id)) {
    throw new Error("Unknown native selection");
  }
  return { host, strip, workspace, tabs };
}

// No native callback/store is replaced. Owned tab attributes are restored before
// native clicks; navigation elsewhere continues through Fabricate's dirty guards.
function mountVocabulary({ surface, systemId, data, text, canWrite }) {
  const { host, strip, workspace, tabs } = surface, doc = host.ownerDocument;
  const tab = doc.createElement("button");
  tab.type = "button"; tab.className = "manager-editor-tab-button";
  tab.dataset.skybricateTab = ""; tab.id = `vocabulary-tab-skybricate-${++surfaceId}`;
  tab.setAttribute("role", "tab"); tab.setAttribute("aria-controls", `vocabulary-panel-skybricate-${surfaceId}`);
  const icon = doc.createElement("i"); icon.className = "fas fa-tag"; icon.setAttribute("aria-hidden", "true");
  const label = doc.createElement("span"); label.textContent = text("Title"); tab.append(icon, label);
  const target = doc.createElement("div"); target.className = "manager-tags-categories-workspace skybricate-workspace";
  target.id = `vocabulary-panel-skybricate-${surfaceId}`; target.setAttribute("role", "tabpanel");
  target.setAttribute("aria-labelledby", tab.id); target.hidden = true;
  strip.append(tab); host.append(target);
  let active = false, panel = null, originals = [], nativePanelId = workspace.id;
  const set = (node, attr, value) => { if (node.getAttribute(attr) !== value) node.setAttribute(attr, value); };
  function restore() {
    const nativeChanged = workspace.id !== nativePanelId && NATIVE_IDS.some(id => workspace.id === `vocabulary-panel-${id}`);
    for (const [node, attr, before, owned] of originals) {
      if (nativeChanged && tabs.includes(node)) {
        const selected = node.getAttribute("aria-controls") === workspace.id;
        if (attr === "aria-selected") set(node, attr, String(selected));
        if (attr === "tabindex") set(node, attr, selected ? "0" : "-1");
        if (attr === "is-active" && node.classList.contains("is-active") !== selected) node.classList.toggle("is-active", selected);
        continue;
      }
      if (attr === "is-active") {
        if (before && !node.classList.contains("is-active")) node.classList.add("is-active");
        continue;
      }
      if (node.getAttribute(attr) === owned) {
        if (before === null) node.removeAttribute(attr); else set(node, attr, before);
      }
    }
    originals = [];
  }
  function take(node, attr, value) {
    originals.push([node, attr, node.getAttribute(attr), value]); set(node, attr, value);
  }
  function activate() {
    if (!canWrite()) return;
    if (!active) {
      active = true; nativePanelId = workspace.id;
      take(workspace, "hidden", "");
      for (const native of tabs) {
        take(native, "aria-selected", "false"); take(native, "tabindex", "-1");
        const wasActive = native.classList.contains("is-active");
        originals.push([native, "is-active", wasActive, false]);
        if (wasActive) native.classList.remove("is-active");
      }
      panel = mountPropertyPanel({ target, systemId, data, text, canWrite: () => active && target.isConnected && panel?.element.isConnected && workspace.id === nativePanelId
        && !tabs.some(node => node.getAttribute("aria-selected") === "true") && canWrite() });
    }
    target.hidden = false; set(tab, "aria-selected", "true"); set(tab, "tabindex", "0");
    if (!tab.classList.contains("is-active")) tab.classList.add("is-active");
  }
  function deactivate() {
    active = false; panel?.dispose(); panel = null; restore();
    if (!target.hidden) target.hidden = true;
    set(tab, "aria-selected", "false"); set(tab, "tabindex", "-1");
    if (tab.classList.contains("is-active")) tab.classList.remove("is-active");
  }
  function click(event) {
    const button = event.target.closest?.('[role="tab"]');
    if (button === tab) { event.preventDefault(); event.stopPropagation(); activate(); }
    else if (tabs.includes(button)) deactivate();
  }
  function keydown(event) {
    const button = event.target.closest?.('[role="tab"]'), all = [...tabs, tab], index = all.indexOf(button);
    if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 3
      : (index + (event.key === "ArrowRight" ? 1 : -1) + 4) % 4;
    all[next].click(); all[next].focus();
  }
  strip.addEventListener("click", click, true); strip.addEventListener("keydown", keydown, true);
  deactivate();
  return { element: tab, sync(next) {
    if (!target.isConnected || !strip.contains(tab) || next.workspace !== workspace || next.strip !== strip || next.tabs.some((node, i) => node !== tabs[i])) return false;
    if (active && (workspace.id !== nativePanelId || tabs.some(node => node.getAttribute("aria-selected") === "true"))) deactivate();
    return true;
  }, dispose() {
    deactivate(); strip.removeEventListener("click", click, true); strip.removeEventListener("keydown", keydown, true);
    tab.remove(); target.remove();
  } };
}

export function installManagerAdapter({ hooks, getGame, data, compatible,
  notifications, openAssignments, openRecipeRules, Observer = globalThis.MutationObserver }) {
  const sessions = new Map(), warned = new WeakSet();
  const text = key => getGame().i18n.localize(`SKYBRICATE.Editor.${key}`);
  const allowed = () => getGame().user?.isGM === true && compatible();
  function warn(app) {
    if (warned.has(app) || !getGame().user?.isGM) return;
    warned.add(app); notifications()?.warn(text("Contract"));
  }
  function close(app) { sessions.get(app)?.dispose(); sessions.delete(app); }
  function render(app, element) {
    if (app.options?.id !== MANAGER_ID) return;
    if (!allowed()) { close(app); return; }
    const root = app.element ?? element, store = app._adminStore, previous = sessions.get(app);
    if (previous && previous.root === root && previous.store === store) { previous.schedule(); return; }
    close(app);
    if (!root?.querySelectorAll || !root.ownerDocument || typeof Observer !== "function"
      || typeof store?.selectedSystemId?.subscribe !== "function"
      || typeof store?.viewState?.subscribe !== "function") { warn(app); return; }
    let selectedId, state, mounted = null, assignmentAction = null, disposed = false, queued = false, connectionObserver = null, recipeEpoch = 0;
    const recipeActions = new Map();
    const unsubscribers = [];
    function unmount() { mounted?.panel.dispose(); mounted = null; }
    // Stock 1.9.10 header action container. No routes, drafts or stores are changed.
    function assignmentHost() {
      const hosts = root.querySelectorAll('.manager-header-actions');
      return hosts.length === 1 && hosts[0].tagName === 'DIV' ? hosts[0] : null;
    }
    function disposeAssignmentAction() { assignmentAction?.dispose(); assignmentAction = null; }
    function recipeAvailable(id, epoch) {
      return allowed() && !disposed && root.isConnected && app.element === root && app._adminStore === store
        && selectedId === id && state?.selectedSystem?.id === id && recipeEpoch === epoch;
    }
    function reconcileRecipeActions() {
      const wanted = new Map();
      if (typeof openRecipeRules === 'function' && recipeAvailable(selectedId, recipeEpoch)) {
        const rows = root.querySelectorAll('.manager-recipe-row[data-recipe-id]');
        if (rows.length) {
          const recipes = persistedRecipes(getGame()), seen = new Set();
          for (const row of rows) {
            const id = row.dataset.recipeId, edits = row.querySelectorAll('button.manager-recipe-edit[data-recipe-edit]');
            if (row.tagName !== 'LI' || seen.has(id) || edits.length !== 1 || edits[0].dataset.recipeEdit !== id
              || recipes.get(id)?.craftingSystemId !== selectedId) throw new Error('Unsupported native recipe row');
            seen.add(id); wanted.set(row, { id, edit: edits[0], systemId: selectedId, epoch: recipeEpoch });
          }
        }
      }
      for (const [row, action] of recipeActions) {
        const next = wanted.get(row);
        if (!next || next.id !== action.id || next.systemId !== action.systemId || next.epoch !== action.epoch
          || next.edit !== action.edit || !row.contains(action.button)) { action.dispose(); recipeActions.delete(row); }
      }
      for (const [row, next] of wanted) {
        if (recipeActions.has(row)) continue;
        const button = root.ownerDocument.createElement('button'); button.type = 'button';
        button.className = 'manager-icon-button'; button.dataset.skybricateRecipe = next.id;
        button.title = button.ariaLabel = getGame().i18n.localize('SKYBRICATE.Recipe.Title');
        const icon = root.ownerDocument.createElement('i'); icon.className = 'fas fa-sliders'; icon.setAttribute('aria-hidden', 'true'); button.append(icon);
        const available = () => recipeAvailable(next.systemId, next.epoch);
        const click = async event => {
          event.preventDefault(); event.stopPropagation();
          if (!available() || !row.isConnected || row.dataset.recipeId !== next.id || !row.contains(button)) return;
          try {
            if (persistedRecipes(getGame()).get(next.id)?.craftingSystemId !== next.systemId) return;
            await openRecipeRules(next.systemId, next.id, available);
          } catch { notifications()?.warn(text('Contract')); }
        };
        button.addEventListener('click', click); next.edit.after(button);
        recipeActions.set(row, { ...next, button, dispose() { button.removeEventListener('click', click); button.remove(); } });
      }
    }
    function reconcileAssignmentAction() {
      const host = allowed() && !disposed && root.isConnected && app.element === root
        && app._adminStore === store && typeof openAssignments === 'function' ? assignmentHost() : null;
      if (assignmentAction && (assignmentAction.host !== host || !host?.contains(assignmentAction.button))) disposeAssignmentAction();
      if (!host || assignmentAction) return;
      const button = root.ownerDocument.createElement('button');
      button.type = 'button'; button.className = 'manager-button is-ghost';
      button.dataset.skybricateAssignments = ''; button.textContent = text('PropertyAssignments');
      const click = async event => {
        event.preventDefault(); event.stopPropagation();
        if (disposed || !allowed() || !root.isConnected || app.element !== root
          || app._adminStore !== store || assignmentHost() !== host || !host.contains(button)) return;
        try { await openAssignments(); }
        catch { notifications()?.warn(text('OpenAssignmentsError')); }
      };
      button.addEventListener('click', click); host.append(button);
      assignmentAction = { host, button, dispose() { button.removeEventListener('click', click); button.remove(); } };
    }
    function context() {
      if (!allowed() || disposed || !root.isConnected || app.element !== root || app._adminStore !== store) return null;
      const system = state?.selectedSystem;
      if (typeof selectedId !== "string" || !state || !Object.hasOwn(state, "selectedSystem")
        || (system !== null && (!system || typeof system.id !== "string" || typeof system.resolutionMode !== "string"))) {
        warn(app); return null;
      }
      // ID emission precedes async viewState refresh. Never show the old system.
      if (!selectedId || system?.id !== selectedId) return null;
      const surface = vocabularySurface(root);
      return surface ? { id: selectedId, target: surface.host, surface } : null;
    }
    function reconcile() {
      queued = false;
      if (disposed) return;
      try {
        if (root.isConnected && connectionObserver) { connectionObserver.disconnect(); connectionObserver = null; }
        reconcileAssignmentAction();
        reconcileRecipeActions();
        const next = context();
        if (mounted && (!next || mounted.id !== next.id || mounted.target !== next.target
          || !mounted.panel.element.isConnected || !mounted.panel.sync(next.surface))) unmount();
        if (next && !mounted) {
          const panel = mountVocabulary({ surface: next.surface, systemId: next.id, data, text,
            canWrite: () => {
              try {
                const current = context();
                return !!current && current.id === next.id && current.target === next.target
                  && current.surface.workspace === next.surface.workspace && current.surface.strip === next.surface.strip
                  && current.surface.tabs.every((tab, i) => tab === next.surface.tabs[i]);
              } catch { warn(app); return false; }
            } });
          mounted = { ...next, panel };
        }
      } catch { unmount(); for (const action of recipeActions.values()) action.dispose(); recipeActions.clear(); warn(app); }
    }
    function schedule() {
      if (disposed || queued) return;
      queued = true; queueMicrotask(reconcile);
    }
    function changed() {
      if (mounted && (state?.selectedSystem?.id !== mounted.id || selectedId !== mounted.id)) unmount();
      schedule();
    }
    const observer = new Observer(schedule);
    const session = { root, store, schedule, dispose() {
      disposed = true; observer.disconnect(); connectionObserver?.disconnect(); connectionObserver = null;
      for (const unsubscribe of unsubscribers) unsubscribe();
      disposeAssignmentAction();
      for (const action of recipeActions.values()) action.dispose(); recipeActions.clear();
      unmount();
    } };
    sessions.set(app, session);
    try {
      observer.observe(root, { childList: true, subtree: true, attributes: true });
      if (!root.isConnected) {
        connectionObserver = new Observer(schedule);
        connectionObserver.observe(root.ownerDocument, { childList: true, subtree: true });
      }
      for (const [source, receive] of [
        [store.selectedSystemId, value => { if (value !== selectedId) recipeEpoch++; selectedId = value; }],
        [store.viewState, value => { state = value; }]
      ]) {
        const unsubscribe = source.subscribe(value => { receive(value); changed(); });
        if (typeof unsubscribe !== "function") throw new Error("Unknown store contract");
        unsubscribers.push(unsubscribe);
      }
    } catch { close(app); warn(app); }
  }
  const renderHook = hooks.on("renderApplicationV2", render), closeHook = hooks.on("closeApplicationV2", close);
  const userHook = hooks.on("updateUser", () => {
    for (const [app, session] of sessions) { if (!allowed()) close(app); else session.schedule(); }
  });
  const settingHook = hooks.on('updateSetting', setting => {
    if (!['fabricate.recipes', 'fabricate.craftingSystems'].includes(setting.key) || !allowed()) return;
    for (const session of sessions.values()) session.schedule();
    // Strict corpus read must succeed before cleanup. A failed native write never
    // fires a setting update. Queue rechecks the persisted corpus before deleting.
    try {
      const recipes = persistedRecipes(getGame()), snapshot = data.getSnapshot();
      const stale = Object.entries(snapshot.systems).some(([systemId, system]) =>
        Object.keys(system.recipeRules).some(id => recipes.get(id)?.craftingSystemId !== systemId));
      if (stale) void data.reconcileRecipeRules({ canWrite: allowed }).catch(() => notifications()?.warn(text('Contract')));
    } catch { notifications()?.warn(text('Contract')); }
  });
  return () => {
    for (const app of sessions.keys()) close(app);
    hooks.off("renderApplicationV2", renderHook); hooks.off("closeApplicationV2", closeHook); hooks.off("updateUser", userHook);
    hooks.off('updateSetting', settingHook);
  };
}
