import { getAssignmentContract, persistedComponents, DELETED_HOOK } from './assignment-contract.js';
import { mountAssignmentPanel } from './assignment-panel.js';

export function installAssignmentAdapter({ hooks, getGame, data, compatible, notifications,
  Observer = globalThis.MutationObserver }) {
  const sessions = new Map();
  const text = key => getGame().i18n.localize(`SKYBRICATE.Editor.${key}`);
  const allowed = () => getGame().user?.isGM === true && compatible();
  const syncErrors = new Set();
  function report(error, systemId) {
    syncErrors.add(systemId);
    notifications()?.warn(text('SyncError'));
    for (const session of sessions.values()) session.schedule();
  }
  function close(app) { sessions.get(app)?.dispose(); sessions.delete(app); }
  function render(app, element) {
    if (app.options?.id !== 'fabricate-crafting-system-manager') return;
    if (!allowed()) { close(app); return; }
    const root = app.element ?? element, store = app._adminStore, previous = sessions.get(app);
    if (previous?.root === root && previous.store === store) { previous.schedule(); return; }
    close(app);
    if (typeof root?.querySelectorAll !== 'function' || !root.ownerDocument || typeof Observer !== 'function'
      || typeof store?.selectedSystemId?.subscribe !== 'function' || typeof store?.viewState?.subscribe !== 'function') return;
    let id, state, disposed = false, queued = false, mounted = null, notice = null, retry = null, retryPending = false, connectionObserver = null, reconciledSystemId = null;
    const unsubs = [];
    const live = () => !disposed && allowed() && root.isConnected && app.element === root && app._adminStore === store
      && typeof id === 'string' && !!id && state?.selectedSystem?.id === id;
    function context() {
      if (!live()) return null;
      getAssignmentContract(getGame());
      const forms = root.querySelectorAll('form#manager-component-edit-form.manager-component-edit-view');
      if (forms.length !== 1) return null;
      const form = forms[0], componentId = form.dataset.componentId;
      if (form.dataset.craftingSystemId !== id || !componentId || !persistedComponents(getGame(), id).has(componentId)) return null;
      return { form, systemId: id, componentId };
    }
    function unmount() { mounted?.panel.dispose(); mounted = null; }
    function reconcile() {
      queued = false; if (disposed) return;
      if (root.isConnected && connectionObserver) { connectionObserver.disconnect(); connectionObserver = null; }
      let next = null, contract = true, apiValid = true;
      try { getAssignmentContract(getGame()); } catch { apiValid = false; }
      try { next = context(); } catch { contract = false; }
      if (mounted && (!next || mounted.form !== next.form || mounted.systemId !== next.systemId
        || mounted.componentId !== next.componentId || !mounted.panel.element.isConnected)) unmount();
      if (!live()) { unmount(); notice?.remove(); notice = null; return; }
      if (!notice || !root.contains(notice)) {
        retry?.removeEventListener('click', reconcilePersisted);
        notice = root.ownerDocument.createElement('aside'); notice.className = 'skybricate-sync manager-muted';
        notice.dataset.skybricateSync = ''; const message = root.ownerDocument.createElement('span');
        notice.append(message); retry = root.ownerDocument.createElement('button'); retry.type = 'button';
        retry.className = 'manager-button'; retry.textContent = text('ReconcileAssignments'); notice.append(retry);
        retry.addEventListener('click', reconcilePersisted); root.append(notice);
      }
      // A supported API with an unknown/incomplete form must fail closed as well.
      const invalidForm = root.querySelector('#manager-component-edit-form') && !next;
      const message = !contract || invalidForm ? text('AssignmentContract') : syncErrors.size
        ? `${text('SyncError')} (${[...syncErrors].join(', ')})` : text(reconciledSystemId === id ? 'Reconciled' : 'SyncHint');
      if (notice.firstChild.textContent !== message) notice.firstChild.textContent = message;
      const disabled = retryPending || !apiValid || !live();
      if (retry.disabled !== disabled) retry.disabled = disabled;
      if (next && !mounted) {
        let panel;
        const canWrite = () => {
          try { const current = context(); return panel?.element.isConnected && !!current && current.form === next.form
            && current.systemId === next.systemId && current.componentId === next.componentId; }
          catch { return false; }
        };
        panel = mountAssignmentPanel({ target: next.form, ...next, data, canWrite, text });
        mounted = { ...next, panel };
      }
    }
    async function reconcilePersisted(event) {
      event.preventDefault(); event.stopPropagation();
      if (!live() || retryPending) return;
      const systemId = id; retryPending = true; retry.disabled = true;
      try {
        await data.reconcileComponentProperties(systemId, null, { canWrite: () => live() && id === systemId });
        syncErrors.delete(systemId);
        if (live() && id === systemId) { reconciledSystemId = systemId; schedule(); }
      } catch (error) { report(error, systemId); }
      finally { retryPending = false; if (!disposed) retry.disabled = !live(); }
    }
    function schedule() { if (!disposed && !queued) { queued = true; queueMicrotask(reconcile); } }
    const observer = new Observer(schedule);
    const session = { root, store, schedule, dispose() {
      disposed = true; observer.disconnect(); connectionObserver?.disconnect(); for (const unsubscribe of unsubs) unsubscribe();
      unmount(); retry?.removeEventListener('click', reconcilePersisted); notice?.remove();
    } };
    sessions.set(app, session);
    try {
      observer.observe(root, { childList: true, subtree: true, attributes: true });
      if (!root.isConnected) {
        connectionObserver = new Observer(schedule);
        connectionObserver.observe(root.ownerDocument, { childList: true, subtree: true });
      }
      for (const [source, receive] of [[store.selectedSystemId, value => { id = value; }], [store.viewState, value => { state = value; }]]) {
        const unsubscribe = source.subscribe(value => { receive(value); if (!live()) unmount(); schedule(); });
        if (typeof unsubscribe !== 'function') throw new Error('Unsupported store subscription');
        unsubs.push(unsubscribe);
      }
    } catch { close(app); notifications()?.warn(text('AssignmentContract')); }
  }
  const ids = [
    ['renderApplicationV2', render], ['closeApplicationV2', close],
    ['updateUser', () => { for (const [app, session] of sessions) { if (!allowed()) close(app); else session.schedule(); } }],
    [DELETED_HOOK, payload => {
      if (!allowed()) return;
      try {
        getAssignmentContract(getGame());
        if (!payload || typeof payload.systemId !== 'string' || !Array.isArray(payload.componentIds) || !payload.componentIds.length) return;
        data.reconcileComponentProperties(payload.systemId, payload.componentIds, { canWrite: allowed }).then(() => {
          for (const session of sessions.values()) session.schedule();
        }).catch(error => report(error, payload.systemId));
      } catch (error) { report(error, payload?.systemId); }
    }]
  ].map(([name, handler]) => [name, hooks.on(name, handler)]);
  return () => { for (const app of sessions.keys()) close(app); for (const [name, id] of ids) hooks.off(name, id); };
}
