/**
 * Active project + category, shared by every NKD node.
 *
 * The whole feature is two tokens (`%project%`, `%category%`) that `filename_prefix`
 * already knows how to expand, plus this: one chip that says which values they carry and
 * lets you change them. Global on purpose - "what am I working on right now" is a fact
 * about the machine, not about the workflow, so a saved graph carries no project.
 *
 * `reveal` is the other half: opening the folder a file landed in. It only exists when the
 * browser and the ComfyUI server are the same box (the backend decides, not us), so the
 * button is never drawn when it would do nothing.
 */
import { app as comfyApp, api } from "./comfyRuntime";
import { ensureStyles } from "./timeline/styles";

export interface ProjectEntry { name: string; path?: string }
export interface ProjectConfig {
  active: { project: string; category: string };
  categories: string[];
  projects: ProjectEntry[];
  image_prefix: string;
}

/** A /view item - the same shape the core's `/view` endpoint takes. */
export interface FileRef { filename: string; subfolder?: string; type?: string }

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, parent?: HTMLElement,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  parent?.appendChild(node);
  return node;
};

// One fetch per session, shared by every chip. Every mutation goes through the routes
// below and replaces this wholesale, so the copy here is never stale relative to disk
// unless the JSON is edited by hand - which is what the reload entry in the menu is for.
let cache: ProjectConfig | null = null;
let inflight: Promise<ProjectConfig> | null = null;
const listeners = new Set<() => void>();

export function onProjectChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(cfg: ProjectConfig): ProjectConfig {
  cache = cfg;
  for (const fn of listeners) { try { fn(); } catch { /* one bad chip must not stop the rest */ } }
  return cfg;
}

async function post(route: string, body: unknown): Promise<ProjectConfig> {
  const res = await api.fetchApi(route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return announce(await res.json());
}

export function config(): ProjectConfig | null { return cache; }

export async function loadConfig(force = false): Promise<ProjectConfig> {
  if (cache && !force) return cache;
  if (!inflight || force) {
    inflight = api.fetchApi("/nkd/project/config")
      .then((r: Response) => r.json())
      .then(announce)
      .finally(() => { inflight = null; });
  }
  return inflight!;
}

export const setActive = (project?: string, category?: string): Promise<ProjectConfig> =>
  post("/nkd/project/active", { project, category });

// `/save`, not a POST on `/config`: a GET and a POST sharing one path share one aiohttp
// resource, and a hot reloader that re-syncs handlers by path alone will copy one over the
// other. See the note in nodes.py.
export const saveConfig = (cfg: ProjectConfig): Promise<ProjectConfig> =>
  post("/nkd/project/save", cfg);

/** `Contanimation · test`, or a placeholder until the first fetch lands. */
export function activeLabel(): string {
  if (!cache) return "…";
  return `${cache.active.project} · ${cache.active.category}`;
}

// ── Revealing a file on the server's desktop ─────────────────────────────────
// The backend answers `{available}` based on whether the request came from localhost, so
// on a LAN client or a cloud instance this resolves false and no button is ever drawn.
// Asked once; the answer cannot change without a page reload.
let availability: Promise<boolean> | null = null;

export function revealAvailable(): Promise<boolean> {
  return (availability ??= api.fetchApi("/nkd/open")
    .then((r: Response) => r.json())
    .then((j: { available?: boolean }) => !!j.available)
    .catch(() => false));
}

export async function reveal(ref: FileRef): Promise<void> {
  const q = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type ?? "output",
  });
  await api.fetchApi(`/nkd/open?${q}`);
}

// How a saved still is versioned — a machine-local "how I save" preference, so it lives in
// localStorage like the primary-node id, not in the shared project config. Default `auto`:
// the whole point of the chip menu is that a save reads as a version, not an overwrite.
export type SaveVersioning = "off" | "auto";
const LS_VERSIONING = "nkd_save_versioning";

export function saveVersioning(): SaveVersioning {
  return localStorage.getItem(LS_VERSIONING) === "off" ? "off" : "auto";
}
export function setSaveVersioning(v: SaveVersioning): void {
  localStorage.setItem(LS_VERSIONING, v);
}

/** Copy a file into the active project's folder. Returns the new /view item. */
export async function saveToProject(ref: FileRef, prefix?: string): Promise<FileRef & { path: string }> {
  const res = await api.fetchApi("/nkd/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ref, prefix, versioning: saveVersioning() }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

// ── The chip ────────────────────────────────────────────────────────────────

let openMenuEl: HTMLElement | null = null;

function closeMenu(): void {
  window.removeEventListener("pointerdown", closeMenuOnce, true);
  openMenuEl?.remove();
  openMenuEl = null;
}

/**
 * Close on a pointerdown OUTSIDE the menu.
 *
 * The target check is load-bearing and the trap is already paid for once in the timeline:
 * this listener is on `window` in the CAPTURE phase, so without it a pointerdown on a menu
 * ITEM rips the menu out of the DOM before that item's own handler runs - every option
 * silently does nothing, with no error.
 */
const closeMenuOnce = (e: Event): void => {
  if (openMenuEl && e.target instanceof Node && openMenuEl.contains(e.target)) return;
  closeMenu();
};

export type MenuItem = { label: string; on?: () => void; active?: boolean; header?: boolean };

/** Exported for the tracked-widgets chip (src/labels.ts): one dropdown idiom, one place
 *  where the close-on-pointerdown-outside trap stays paid. */
export function openMenu(x: number, y: number, items: MenuItem[]): void {
  // Here, not at the call sites: from the topbar nothing has mounted a node yet, so the
  // stylesheet may not exist. An unstyled `.nkd-tl-menu` is not "slightly off" - it has no
  // `position: fixed`, so it lands in the page flow at full window width.
  ensureStyles();
  closeMenu();
  // On <body>, not inside the node: within the graph canvas it would be clipped by the
  // node box and scaled by the canvas zoom transform.
  const menu = el("div", "nkd-tl-menu", document.body);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const it of items) {
    if (it.header) {
      const h = el("div", "nkd-proj-head", menu);
      h.textContent = it.label;
      continue;
    }
    const row = el("button", "nkd-tl-menu-item", menu);
    row.textContent = it.label;
    if (it.active) row.classList.add("on");
    row.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      it.on?.();
      closeMenu();
    });
  }
  openMenuEl = menu;
  setTimeout(() => window.addEventListener("pointerdown", closeMenuOnce, true), 0);
}

/** The project/category list. One menu, opened from the chip, the topbar and the palette. */
function openPicker(x: number, y: number): void {
  const cfg = cache;
  if (!cfg) return;
  const items: MenuItem[] = [{ label: "Project", header: true }];
  for (const p of cfg.projects) {
    items.push({
      label: p.path ? `${p.name}  →  ${p.path}` : p.name,
      active: p.name === cfg.active.project,
      on: () => void setActive(p.name, undefined),
    });
  }
  items.push({ label: "Category", header: true });
  for (const c of cfg.categories) {
    items.push({
      label: c,
      active: c === cfg.active.category,
      on: () => void setActive(undefined, c),
    });
  }
  items.push({ label: "Versioning", header: true });
  const mode = saveVersioning();
  items.push({ label: "off (counter)", active: mode === "off",
    on: () => setSaveVersioning("off") });
  items.push({ label: "auto (next version)", active: mode === "auto",
    on: () => setSaveVersioning("auto") });

  items.push({ label: " ", header: true });
  items.push({ label: "⚙ Manage projects…", on: () => openManager() });
  openMenu(x, y, items);
}

/**
 * A `Contanimation · test` button that opens the project/category picker.
 *
 * Returns a `refresh` so the caller can repaint it; it also refreshes itself whenever any
 * other chip in the page changes the selection.
 */
export function projectChip(parent: HTMLElement): { el: HTMLElement; destroy: () => void } {
  const btn = el("button", "nkd-tl-btn nkd-proj-chip", parent);
  btn.title = "Active project and category — where renders land. Shared by every NKD node.";
  const icon = el("i", "pi pi-folder", btn);
  const label = el("span", "nkd-proj-label", btn);

  const paint = () => { label.textContent = activeLabel(); };
  paint();
  void loadConfig().then(paint);
  const off = onProjectChange(paint);

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (!cache) { void loadConfig(true).then(paint); return; }
    const r = btn.getBoundingClientRect();
    openPicker(r.left, r.bottom + 4);
  });

  // Prevent the node from being dragged when the chip is grabbed.
  btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());

  return { el: btn, destroy: () => { off(); icon.remove(); } };
}

/**
 * Add/rename/remove projects and categories.
 *
 * A textarea over the raw lists rather than a row editor with buttons: the config IS two
 * lists of short strings, and `Name = folder/path` is faster to retype than it is to click
 * through. The file stays hand-editable either way - this is a convenience, not the only
 * door.
 */
function openManager(): void {
  const cfg = cache;
  if (!cfg) return;
  ensureStyles();          // same reason as `openMenu`: this can open with no node mounted
  const back = el("div", "nkd-proj-modal", document.body);
  const box = el("div", "nkd-proj-box", back);
  el("div", "nkd-proj-title", box).textContent = "NKD projects";

  el("label", "nkd-proj-lab", box).textContent =
    "Projects — one per line, `Name = folder/path` to point it somewhere else";
  const projects = el("textarea", "nkd-proj-area", box);
  projects.value = cfg.projects
    .map((p) => (p.path ? `${p.name} = ${p.path}` : p.name)).join("\n");

  el("label", "nkd-proj-lab", box).textContent = "Categories — one per line";
  const cats = el("textarea", "nkd-proj-area nkd-proj-area-sm", box);
  cats.value = cfg.categories.join("\n");

  el("label", "nkd-proj-lab", box).textContent =
    "Where a saved still goes (tokens: %project% %category% %node% %date:yyyy-MM-dd%)";
  const prefix = el("input", "nkd-proj-input", box);
  prefix.value = cfg.image_prefix;

  const row = el("div", "nkd-proj-row", box);
  const close = () => back.remove();
  const cancel = el("button", "nkd-tl-btn", row);
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", close);
  const ok = el("button", "nkd-tl-btn on", row);
  ok.textContent = "Save";
  ok.addEventListener("click", () => {
    const parsed: ProjectEntry[] = [];
    for (const line of projects.value.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const i = t.indexOf("=");
      if (i < 0) { parsed.push({ name: t }); continue; }
      const name = t.slice(0, i).trim();
      const path = t.slice(i + 1).trim();
      if (name) parsed.push(path ? { name, path } : { name });
    }
    void saveConfig({
      ...cfg,
      projects: parsed,
      categories: cats.value.split("\n").map((s) => s.trim()).filter(Boolean),
      image_prefix: prefix.value.trim() || cfg.image_prefix,
    }).then(close);
  });

  // Click the backdrop to dismiss, but not a click that started inside the box.
  back.addEventListener("pointerdown", (ev) => { if (ev.target === back) close(); });
}

/** Open the picker anchored to an element, or centred if there is nothing to anchor to. */
function openPickerAt(anchor?: Element | null): void {
  const r = anchor?.getBoundingClientRect();
  const x = r ? r.left : window.innerWidth / 2 - 90;
  const y = r ? r.bottom + 6 : 80;
  void loadConfig().then(() => openPicker(x, y));
}

/**
 * The project picker in ComfyUI's own top bar, next to the Manager.
 *
 * `actionBarButtons` is the declarative API this frontend actually has (1.48.7): the store
 * flat-maps it off every registered extension and renders a real one-click button. The
 * legacy route - building a `ComfyButton` and splicing it into `app.menu.settingsGroup`,
 * which is what ComfyUI-Manager and rgthree do - is kept working on purpose by the topbar's
 * "legacy container", but it is DOM surgery against an API the frontend calls legacy.
 *
 * The label has to track the selection, and the store's list is a Vue `computed`, so
 * REASSIGNING the array is what marks it dirty; mutating in place would leave the button
 * showing the old project. Belt and braces: if the reassign does not repaint (the extension
 * object may not be reactive on every build), the rendered label is patched directly.
 */
export function registerProjectTopbar(): void {
  const button = () => ({
    icon: "pi pi-folder",
    label: activeLabel(),
    tooltip: "Active NKD project and category — where renders land",
    onClick: (ev?: Event) => openPickerAt(ev?.currentTarget as Element | null),
  });

  const ext: any = {
    name: "NKD.Projects",
    actionBarButtons: [button()],
    commands: [{
      id: "NKD.Projects.Pick",
      label: "NKD: pick project and category",
      function: () => openPickerAt(
        document.querySelector('[data-testid="action-bar-buttons"] button')),
    }],
  };
  comfyApp.registerExtension(ext);

  onProjectChange(() => {
    ext.actionBarButtons = [button()];
    // The button carries no id of its own, so it is found by its label - the previous one,
    // which is still what the DOM says until Vue catches up.
    const host = document.querySelector('[data-testid="action-bar-buttons"]');
    for (const span of host?.querySelectorAll("button span") ?? []) {
      if (span.textContent && span.textContent.includes("·")) span.textContent = activeLabel();
    }
  });
  void loadConfig();
}

/**
 * A "reveal in the file manager" button, created only when the server can actually do it.
 *
 * `getRef` is called at click time, not now: the node's current file changes with every
 * run, and capturing it at build time would forever open the first render's folder.
 */
export function revealButton(parent: HTMLElement, getRef: () => FileRef | null): void {
  void revealAvailable().then((ok) => {
    if (!ok) return;
    const btn = el("button", "nkd-tl-btn", parent);
    btn.title = "Show in the file manager";
    el("i", "pi pi-folder-open", btn);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const ref = getRef();
      if (ref) void reveal(ref);
    });
  });
}
