import { persistedSystems } from './assignment-contract.js';
import { specialPropertiesEnabled, subscribeSpecialSetting } from './data-store.js';

// World Actors of any system/type; synthetic token Actors are deliberately absent.
export function mountKnowledgePanel({ target, getGame, data, canWrite, text }) {
  const document = target.ownerDocument, panel = document.createElement('section');
  panel.className = 'skybricate-assignment-panel';
  let disposed = false, pending = false, started = false, revision = 0;
  let actorId = '', systemId = '', componentId = '', systems = new Map();
  const live = () => !disposed && panel.isConnected && getGame().user?.isGM === true && canWrite();
  const el = (tag, label, parent = panel) => {
    const node = document.createElement(tag); if (label !== undefined) node.textContent = label;
    parent.append(node); return node;
  };
  el('p', text('KnowledgeHint'));
  const controls = el('fieldset');
  const selectors = {};
  for (const [key, label] of [['actor', 'Actor'], ['system', 'CraftingSystem'], ['component', 'Component']]) {
    selectors[key] = el('select', undefined, el('label', text(label), controls));
    selectors[key].dataset.skyKnowledgeSelect = key;
  }
  const rows = el('div', undefined, controls);
  const refresh = el('button', text('ReloadAssignments'), controls); refresh.type = 'button';
  refresh.dataset.skyKnowledgeRefresh = '';
  const message = el('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const state = () => { controls.disabled = pending || !live(); panel.setAttribute('aria-busy', String(pending)); };
  const error = failure => { if (!disposed) message.textContent = `${text('Error')} ${failure.message}`; };
  function options(select, values, value, empty) {
    select.replaceChildren();
    if (!values.size) el('option', text(empty), select).value = '';
    for (const row of values.values()) el('option', `${row.name || row.id} [${row.id}]`, select).value = row.id;
    select.value = value;
  }
  function renderRows() {
    revision++;
    rows.replaceChildren();
    const snapshot = data.getSnapshot(), system = snapshot.systems[systemId];
    const known = snapshot.knowledge[actorId]?.[systemId]?.[componentId] ?? [];
    const ordinary = system?.components[componentId] ?? [];
    const special = specialPropertiesEnabled(getGame()) ? system?.specialComponents[componentId] ?? [] : [];
    if (!actorId || !systemId || !componentId || !ordinary.length && !special.length) el('p', text('NoKnowledgeAssignments'), rows);
    if (actorId && systemId && componentId) for (const [kind, ids] of [['OrdinaryProperty', ordinary], ['SpecialProperty', special]]) {
      if (!ids.length) continue;
      el('h3', text(kind), rows);
      for (const id of ids) {
        const row = el('div', undefined, rows); row.className = 'skybricate-assignment-row';
        const label = el('span', system.properties[id].name, row); label.title = system.properties[id].description;
        el('span', text(known.includes(id) ? 'Known' : 'Unknown'), row);
        const toggle = el('button', text(known.includes(id) ? 'HideKnowledge' : 'RevealKnowledge'), row);
        toggle.type = 'button'; toggle.dataset.skyKnowledgeProperty = id;
        toggle.dataset.skyKnowledgeKnown = String(!known.includes(id)); toggle.dataset.skyKnowledgeRevision = revision;
      }
    }
    state();
  }
  function renderSelectors() {
    const actors = new Map(Array.from(getGame().actors?.contents ?? []).map(actor => [actor.id, actor]));
    if (!actors.has(actorId)) actorId = actors.keys().next().value ?? '';
    if (!systems.has(systemId)) { systemId = systems.keys().next().value ?? ''; componentId = ''; }
    const components = systems.get(systemId)?.components ?? new Map();
    if (!components.has(componentId)) componentId = components.keys().next().value ?? '';
    options(selectors.actor, actors, actorId, 'NoActors'); options(selectors.system, systems, systemId, 'NoSystems');
    options(selectors.component, components, componentId, 'NoComponents'); renderRows();
  }
  async function reload() {
    if (!live() || pending) return;
    started = true; pending = true; state();
    try {
      await data.reconcileAllComponentProperties({ canWrite: live });
      if (live()) { systems = persistedSystems(getGame()); renderSelectors(); message.textContent = ''; }
    } catch (failure) { error(failure); }
    finally { pending = false; if (!disposed) state(); }
  }
  function change(event) {
    if (!Object.values(selectors).includes(event.target)) return;
    if (pending || !live()) { selectors.actor.value = actorId; selectors.system.value = systemId; selectors.component.value = componentId; return; }
    try {
      if (event.target === selectors.actor) actorId = selectors.actor.value;
      if (event.target === selectors.system) { systemId = selectors.system.value; componentId = ''; }
      if (event.target === selectors.component) componentId = selectors.component.value;
      systems = persistedSystems(getGame()); renderSelectors(); message.textContent = '';
    } catch (failure) { error(failure); }
  }
  async function click(event) {
    const button = event.target.closest?.('button');
    if (!button || !panel.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    if (pending || !live()) { state(); return; }
    if (button === refresh) { await reload(); return; }
    const propertyId = button.dataset.skyKnowledgeProperty;
    if (!propertyId || Number(button.dataset.skyKnowledgeRevision) !== revision) return;
    const origin = [actorId, systemId, componentId], originRevision = revision;
    pending = true; state(); message.textContent = text('Saving');
    try {
      await data.setPropertyKnowledge(...origin, propertyId, button.dataset.skyKnowledgeKnown === 'true', {
        canWrite: () => live() && revision === originRevision && actorId === origin[0] && systemId === origin[1] && componentId === origin[2]
      });
      if (live()) { renderRows(); message.textContent = text('Saved'); }
    } catch (failure) { error(failure); }
    finally { pending = false; if (!disposed) state(); }
  }
  const unsubscribe = subscribeSpecialSetting(() => { if (live()) { try { renderRows(); } catch (failure) { error(failure); } } });
  panel.addEventListener('change', change); panel.addEventListener('click', click); target.append(panel); void reload();
  return { element: panel, refresh: reload, start() { if (!started) void reload(); }, dispose() {
    disposed = true; revision++; unsubscribe(); panel.removeEventListener('change', change); panel.removeEventListener('click', click); panel.remove();
  } };
}
