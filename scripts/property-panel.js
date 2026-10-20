// Own DOM only. All property/user/error strings use textContent or value.
export function mountPropertyPanel({ target, systemId, data, canWrite, text }) {
  const document = target.ownerDocument, panel = document.createElement("section");
  panel.dataset.skybricatePanel = systemId;
  panel.className = "skybricate-property-panel manager-vocabulary-panel";
  panel.setAttribute("aria-label", text("Title"));
  let disposed = false, pending = false, editing = null, deleting = null, resetRequested = false;
  let name, description, essence, controls, message, refresh;
  const el = (tag, content, parent = panel, className = "") => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    if (className) node.className = className;
    parent.append(node); return node;
  };
  const icon = (parent, className) => { const node = el("i", undefined, parent, className); node.setAttribute("aria-hidden", "true"); };
  const button = (parent, label, action, className = "manager-button", iconClass) => {
    const node = el("button", undefined, parent, className);
    node.type = "button"; node.dataset.skyAction = action;
    node.setAttribute("aria-label", text(label)); node.title = text(label);
    if (iconClass) icon(node, iconClass); else node.textContent = text(label);
    return node;
  };
  function render(status = "") {
    if (disposed) return;
    panel.replaceChildren();
    el("p", text("Scoped"), panel, "manager-vocabulary-desc manager-muted");
    message = el("p", status, panel, "manager-form-warning");
    message.setAttribute("role", "status"); message.setAttribute("aria-live", "polite");
    controls = el("fieldset", undefined, panel, "skybricate-controls");
    try {
      const properties = data.getSnapshot().systems[systemId]?.properties ?? {};
      if (editing !== null && !properties[editing]) throw new Error(text("Missing"));
      const property = editing === null ? null : properties[editing];
      const form = el("div", undefined, controls, "manager-vocabulary-form");
      const fields = el("div", undefined, form, "manager-vocabulary-form-fields");
      const nameLabel = el("label", undefined, fields, "manager-field"); el("span", text("Name"), nameLabel);
      name = el("input", undefined, nameLabel); name.type = "text"; name.required = true; name.dataset.skyField = "name";
      name.value = property?.name ?? "";
      const descriptionLabel = el("label", undefined, fields, "manager-field"); el("span", text("Description"), descriptionLabel);
      description = el("textarea", undefined, descriptionLabel); description.rows = 1; description.dataset.skyField = "description";
      description.value = property?.description ?? "";
      const essenceLabel = el('label', undefined, fields, 'manager-field'); el('span', text('Essence'), essenceLabel);
      essence = el('select', undefined, essenceLabel); essence.dataset.skyField = 'essenceId';
      const none = el('option', text('NoEssence'), essence); none.value = '';
      const essences = data.getEssences?.(systemId) ?? [];
      for (const row of essences) { const option = el('option', `${row.name} (${row.id})`, essence); option.value = row.id; }
      if (property?.essenceId && !essences.some(row => row.id === property.essenceId)) {
        const missing = el('option', `${text('MissingEssence')} (${property.essenceId})`, essence); missing.value = property.essenceId;
      }
      essence.value = property?.essenceId ?? '';
      button(fields, editing === null ? "Add" : "Save", "save", "manager-button is-primary");
      if (editing !== null) button(fields, "Cancel", "cancel");
      const searchRow = el("div", undefined, controls, "manager-vocabulary-search-row");
      const searchLabel = el("label", undefined, searchRow, "manager-search manager-vocabulary-search");
      icon(searchLabel, "fas fa-search");
      const search = el("input", undefined, searchLabel); search.type = "search"; search.disabled = true;
      search.placeholder = text("SearchUnavailable"); search.title = text("SearchUnavailable"); search.setAttribute("aria-label", text("SearchUnavailable"));
      el("span", `${text("Entries")}: ${Object.keys(properties).length}`, searchRow, "manager-chip manager-vocabulary-count");
      const list = el("div", undefined, controls, "manager-vocabulary-list");
      if (!Object.keys(properties).length) el("p", text("Empty"), list, "manager-muted");
      for (const [id, property] of Object.entries(properties)) {
        const card = el("div", undefined, list, "manager-vocabulary-card"); card.dataset.propertyId = id;
        const row = el("div", undefined, card, "manager-vocabulary-row");
        const tile = el("span", undefined, row, "manager-vocabulary-icon is-decorative"); tile.setAttribute("aria-hidden", "true"); icon(tile, "fas fa-tag");
        const main = el("div", undefined, row, "manager-vocabulary-main"); el("strong", property.name, main); main.title = property.description;
        el("span", text("UsageUnavailable"), row, "manager-chip");
        const edit = button(row, "Edit", "edit", "manager-icon-button", "fas fa-pen"); edit.setAttribute("aria-label", `${text("Edit")}: ${property.name}`);
        const remove = button(row, "Delete", "delete", "manager-icon-button is-danger", "fas fa-trash"); remove.setAttribute("aria-label", `${text("Delete")}: ${property.name}`);
        if (deleting === id) {
          const confirm = el("div", undefined, card, "manager-vocabulary-confirm");
          confirm.setAttribute("role", "group"); confirm.setAttribute("aria-label", text("ConfirmDelete"));
          icon(confirm, "fas fa-triangle-exclamation");
          el("span", `${text("DeleteWarning")} «${property.name}»`, confirm, "manager-vocabulary-confirm-copy");
          button(confirm, "Cancel", "cancel"); button(confirm, "ConfirmDelete", "confirm-delete", "manager-button is-danger");
        }
      }
    } catch (error) {
      message.textContent = `${text("Error")} ${error.message}`; controls.disabled = true;
      if (data.hasLegacyData()) {
        const reset = el("div", undefined, panel, "manager-vocabulary-form");
        el("p", text("LegacyWarning"), reset);
        if (resetRequested) {
          el("p", text("ResetWarning"), reset);
          button(reset, "Cancel", "cancel"); button(reset, "ConfirmReset", "confirm-reset", "manager-button is-danger");
        } else button(reset, "Reset", "reset", "manager-button is-danger");
      }
    }
    refresh = button(panel, "Refresh", "refresh");
  }
  async function onClick(event) {
    const node = event.target.closest?.("button[data-sky-action]");
    if (!node || !panel.contains(node)) return;
    event.preventDefault(); event.stopPropagation();
    if (disposed || pending) return;
    if (!canWrite()) { message.textContent = text("Unavailable"); controls.disabled = true; return; }
    const action = node.dataset.skyAction;
    if (action === "refresh" || action === "cancel") { editing = deleting = null; resetRequested = false; render(); return; }
    if (action === "reset") { resetRequested = true; render(); return; }
    if (action === "edit" || action === "delete") {
      const id = node.closest("[data-property-id]").dataset.propertyId;
      editing = action === "edit" ? id : null; deleting = action === "delete" ? id : null;
      render(); return;
    }
    if (!["save", "confirm-delete", "confirm-reset"].includes(action)) return;
    if (action === "confirm-reset" && !resetRequested) return;
    if (action === "save" && !name.value.trim()) { message.textContent = text("NameRequired"); name.focus(); return; }
    pending = true; controls.disabled = true; refresh.disabled = true;
    const extraButtons = [...panel.querySelectorAll("button")].filter(button => !controls.contains(button));
    for (const button of extraButtons) button.disabled = true;
    panel.setAttribute("aria-busy", "true"); message.textContent = text("Saving");
    try {
      if (action === "confirm-reset") await data.resetLegacyData();
      else if (action === "confirm-delete") await data.deleteProperty(systemId, deleting);
      else {
        const values = { name: name.value.trim(), description: description.value };
        if (essence.value || editing !== null) values.essenceId = essence.value || null;
        if (editing === null) await data.createProperty(systemId, values);
        else await data.updateProperty(systemId, editing, values);
      }
      if (!disposed) { editing = deleting = null; resetRequested = false; render(text("Saved")); }
    } catch (error) {
      if (!disposed) { message.textContent = `${text("Error")} ${error.message}`; if (action !== "confirm-reset") controls.disabled = false; }
    } finally {
      pending = false;
      if (!disposed) {
        panel.removeAttribute("aria-busy"); refresh.disabled = false;
        for (const button of extraButtons) button.disabled = false;
      }
    }
  }
  panel.addEventListener("click", onClick); render(); target.append(panel);
  return { element: panel, dispose() { disposed = true; panel.removeEventListener("click", onClick); panel.remove(); } };
}
