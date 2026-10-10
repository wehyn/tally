"use client";

import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FolderPlus, Pencil, Plus, X } from "lucide-react";
import { CATEGORY_ICON_OPTIONS, type CategoryIconId } from "@/lib/category-icons";
import type { Category } from "@/lib/store";
import { CategoryGlyph } from "./category-glyph";

type CategoryManagerProps = {
  categories: Category[];
  onChange: (categories: Category[]) => void;
  collapsible?: boolean;
};

export function CategoryManager({ categories, onChange, collapsible = false }: CategoryManagerProps) {
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Category | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<Category["type"]>("expense");
  const [icon, setIcon] = useState<CategoryIconId>("tag");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  function startCreate() {
    setEditing(null);
    setName("");
    setType("expense");
    setIcon("tag");
    setError("");
    setNotice("");
    setOpen(true);
  }

  function startEdit(category: Category) {
    setEditing(category);
    setName(category.name);
    setType(category.type);
    setIcon(category.icon);
    setError("");
    setNotice("");
    setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const response = await fetch(editing ? `/api/categories/${editing.id}` : "/api/categories", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { name, icon } : { name, type, icon }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not save category.");
      const category = result.category as Category;
      onChange(editing
        ? categories.map((existing) => existing.id === category.id ? category : existing)
        : [...categories, category]);
      setOpen(false);
      setNotice(editing ? "Category updated." : "Category added.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save category.");
    } finally {
      setSaving(false);
    }
  }

  const managerContent = <>
    <div className="panel-heading category-manager-heading">
      <div><h2>{collapsible ? "Your categories" : "Categories"}</h2><p>Give each one a name and icon that makes your activity easy to scan.</p></div>
      <button className="button button-small category-add-button" type="button" onClick={startCreate}><Plus size={14}/> Add category</button>
    </div>
    <div className="category-groups">
      {(["expense", "income"] as const).map((categoryType) => {
        const entries = categories.filter((category) => category.type === categoryType);
        return <section className="category-group" key={categoryType} aria-label={`${categoryType} categories`}>
          <h3>{categoryType === "expense" ? "Expenses" : "Income"}<span>{entries.length}</span></h3>
          {entries.length ? <div className="category-tile-grid">{entries.map((category) => <button className="category-tile" type="button" key={category.id} onClick={() => startEdit(category)} aria-label={`Edit ${category.name} category`}>
            <span className={`category-tile-icon ${category.type}`}><CategoryGlyph icon={category.icon} size={17}/></span>
            <span className="category-tile-copy"><strong>{category.name}</strong><small>{category.type}</small></span>
            <Pencil className="category-tile-edit" size={13}/>
          </button>)}</div> : <p className="category-empty">No {categoryType} categories yet.</p>}
        </section>;
      })}
    </div>
    {notice && <p className="form-notice" role="status">{notice}</p>}
    {open && typeof document !== "undefined" && createPortal(
      <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setOpen(false); }}>
        <section className="modal-card category-modal" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
          <div className="modal-heading"><div><h2 id="category-modal-title">{editing ? "Edit category" : "Add a category"}</h2><p>{editing ? "Update its name or choose a new icon." : "Make your ledger feel like yours."}</p></div><button className="modal-close" type="button" aria-label="Close" onClick={() => setOpen(false)}><X size={16}/></button></div>
          <form onSubmit={(event) => void save(event)}>
            <label className="field-label">Category name<input autoFocus required maxLength={40} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Pet care"/></label>
            {!editing && <label className="field-label category-type-field">Type<select value={type} onChange={(event) => setType(event.target.value as Category["type"])}><option value="expense">Expense</option><option value="income">Income</option></select></label>}
            {editing && <p className="category-type-note">{type === "expense" ? "Expense" : "Income"} category · type stays fixed so your ledger remains consistent.</p>}
            <fieldset className="category-icon-fieldset"><legend>Choose an icon</legend><div className="category-icon-picker">{CATEGORY_ICON_OPTIONS.map((option) => <button className={`category-icon-option ${icon === option.id ? "selected" : ""}`} type="button" key={option.id} onClick={() => setIcon(option.id)} aria-label={`Use ${option.label} icon`} aria-pressed={icon === option.id} title={option.label}><CategoryGlyph icon={option.id} size={18}/></button>)}</div></fieldset>
            {error && <p className="error-text" role="alert">{error}</p>}
            <div className="modal-actions"><button className="button button-secondary" type="button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Add category"}</button></div>
          </form>
        </section>
      </div>,
      document.body,
    )}
  </>;

  if (collapsible) return <article className="panel category-manager-collapsible">
    <button className="category-manager-toggle" type="button" aria-expanded={categoriesOpen} aria-controls="category-manager-content" onClick={() => setCategoriesOpen((expanded) => !expanded)}>
      <FolderPlus size={16}/><span>Manage categories</span><span className="category-summary-count">{categories.length}</span><ChevronDown className={`category-manager-chevron${categoriesOpen ? " open" : ""}`} size={15} aria-hidden="true"/>
    </button>
    <div className={`category-manager-disclosure${categoriesOpen ? " open" : ""}`} id="category-manager-content" aria-hidden={!categoriesOpen} inert={!categoriesOpen}>
      <div className="category-manager-disclosure-clip"><div className="category-manager-inner">{managerContent}</div></div>
    </div>
  </article>;
  return <article className="panel category-manager-panel">{managerContent}</article>;
}
