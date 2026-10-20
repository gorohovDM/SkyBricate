import { persistedSystems } from './assignment-contract.js';
import { specialPropertiesEnabled, subscribeData, subscribeSpecialSetting } from './data-store.js';

// This projection is the ONLY input to the DOM and search. Unknown assignments
// carry neither catalog text nor property IDs beyond this boundary.
export function playerRows(snapshot, systemId, components, actorId, showSpecial) {
  const system = snapshot.systems[systemId];
  return [...components.values()].map(component => {
    const known = snapshot.knowledge[actorId]?.[systemId]?.[component.id] ?? [];
    const project = ids => ids.map(id => known.includes(id)
      ? { name: system.properties[id].name, description: system.properties[id].description }
      : null);
    return { name: component.name || component.id,
      ordinary: project(system?.components[component.id] ?? []),
      special: project(showSpecial ? system?.specialComponents[component.id] ?? [] : []) };
  });
}

export function mountPlayerPanel({ target, context, getGame, data, hooks, text, compatible = () => true }) {
  const document = target.ownerDocument, panel = document.createElement('section');
  panel.className = 'skybricate-player-panel';
  let disposed = false, systemId = '', rows = [];
  const el = (tag, label, parent = panel) => {
    const node = document.createElement(tag);
    if (label !== undefined) node.textContent = label;
    parent.append(node); return node;
  };
  el('h2', text('Title'));
  el('p', text('Hint'));
  const system = el('select', undefined, el('label', text('System')));
  const search = el('input', undefined, el('label', text('Search'))); search.type = 'search';
  const refresh = el('button', text('Refresh')); refresh.type = 'button';
  const status = el('p', ''); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const content = el('div');
  function render() {
    content.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const matches = rows.filter(row => [row.name, ...[...row.ordinary, ...row.special]
      .filter(Boolean).flatMap(property => [property.name, property.description])]
      .some(value => value.toLocaleLowerCase().includes(query)));
    if (!matches.length && rows.length) el('p', text('NoMatches'), content);
    for (const row of matches) {
      const card = el('article', undefined, content); el('h3', row.name, card);
      if (!row.ordinary.length && !row.special.length) el('p', text('NoProperties'), card);
      for (const [label, properties] of [['Ordinary', row.ordinary], ['Special', row.special]]) {
        if (!properties.length) continue;
        el('h4', text(label), card);
        const list = el('ul', undefined, card);
        for (const property of properties) {
          const slot = el('li', undefined, list);
          if (property) { el('strong', property.name, slot); if (property.description) el('p', property.description, slot); }
          else el('span', text('Unknown'), slot);
        }
      }
    }
  }
  function reload() {
    if (disposed) return;
    // Clear first, including on malformed data or lost document permissions.
    rows = []; content.replaceChildren(); system.replaceChildren(); status.textContent = '';
    try {
      const game = getGame();
      if (!compatible()) throw Error('Unavailable');
      const systems = persistedSystems(game);
      if (!systems.has(systemId)) systemId = systems.keys().next().value ?? '';
      for (const row of systems.values()) el('option', `${row.name || row.id} [${row.id}]`, system).value = row.id;
      system.value = systemId;
      const actor = context.actorId ? game.actors?.get(context.actorId) : null;
      // Match stock isGatheringActorSelectableByUser (the shared actor bar).
      if (!actor || !(game.user?.isGM || actor.isOwner === true || actor.testUserPermission?.(game.user, 'OWNER') === true)) {
        status.textContent = text('NoActor'); return;
      }
      if (!systemId) { status.textContent = text('NoSystems'); return; }
      rows = playerRows(data.getSnapshot(), systemId, systems.get(systemId).components,
        context.actorId, specialPropertiesEnabled(game));
      if (!rows.length) status.textContent = text('NoComponents');
      render();
    } catch { status.textContent = text('Unavailable'); }
  }
  const changeSystem = () => { systemId = system.value; search.value = ''; reload(); };
  const settingChanged = setting => { if (setting?.key === 'fabricate.craftingSystems') reload(); };
  const actorChanged = actor => { if (actor?.id === context.actorId) reload(); };
  const userChanged = user => { if (user?.id === getGame().user?.id) reload(); };
  const listeners = [['updateSetting', settingChanged], ['updateActor', actorChanged], ['deleteActor', actorChanged], ['updateUser', userChanged]];
  const unsubscribeData = subscribeData(reload), unsubscribeSpecial = subscribeSpecialSetting(reload);
  for (const [name, listener] of listeners) hooks.on(name, listener);
  system.addEventListener('change', changeSystem); search.addEventListener('input', render); refresh.addEventListener('click', reload);
  target.append(panel); reload();
  return { refresh: reload, dispose() {
    if (disposed) return; disposed = true; rows = [];
    unsubscribeData(); unsubscribeSpecial();
    for (const [name, listener] of listeners) hooks.off(name, listener);
    system.removeEventListener('change', changeSystem); search.removeEventListener('input', render); refresh.removeEventListener('click', reload);
    panel.remove();
  } };
}
