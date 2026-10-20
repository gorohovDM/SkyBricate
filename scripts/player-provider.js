import { mountPlayerPanel } from './player-panel.js';

// Fabricate 1.9.10 public API v1. Core remounts on actor/context changes.
export function installPlayerProvider({ getGame, data, hooks, compatible }) {
  const mounts = new Set(), targets = new WeakMap();
  let disposed = false;
  const text = key => getGame().i18n.localize(`SKYBRICATE.Player.${key}`);
  const provider = {
    apiVersion: 1, id: 'skybricate',
    tabs: [{ id: 'properties', label: text('Title'), icon: 'fa-solid fa-tags' }],
    mount({ target, tabId, context }) {
      targets.get(target)?.();
      if (disposed || tabId !== 'properties' || context?.schemaVersion !== 1 || context.surface !== 'player'
        || context.surfaceId !== 'skybricate' || context.tabId !== tabId) return;
      const panel = mountPlayerPanel({ target, context, getGame, data, hooks, compatible, text });
      const cleanup = () => {
        panel.dispose(); mounts.delete(cleanup);
        if (targets.get(target) === cleanup) targets.delete(target);
      };
      mounts.add(cleanup); targets.set(target, cleanup); return cleanup;
    }
  };
  const unregister = getGame().fabricate.api.playerExtensions.registerPlayerNavProvider(provider);
  return () => {
    if (disposed) return; disposed = true;
    for (const cleanup of [...mounts]) cleanup();
    unregister();
  };
}
