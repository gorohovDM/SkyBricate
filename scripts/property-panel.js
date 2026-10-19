// Own DOM only. Property values are always textContent/value, never HTML.
export function mountPropertyPanel({ target, systemId, data, canWrite, text }) {
  const document = target.ownerDocument;
  const panel = document.createElement("section");
  panel.setAttribute("data-skybricate-panel", systemId);
  panel.className = "skybricate-property-panel";
  let disposed = false, pending = false, editing = null, deleting = null;
  let name, description, controls, message;
  const el = (tag, content, parent = panel) => {
    const node = document.createElement(tag);
    if (content !== undefined) node.textContent = content;
    parent.append(node);
    return node;
  };
  const button = (parent, label, action) => {
    const node = el("button", text(label), parent);
    node.type = "button";
    node.dataset.skyAction = action;
    return node;
  };
  function render(status = "") {
    if (disposed) return;
    panel.replaceChildren();
    el("h3", text("Title"));
    el("p", text("Shared"));
    message = el("p", status);
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    controls = el("fieldset");
    el("legend", text(deleting !== null ? "Delete" : editing === null ? "Create" : "Edit"), controls);
    try {
      const properties = data.getSnapshot().properties;
      for (const [id, property] of Object.entries(properties)) {
        const row = el("div", undefined, controls);
        row.dataset.propertyId = id;
        el("strong", property.name, row);
        el("p", property.description, row);
        button(row, "Edit", "edit");
        button(row, "Delete", "delete");
      }
      if (deleting !== null) {
        const property = properties[deleting];
        if (!property) throw new Error(text("Missing"));
        el("p", `${text("DeleteWarning")} «${property.name}»`, controls);
        button(controls, "ConfirmDelete", "confirm-delete");
        button(controls, "Cancel", "cancel");
      } else {
        const property = editing === null ? null : properties[editing];
        if (editing !== null && !property) throw new Error(text("Missing"));
        const nameLabel = el("label", text("Name"), controls);
        name = el("input", undefined, nameLabel);
        name.type = "text"; name.required = true; name.dataset.skyField = "name";
        name.value = property?.name ?? "";
        const descriptionLabel = el("label", text("Description"), controls);
        description = el("textarea", undefined, descriptionLabel);
        description.dataset.skyField = "description";
        description.value = property?.description ?? "";
        button(controls, "Save", "save");
        if (editing !== null) button(controls, "Cancel", "cancel");
      }
    } catch (error) {
      message.textContent = `${text("Error")} ${error.message}`;
      controls.disabled = true;
    }
    button(panel, "Refresh", "refresh");
  }
  async function onClick(event) {
    const node = event.target.closest?.("button[data-sky-action]");
    if (!node || !panel.contains(node)) return;
    event.preventDefault();
    event.stopPropagation();
    if (disposed || pending) return;
    if (!canWrite()) {
      message.textContent = text("Unavailable");
      controls.disabled = true;
      return;
    }
    const action = node.dataset.skyAction;
    if (action === "refresh" || action === "cancel") {
      editing = deleting = null; render(); return;
    }
    if (action === "edit" || action === "delete") {
      const id = node.closest("[data-property-id]").dataset.propertyId;
      editing = action === "edit" ? id : null;
      deleting = action === "delete" ? id : null;
      render(); return;
    }
    if (action !== "save" && action !== "confirm-delete") return;
    if (action === "save" && !name.value.trim()) {
      message.textContent = text("NameRequired"); name.focus(); return;
    }
    pending = true;
    controls.disabled = true;
    panel.querySelector('[data-sky-action="refresh"]').disabled = true;
    panel.setAttribute("aria-busy", "true");
    message.textContent = text("Saving");
    try {
      if (action === "confirm-delete") await data.deleteProperty(deleting);
      else {
        const values = { name: name.value.trim(), description: description.value };
        if (editing === null) await data.createProperty(values);
        else await data.updateProperty(editing, values);
      }
      if (!disposed) { editing = deleting = null; render(text("Saved")); }
    } catch (error) {
      if (!disposed) { message.textContent = `${text("Error")} ${error.message}`; controls.disabled = false; }
    } finally {
      pending = false;
      if (!disposed) {
        panel.removeAttribute("aria-busy");
        panel.querySelector('[data-sky-action="refresh"]').disabled = false;
      }
    }
  }
  panel.addEventListener("click", onClick);
  render();
  target.append(panel);
  return { element: panel, dispose() {
    disposed = true;
    panel.removeEventListener("click", onClick);
    panel.remove();
  } };
}
