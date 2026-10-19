// This panel owns only its DOM. Native fields and drafts stay under Fabricate.
export function mountAssignmentPanel({ target, systemId, componentId, data, canWrite, text }) {
  const document = target.ownerDocument, panel = document.createElement('section');
  panel.className = 'manager-component-panel skybricate-assignment-panel';
  panel.dataset.skybricateAssignments = componentId;
  let disposed = false, pending = false, selected = new Set();
  const el = (tag, content, parent = panel) => {
    const node = document.createElement(tag); if (content !== undefined) node.textContent = content;
    parent.append(node); return node;
  };
  el('h3', text('Title'));
  el('p', text('AssignmentHint')).className = 'manager-muted';
  const controls = el('fieldset'); controls.className = 'skybricate-controls';
  el('legend', text('ComponentProperties'), controls);
  const chips = el('div', undefined, controls); chips.className = 'manager-component-tag-run';
  const save = el('button', text('SaveProperties'), controls); save.type = 'button';
  save.dataset.skyAssignmentAction = 'save'; save.className = 'manager-button is-primary';
  const refresh = el('button', text('ReloadAssignments'), controls); refresh.type = 'button';
  refresh.dataset.skyAssignmentAction = 'refresh'; refresh.className = 'manager-button';
  const message = el('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  function load() {
    chips.replaceChildren();
    const system = data.getSnapshot().systems[systemId];
    const properties = system?.properties ?? {};
    selected = new Set(system?.components[componentId] ?? []);
    if (!Object.keys(properties).length) el('p', text('AssignmentEmpty'), chips).className = 'manager-muted';
    for (const [id, property] of Object.entries(properties)) {
      const button = el('button', property.name, chips); button.type = 'button'; button.title = property.description;
      button.dataset.skyProperty = id; button.className = 'manager-chip skybricate-property-toggle';
      button.setAttribute('aria-pressed', String(selected.has(id)));
    }
  }
  async function click(event) {
    const button = event.target.closest?.('button');
    if (!button || !panel.contains(button)) return;
    event.preventDefault(); event.stopPropagation();
    if (disposed || pending) return;
    if (!canWrite()) { controls.disabled = true; message.textContent = text('AssignmentUnavailable'); return; }
    if (button.dataset.skyProperty) {
      const id = button.dataset.skyProperty;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      button.setAttribute('aria-pressed', String(selected.has(id))); message.textContent = ''; return;
    }
    if (button === refresh) {
      try { load(); message.textContent = ''; } catch (error) { message.textContent = `${text('Error')} ${error.message}`; }
      return;
    }
    if (button !== save) return;
    pending = true; controls.disabled = true; panel.setAttribute('aria-busy', 'true'); message.textContent = text('Saving');
    try {
      await data.setComponentProperties(systemId, componentId, [...selected], { canWrite: () => !disposed && canWrite() });
      if (!disposed && canWrite()) message.textContent = text('Saved');
    } catch (error) {
      if (!disposed && canWrite()) message.textContent = `${text('Error')} ${error.message}`;
    } finally {
      pending = false;
      if (!disposed) { panel.removeAttribute('aria-busy'); controls.disabled = !canWrite(); }
    }
  }
  try { load(); } catch (error) { controls.disabled = true; message.textContent = `${text('Error')} ${error.message}`; }
  panel.addEventListener('click', click);
  const tags = target.querySelector('[data-component-edit-section="tags"]');
  if (tags) tags.after(panel); else target.append(panel);
  return { element: panel, dispose() { disposed = true; panel.removeEventListener('click', click); panel.remove(); } };
}
