import { mountPropertyPanel } from "./property-panel.js";

const MANAGER_ID = "fabricate-crafting-system-manager";
const SETTINGS = "[data-crafting-settings]";
const RESOLUTION = "[data-crafting-resolution-section]";
const MODE = "[data-crafting-resolution-mode]";

// Version-specific, read-only bridge to Fabricate 1.9.10's Svelte manager.
// Foundry render hooks do not fire on Svelte navigation: both stores and DOM
// must be observed. Never patch a Fabricate method or write to its stores.
export function installManagerAdapter({ hooks, getGame, data, compatible,
  notifications, Observer = globalThis.MutationObserver }) {
  const sessions = new Map();
  const warned = new WeakSet();
  const text = key => getGame().i18n.localize(`SKYBRICATE.Editor.${key}`);
  const allowed = () => getGame().user?.isGM === true && compatible();
  function warn(app) {
    if (warned.has(app) || !getGame().user?.isGM) return;
    warned.add(app);
    notifications()?.warn(text("Contract"));
  }
  function close(app) { sessions.get(app)?.dispose(); sessions.delete(app); }
  function recheck() {
    for (const [app, session] of sessions) {
      if (!allowed()) close(app);
      else session.schedule();
    }
  }
  function render(app, element) {
    if (app.options?.id !== MANAGER_ID) return;
    if (!allowed()) { close(app); return; }
    const root = app.element ?? element;
    const store = app._adminStore;
    const previous = sessions.get(app);
    if (previous && previous.root === root && previous.store === store) { previous.schedule(); return; }
    close(app);
    if (!root?.querySelectorAll || !root.ownerDocument || typeof Observer !== "function"
      || typeof store?.selectedSystemId?.subscribe !== "function"
      || typeof store?.viewState?.subscribe !== "function") { warn(app); return; }

    let selectedId, state, mounted = null, disposed = false, queued = false, connectionObserver = null;
    const unsubscribers = [];
    function unmount() { mounted?.panel.dispose(); mounted = null; }
    function context() {
      if (!allowed() || disposed || !root.isConnected || app.element !== root
        || app._adminStore !== store) return null;
      const system = state?.selectedSystem;
      if (typeof selectedId !== "string" || !state || !Object.hasOwn(state, "selectedSystem")
        || (system !== null && (!system || typeof system.id !== "string" || typeof system.resolutionMode !== "string"))) {
        warn(app); return null;
      }
      // selectedSystemId changes BEFORE async refresh publishes viewState.
      if (!selectedId || system?.id !== selectedId
        || system.resolutionMode !== "alchemy") return null;
      const hosts = root.querySelectorAll(SETTINGS);
      if (hosts.length !== 1) { if (hosts.length > 1) warn(app); return null; }
      const host = hosts[0];
      const sections = host.querySelectorAll(RESOLUTION);
      const modes = sections.length === 1 ? sections[0].querySelectorAll(MODE) : [];
      const checked = modes.length === 1 ? modes[0].querySelectorAll('input[type="radio"]:checked') : [];
      if (sections.length !== 1 || modes.length !== 1 || checked.length !== 1) { warn(app); return null; }
      // Native radio may optimistically change while migration awaits confirmation.
      if (checked[0].value !== "alchemy") return null;
      return { id: selectedId, target: sections[0] };
    }
    function reconcile() {
      queued = false;
      if (disposed) return;
      try {
        if (root.isConnected && connectionObserver) {
          connectionObserver.disconnect(); connectionObserver = null;
        }
        const next = context();
        if (mounted && (!next || mounted.id !== next.id || mounted.target !== next.target
          || !mounted.panel.element.isConnected)) unmount();
        if (next && !mounted) {
          const panel = mountPropertyPanel({ target: next.target, systemId: next.id, data, text,
            canWrite: () => {
              const current = context();
              return !!current && current.id === next.id && current.target === next.target;
            } });
          mounted = { ...next, panel };
        }
      } catch { unmount(); warn(app); }
    }
    function schedule() {
      if (disposed || queued) return;
      queued = true;
      // The root's Svelte subscription is already mounted at renderApplicationV2.
      // Its scheduled flush runs before this callback; the observer covers later flushes.
      queueMicrotask(reconcile);
    }
    function changed() {
      // Invalidate immediately, without waiting for Svelte DOM updates.
      if (mounted && (state?.selectedSystem?.id !== mounted.id || selectedId !== mounted.id
        || state?.selectedSystem?.resolutionMode !== "alchemy")) unmount();
      schedule();
    }
    const observer = new Observer(schedule);
    const session = { root, store, schedule, dispose() {
      disposed = true;
      observer.disconnect();
      connectionObserver?.disconnect(); connectionObserver = null;
      root.removeEventListener("change", schedule, true);
      for (const unsubscribe of unsubscribers) unsubscribe();
      unmount();
    } };
    sessions.set(app, session);
    try {
      observer.observe(root, { childList: true, subtree: true, attributes: true });
      // The documented render hook may provide pending HTML before insertion.
      // Watch for its insertion only until connected, then observe this app alone.
      if (!root.isConnected) {
        connectionObserver = new Observer(schedule);
        connectionObserver.observe(root.ownerDocument, { childList: true, subtree: true });
      }
      root.addEventListener("change", schedule, true);
      for (const [source, receive] of [
        [store.selectedSystemId, value => { selectedId = value; }],
        [store.viewState, value => { state = value; }]
      ]) {
        const unsubscribe = source.subscribe(value => { receive(value); changed(); });
        if (typeof unsubscribe !== "function") throw new Error("Unknown store contract");
        unsubscribers.push(unsubscribe);
      }
    } catch { close(app); warn(app); }
  }
  const renderHook = hooks.on("renderApplicationV2", render);
  const closeHook = hooks.on("closeApplicationV2", close);
  const userHook = hooks.on("updateUser", recheck);
  return () => {
    for (const app of sessions.keys()) close(app);
    hooks.off("renderApplicationV2", renderHook);
    hooks.off("closeApplicationV2", closeHook);
    hooks.off("updateUser", userHook);
  };
}
