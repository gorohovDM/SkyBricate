import { persistedSystems } from './assignment-contract.js';
import { specialPropertiesEnabled, subscribeSpecialSetting } from './data-store.js';

// This window reads only saved Fabricate definitions and writes only SkyBricate.
export function mountAssignmentPanel({ target, getGame, data, canWrite, text }) {
  const document = target.ownerDocument, panel = document.createElement('section');
  panel.className = 'skybricate-assignment-panel'; panel.dataset.skybricateAssignments = '';
  let disposed = false, pending = false, started = false, systemId = '', componentId = '', systems = new Map();
  let properties = {}, ordinary = [], special = [], specialVisible = specialPropertiesEnabled(getGame());
  const el = (tag, content, parent = panel) => {
    const node = document.createElement(tag); if (content !== undefined) node.textContent = content;
    parent.append(node); return node;
  };
  const button = (label, action, parent) => {
    const node = el('button', text(label), parent); node.type = 'button'; node.dataset.skyAssignmentAction = action; return node;
  };
  el('p', text('AssignmentHint'));
  const controls = el('fieldset'); controls.className = 'skybricate-controls';
  el('legend', text('AssignmentsTitle'), controls);
  const systemLabel = el('label', text('CraftingSystem'), controls), systemSelect = el('select', undefined, systemLabel);
  systemSelect.dataset.skySystem = '';
  const componentLabel = el('label', text('Component'), controls), componentSelect = el('select', undefined, componentLabel);
  componentSelect.dataset.skyComponent = '';
  const zones = {};
  for (const kind of ['ordinary', 'special']) {
    const zone = el('section', undefined, controls); zone.className = 'skybricate-assignment-zone'; zone.dataset.skyZone = kind;
    const heading = el('div', undefined, zone); heading.className = 'skybricate-zone-heading';
    el('h3', text(kind === 'ordinary' ? 'OrdinaryProperty' : 'SpecialProperty'), heading);
    button('Add', `add-${kind}`, heading);
    const rows = el('div', undefined, zone); rows.dataset.skyRows = kind;
    zones[kind] = { zone, rows };
  }
  const clear = button('ClearAssignments', 'clear', controls), save = button('SaveProperties', 'save', controls);
  const refresh = button('ReloadAssignments', 'refresh', controls), reconcile = button('ReconcileAssignments', 'reconcile', controls);
  el('p', text('SyncHint'));
  const message = el('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const live = () => !disposed && panel.isConnected && canWrite();
  const context = () => live() && !!systemId && !!componentId;
  const error = failure => { if (!disposed) message.textContent = `${text('Error')} ${failure.message}`; };
  function state() {
    controls.disabled = pending || !live();
    save.disabled = clear.disabled = !context();
    systemSelect.disabled = !systems.size; componentSelect.disabled = !systems.get(systemId)?.components.size;
    for (const node of panel.querySelectorAll('[data-sky-assignment-action^="add-"]')) node.disabled = !context();
  }
  function options(select, rows, value, empty) {
    select.replaceChildren();
    if (!rows.size) el('option', text(empty), select).value = '';
    for (const row of rows.values()) el('option', `${row.name || row.id} [${row.id}]`, select).value = row.id;
    select.value = value;
  }
  function renderRows() {
    zones.special.zone.hidden = !specialVisible;
    const used = [...ordinary, ...special].filter(Boolean);
    for (const [kind, values] of [['ordinary', ordinary], ['special', special]]) {
      const parent = zones[kind].rows; parent.replaceChildren();
      if (!systemId || !componentId || !Object.keys(properties).length) {
        el('p', text(!systemId ? 'NoSystems' : !componentId ? 'NoComponents' : 'AssignmentEmpty'), parent);
      }
      values.forEach((value, index) => {
        const row = el('div', undefined, parent); row.className = 'skybricate-assignment-row';
        const select = el('select', undefined, row); select.dataset.skyKind = kind; select.dataset.skyIndex = index;
        select.setAttribute('aria-label', text(kind === 'ordinary' ? 'OrdinaryProperty' : 'SpecialProperty'));
        el('option', text('ChooseProperty'), select).value = '';
        for (const [id, property] of Object.entries(properties)) {
          if (id !== value && used.includes(id)) continue;
          const option = el('option', property.name, select); option.value = id; option.title = property.description;
        }
        select.value = value;
        const remove = button('RemoveAssignment', 'remove', row); remove.textContent = '';
        remove.title = text('RemoveAssignment'); remove.setAttribute('aria-label', text('RemoveAssignment'));
        remove.dataset.skyKind = kind; remove.dataset.skyIndex = index;
        const icon = el('i', undefined, remove); icon.className = 'fas fa-trash'; icon.setAttribute('aria-hidden', 'true');
      });
    }
    state();
  }
  function syncSetting() {
    const enabled = specialPropertiesEnabled(getGame());
    if (enabled === specialVisible) return;
    // A setting change discards special drafts and reloads persisted links, preserving ordinary drafts.
    const current = data.getSnapshot().systems[systemId];
    special = [...(current?.specialComponents[componentId] ?? [])]; specialVisible = enabled;
    renderRows();
  }
  function loadProperties() {
    ordinary = []; special = []; properties = {};
    specialVisible = specialPropertiesEnabled(getGame());
    if (systemId && componentId) {
      const system = data.getSnapshot().systems[systemId]; properties = system?.properties ?? {};
      ordinary = [...(system?.components[componentId] ?? [])]; special = [...(system?.specialComponents[componentId] ?? [])];
    }
    renderRows();
  }
  function components() {
    const rows = systems.get(systemId)?.components ?? new Map();
    if (!rows.has(componentId)) componentId = rows.keys().next().value ?? '';
    options(componentSelect, rows, componentId, 'NoComponents'); loadProperties();
  }
  async function reload() {
    if (!live() || pending) return;
    started = true; pending = true; state(); message.textContent = text('Saving'); panel.setAttribute('aria-busy', 'true');
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
      syncSetting();
      if (event.target === systemSelect) { systemId = systemSelect.value; componentId = ''; components(); }
      else if (event.target === componentSelect) { componentId = componentSelect.value; loadProperties(); }
      else if (event.target.dataset.skyKind) {
        const node = event.target, kind = node.dataset.skyKind, values = kind === 'ordinary' ? ordinary : special;
        if (kind === 'special' && !specialVisible) return;
        const index = Number(node.dataset.skyIndex), id = node.value;
        if (!Number.isInteger(index) || index < 0 || index >= values.length) return;
        const others = [...ordinary.filter((_, i) => kind !== 'ordinary' || i !== index), ...special.filter((_, i) => kind !== 'special' || i !== index)];
        if (id && (!Object.hasOwn(properties, id) || others.includes(id))) { renderRows(); return; }
        values[index] = id; renderRows();
      }
      message.textContent = ''; state();
    } catch (failure) { error(failure); }
  }
  async function click(event) {
    const node = event.target.closest?.('button');
    if (!node || !panel.contains(node)) return;
    event.preventDefault(); event.stopPropagation();
    if (disposed || pending) return;
    if (!live()) { state(); message.textContent = text('AssignmentUnavailable'); return; }
    try {
      syncSetting();
      if (node === refresh || node === reconcile) { await reload(); return; }
      if (!context()) return;
      const action = node.dataset.skyAssignmentAction;
      if (action.startsWith('add-')) {
        const kind = action.slice(4); if (kind === 'special' && !specialVisible) return;
        (kind === 'ordinary' ? ordinary : special).push(''); renderRows(); message.textContent = ''; return;
      }
      if (action === 'remove') {
        const kind = node.dataset.skyKind; if (kind === 'special' && !specialVisible) return;
        (kind === 'ordinary' ? ordinary : special).splice(Number(node.dataset.skyIndex), 1); renderRows(); message.textContent = ''; return;
      }
      if (node === clear) { ordinary = []; if (specialVisible) special = []; renderRows(); message.textContent = ''; return; }
      if (node !== save) return;
      const originSystem = systemId, originComponent = componentId, editSpecial = specialVisible;
      pending = true; state(); panel.setAttribute('aria-busy', 'true'); message.textContent = text('Saving');
      try {
        await data.setComponentAssignments(originSystem, originComponent, { ordinary: ordinary.filter(Boolean), special: special.filter(Boolean) }, {
          editSpecial, canWrite: () => live() && systemId === originSystem && componentId === originComponent
        });
        if (live()) { loadProperties(); message.textContent = text('Saved'); }
      } finally { pending = false; if (!disposed) { panel.removeAttribute('aria-busy'); state(); } }
    } catch (failure) { error(failure); }
  }
  const unsubscribe = subscribeSpecialSetting(() => { if (!disposed) { try { syncSetting(); } catch (failure) { error(failure); } } });
  panel.addEventListener('click', click); panel.addEventListener('change', change); target.append(panel);
  void reload();
  return { element: panel, refresh: reload, start() { if (!started) void reload(); }, dispose() {
    disposed = true; unsubscribe(); panel.removeEventListener('click', click); panel.removeEventListener('change', change); panel.remove();
  } };
}
