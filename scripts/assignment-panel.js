import { persistedSystems } from './assignment-contract.js';

// This window reads only saved Fabricate definitions and writes only SkyBricate.
export function mountAssignmentPanel({ target, getGame, data, canWrite, text }) {
  const document = target.ownerDocument, panel = document.createElement('section');
  panel.className = 'skybricate-assignment-panel';
  panel.dataset.skybricateAssignments = '';
  let disposed = false, pending = false, started = false, systemId = '', componentId = '', selected = new Set(), systems = new Map();
  const el = (tag, content, parent = panel) => {
    const node = document.createElement(tag); if (content !== undefined) node.textContent = content;
    parent.append(node); return node;
  };
  el('p', text('AssignmentHint'));
  const controls = el('fieldset'); controls.className = 'skybricate-controls';
  el('legend', text('AssignmentsTitle'), controls);
  const systemLabel = el('label', text('CraftingSystem'), controls), systemSelect = el('select', undefined, systemLabel);
  systemSelect.dataset.skySystem = '';
  const componentLabel = el('label', text('Component'), controls), componentSelect = el('select', undefined, componentLabel);
  componentSelect.dataset.skyComponent = '';
  const chips = el('div', undefined, controls); chips.className = 'skybricate-property-chips';
  const button = (label, action) => {
    const node = el('button', text(label), controls); node.type = 'button'; node.dataset.skyAssignmentAction = action; return node;
  };
  const clear = button('ClearAssignments', 'clear'), save = button('SaveProperties', 'save');
  const refresh = button('ReloadAssignments', 'refresh'), reconcile = button('ReconcileAssignments', 'reconcile');
  el('p', text('SyncHint'));
  const message = el('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const live = () => !disposed && panel.isConnected && canWrite();
  const context = () => live() && !!systemId && !!componentId;
  const error = failure => { if (!disposed) message.textContent = `${text('Error')} ${failure.message}`; };
  function state() {
    controls.disabled = pending || !live();
    save.disabled = clear.disabled = !context();
    systemSelect.disabled = !systems.size;
    componentSelect.disabled = !systems.get(systemId)?.components.size;
  }
  function options(select, rows, value, empty) {
    select.replaceChildren();
    if (!rows.size) el('option', text(empty), select).value = '';
    for (const row of rows.values()) el('option', `${row.name || row.id} [${row.id}]`, select).value = row.id;
    select.value = value;
  }
  function loadProperties() {
    chips.replaceChildren(); selected = new Set();
    if (!systemId) { el('p', text('NoSystems'), chips); return; }
    if (!componentId) { el('p', text('NoComponents'), chips); return; }
    const system = data.getSnapshot().systems[systemId], properties = system?.properties ?? {};
    selected = new Set(system?.components[componentId] ?? []);
    if (!Object.keys(properties).length) el('p', text('AssignmentEmpty'), chips);
    for (const [id, property] of Object.entries(properties)) {
      const node = el('button', property.name, chips); node.type = 'button'; node.title = property.description;
      node.dataset.skyProperty = id; node.className = 'skybricate-property-toggle';
      node.setAttribute('aria-pressed', String(selected.has(id)));
    }
  }
  function components() {
    const rows = systems.get(systemId)?.components ?? new Map();
    if (!rows.has(componentId)) componentId = rows.keys().next().value ?? '';
    options(componentSelect, rows, componentId, 'NoComponents'); loadProperties();
  }
  async function reload() {
    if (!live() || pending) return;
    started = true;
    pending = true; state(); message.textContent = text('Saving'); panel.setAttribute('aria-busy', 'true');
    try {
      await data.reconcileAllComponentProperties({ canWrite: live });
      if (!live()) return;
      systems = persistedSystems(getGame());
      if (!systems.has(systemId)) { systemId = systems.keys().next().value ?? ''; componentId = ''; }
      options(systemSelect, systems, systemId, 'NoSystems'); components(); message.textContent = text('Reconciled');
    } catch (failure) { error(failure); }
    finally { pending = false; if (!disposed) { panel.removeAttribute('aria-busy'); state(); } }
  }
  function change(event) {
    if (pending || !live()) { systemSelect.value = systemId; componentSelect.value = componentId; return; }
    try {
      if (event.target === systemSelect) { systemId = systemSelect.value; componentId = ''; components(); }
      else if (event.target === componentSelect) { componentId = componentSelect.value; loadProperties(); }
      message.textContent = ''; state();
    } catch (failure) { error(failure); }
  }
  async function click(event) {
    const node = event.target.closest?.('button');
    if (!node || !panel.contains(node)) return;
    event.preventDefault(); event.stopPropagation();
    if (disposed || pending) return;
    if (!live()) { state(); message.textContent = text('AssignmentUnavailable'); return; }
    if (node === refresh || node === reconcile) { await reload(); return; }
    if (!context()) return;
    if (node.dataset.skyProperty) {
      const id = node.dataset.skyProperty;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      node.setAttribute('aria-pressed', String(selected.has(id))); message.textContent = ''; return;
    }
    if (node === clear) {
      selected.clear(); for (const chip of chips.querySelectorAll('button')) chip.setAttribute('aria-pressed', 'false');
      message.textContent = ''; return;
    }
    if (node !== save) return;
    const originSystem = systemId, originComponent = componentId;
    pending = true; state(); panel.setAttribute('aria-busy', 'true'); message.textContent = text('Saving');
    try {
      await data.setComponentProperties(originSystem, originComponent, [...selected], {
        canWrite: () => live() && systemId === originSystem && componentId === originComponent
      });
      if (live()) message.textContent = text('Saved');
    } catch (failure) { error(failure); }
    finally { pending = false; if (!disposed) { panel.removeAttribute('aria-busy'); state(); } }
  }
  panel.addEventListener('click', click); panel.addEventListener('change', change); target.append(panel);
  void reload();
  return { element: panel, refresh: reload, start() { if (!started) void reload(); }, dispose() {
    disposed = true; panel.removeEventListener('click', click); panel.removeEventListener('change', change); panel.remove();
  } };
}
