import { $, escapeHtml } from "../core/util.js";
import {
  buildVirtualTree, dataFileType, makeDirectoryNode, makeFileNode,
  normalizeProjectPath, parseProjectView, serializeProjectView, sortTreeNodes,
} from "../core/project-tree.js";
import { loadDirectoryHandle, saveDirectoryHandle } from "../core/project-persistence.js";

const VIEW_KEY = "waveform.project.view";

const ICONS = {
  chevron: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>`,
  folder: `<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2.5 4.5h5l1.4 1.7h6.6v8.3h-13z"/></svg>`,
  eeg: `<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 2.5h7l4 4v9H3z"/><path d="M10 2.5v4h4M5 11h1.7l1-2.5 1.6 5 1.1-3 1 1.5H13"/></svg>`,
  file: `<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M3 2.5h7l4 4v9H3z"/><path d="M10 2.5v4h4"/></svg>`,
};

function permissionOf(handle) {
  if (!handle?.queryPermission) return Promise.resolve("granted");
  return handle.queryPermission({ mode: "read" }).catch(() => "denied");
}

export async function dispatchProjectFileLoad(node, onLoadFile, context) {
  const file = node?.file || await node?.handle?.getFile?.();
  if (!file) throw new Error(`Could not read signal file: ${node?.path || "unknown"}`);
  if (typeof onLoadFile !== "function") throw new Error("No signal file loader is available.");
  const loaded = await onLoadFile(file, context);
  if (loaded !== true) throw new Error(`Could not load signal file: ${node?.path || file.name || "unknown"}`);
  return true;
}

export function initProjectExplorer({ onLoadFile, onProjectChange } = {}) {
  const savedView = (() => {
    try { return parseProjectView(JSON.parse(localStorage.getItem(VIEW_KEY) || "{}")); }
    catch { return parseProjectView(); }
  })();
  const state = {
    projectName: "",
    projectHandle: null,
    root: null,
    source: null,
    selectedPath: savedView.selectedPath,
    activePath: "",
    activeType: null,
    loadStatus: "idle",
    loadingPath: "",
    error: "",
    expandedPaths: new Set(savedView.expandedPaths),
    permission: "none",
  };

  const treeEl = $("projectTree");
  const emptyEl = $("explorerEmpty");
  const projectNameEl = $("projectName");
  const statusEl = $("explorerStatus");
  const reconnectBtn = $("reconnectProjectBtn");
  let fileOpenSequence = 0;
  let projectOpenSequence = 0;

  function persistView() {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(serializeProjectView(state)));
    } catch { /* localStorage can be unavailable */ }
  }

  function notifyProject() {
    onProjectChange?.(state);
    persistView();
  }

  function setStatus(message = "", type = "") {
    statusEl.textContent = message;
    statusEl.className = `explorer-status${type ? ` ${type}` : ""}`;
  }

  function setProject(root, { handle = null, source = "native", permission = "granted" } = {}) {
    state.projectName = root?.name || "";
    state.projectHandle = handle;
    state.root = root;
    state.source = source;
    state.permission = permission;
    state.selectedPath = "";
    state.activePath = "";
    state.activeType = null;
    state.loadStatus = "idle";
    state.loadingPath = "";
    state.error = "";
    state.expandedPaths.clear();
    reconnectBtn.classList.add("hidden");
    setStatus(source === "fallback" ? "Folder access lasts for this tab." : "");
    render();
    notifyProject();
  }

  async function readDirectory(node) {
    if (!node?.handle || node.children !== null) return;
    node.loading = true;
    render();
    try {
      const children = [];
      for await (const [name, handle] of node.handle.entries()) {
        if (name === ".DS_Store") continue;
        const path = normalizeProjectPath(`${node.path}/${name}`);
        if (handle.kind === "directory") children.push(makeDirectoryNode(name, path, { handle, source: "native" }));
        else children.push(makeFileNode(name, path, null, { handle, source: "native" }));
      }
      node.children = sortTreeNodes(children);
      node.error = "";
    } catch (error) {
      node.children = [];
      node.error = error?.message || "Could not read this folder.";
      if (node === state.root && state.projectHandle) {
        const permission = await permissionOf(state.projectHandle);
        if (permission !== "granted") {
          state.permission = permission;
          reconnectBtn.classList.remove("hidden");
        }
      }
      setStatus(node.error, "error");
    } finally {
      node.loading = false;
      render();
    }
  }

  function findNode(path, node = state.root) {
    const normalized = normalizeProjectPath(path);
    if (!normalized) return node;
    if (!node?.children) return null;
    for (const child of node.children) {
      if (child.path === normalized) return child;
      if (normalized.startsWith(child.path + "/")) {
        const found = findNode(normalized, child);
        if (found) return found;
      }
    }
    return null;
  }

  async function restoreExpandedPaths() {
    const paths = [...state.expandedPaths].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const path of paths) {
      const parentPath = path.split("/").slice(0, -1).join("/");
      if (parentPath) {
        const parent = findNode(parentPath);
        if (parent?.kind === "directory") await readDirectory(parent);
      }
      const node = findNode(path);
      if (node?.kind === "directory") await readDirectory(node);
    }
    render();
  }

  async function attachNativeHandle(handle, permission = "granted", restore = false, restoreView = savedView) {
    const root = makeDirectoryNode(handle.name, "", { handle, source: "native" });
    if (restore) {
      state.projectName = handle.name;
      state.projectHandle = handle;
      state.root = root;
      state.source = "native";
      state.permission = permission;
      state.selectedPath = restoreView.projectName === handle.name ? restoreView.selectedPath : "";
      state.expandedPaths = new Set(restoreView.projectName === handle.name ? restoreView.expandedPaths : []);
      state.activePath = "";
      state.activeType = null;
    } else {
      setProject(root, { handle, source: "native", permission });
    }
    reconnectBtn.classList.add("hidden");
    await readDirectory(root); // only the root's immediate children
    if (restore) await restoreExpandedPaths();
    setStatus("");
    render();
    notifyProject();
  }

  async function openFolder() {
    if (typeof window.showDirectoryPicker === "function") {
      try {
        const handle = await window.showDirectoryPicker({ mode: "read" });
        ++projectOpenSequence;
        await saveDirectoryHandle(handle);
        await attachNativeHandle(handle);
      } catch (error) {
        if (error?.name !== "AbortError") setStatus(error?.message || "Could not open folder.", "error");
      }
    } else {
      const input = $("directoryInput");
      input.value = "";
      input.click();
    }
  }

  async function reconnect() {
    if (!state.projectHandle) return openFolder();
    const sequence = ++projectOpenSequence;
    const currentView = serializeProjectView(state);
    try {
      const permission = state.projectHandle.requestPermission
        ? await state.projectHandle.requestPermission({ mode: "read" }) : "granted";
      if (sequence !== projectOpenSequence) return;
      if (permission !== "granted") return setStatus("Folder permission was not granted.", "error");
      await attachNativeHandle(state.projectHandle, permission, true, currentView);
    } catch (error) {
      setStatus(error?.message || "Could not reconnect this folder.", "error");
    }
  }

  async function toggleDirectory(node) {
    const expanded = state.expandedPaths.has(node.path);
    if (expanded) state.expandedPaths.delete(node.path);
    else {
      state.expandedPaths.add(node.path);
      await readDirectory(node);
    }
    persistView();
    render();
  }

  async function loadNode(node, { propagateError = false } = {}) {
    if (!node?.dataType) return false;
    const sequence = ++fileOpenSequence;
    state.selectedPath = node.path;
    persistView();
    render();
    try {
      if (sequence !== fileOpenSequence) return false;
      const loaded = await dispatchProjectFileLoad(node, onLoadFile, {
        source: "project",
        projectName: state.projectName,
        relativePath: node.path,
        preserveProcessing: true,
      });
      return loaded;
    } catch (error) {
      if (sequence !== fileOpenSequence) return false;
      const message = state.error || error?.message || "Could not read file.";
      setLoadState(node.path, "error", message);
      if (propagateError) throw new Error(message, { cause: error });
      return false;
    }
  }

  async function ensureNode(path) {
    const normalized = normalizeProjectPath(path);
    if (!normalized || !state.root) return null;
    let node = state.root;
    for (const segment of normalized.split("/")) {
      if (node.kind !== "directory") return null;
      await readDirectory(node);
      node = (node.children || []).find((child) => child.name === segment);
      if (!node) return null;
    }
    return node;
  }

  async function listSupportedFiles({ limit = 500 } = {}) {
    if (!state.root || state.permission !== "granted") return [];
    const results = [];
    async function walk(node) {
      if (results.length >= limit) return;
      if (node.kind === "file") {
        if (node.dataType) results.push({ path: node.path, name: node.name, type: node.dataType });
        return;
      }
      await readDirectory(node);
      for (const child of node.children || []) {
        await walk(child);
        if (results.length >= limit) break;
      }
    }
    await walk(state.root);
    return results;
  }

  async function openPath(path) {
    const node = await ensureNode(path);
    if (!node?.dataType) throw new Error(`Signal file not found in the authorized project: ${path}`);
    return loadNode(node, { propagateError: true });
  }

  function selectPath(path) {
    state.selectedPath = normalizeProjectPath(path);
    persistView();
    treeEl.querySelectorAll(".tree-row.selected").forEach((row) => row.classList.remove("selected"));
    const selected = [...treeEl.querySelectorAll(".tree-row")].find((row) => row.dataset.projectPath === state.selectedPath);
    selected?.classList.add("selected");
  }

  function rowFor(node, depth) {
    const supported = !!node.dataType;
    const row = document.createElement("div");
    row.className = "tree-item";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tree-row";
    button.dataset.projectPath = node.path;
    button.style.setProperty("--depth", depth);
    button.title = node.path || node.name;
    button.setAttribute("role", "treeitem");
    button.setAttribute("aria-label", `${node.kind === "directory" ? "Folder" : supported ? "EEG file" : "File"}: ${node.name}`);
    if (node.kind === "directory") button.setAttribute("aria-expanded", String(state.expandedPaths.has(node.path)));
    button.classList.toggle("selected", state.selectedPath === node.path);
    button.classList.toggle("active-file", state.activePath === node.path);
    button.classList.toggle("unsupported", node.kind === "file" && !supported);
    button.classList.toggle("loading", state.loadingPath === node.path && state.loadStatus === "loading");
    const expanded = node.kind === "directory" && state.expandedPaths.has(node.path);
    const chevron = node.kind === "directory"
      ? `<span class="tree-chevron${expanded ? " open" : ""}">${ICONS.chevron}</span>`
      : `<span class="tree-chevron spacer"></span>`;
    const icon = node.kind === "directory" ? ICONS.folder : supported ? ICONS.eeg : ICONS.file;
    const badge = supported ? `<span class="tree-badge">${escapeHtml(node.dataType === "h5" ? "H5" : "EDF")}</span>` : "";
    const spinner = state.loadingPath === node.path && state.loadStatus === "loading" ? `<span class="tree-spinner"></span>` : "";
    button.innerHTML = `${chevron}<span class="tree-icon">${icon}</span><span class="tree-label">${escapeHtml(node.name)}</span>${badge}${spinner}`;
    button.addEventListener("click", () => {
      selectPath(node.path);
      if (node.kind === "directory") toggleDirectory(node);
    });
    button.addEventListener("dblclick", (event) => {
      if (node.kind !== "file") return;
      event.preventDefault();
      loadNode(node);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      node.kind === "directory" ? toggleDirectory(node) : loadNode(node);
    });
    row.appendChild(button);
    if (node.kind === "directory" && expanded) {
      const group = document.createElement("div");
      group.setAttribute("role", "group");
      if (node.loading) group.innerHTML = `<div class="tree-message" style="--depth:${depth + 1}">Reading folder…</div>`;
      else if (node.error) group.innerHTML = `<div class="tree-message error" style="--depth:${depth + 1}">${escapeHtml(node.error)}</div>`;
      else if (!node.children?.length) group.innerHTML = `<div class="tree-message" style="--depth:${depth + 1}">Empty folder</div>`;
      else node.children.forEach((child) => group.appendChild(rowFor(child, depth + 1)));
      row.appendChild(group);
    }
    return row;
  }

  function render() {
    projectNameEl.textContent = state.projectName || "No folder open";
    projectNameEl.title = state.projectName || "";
    treeEl.innerHTML = "";
    const hasTree = !!state.root && state.permission === "granted";
    emptyEl.classList.toggle("hidden", hasTree);
    treeEl.classList.toggle("hidden", !hasTree);
    if (hasTree) {
      treeEl.setAttribute("aria-label", `${state.projectName} project files`);
      for (const child of state.root.children || []) treeEl.appendChild(rowFor(child, 0));
    }
  }

  async function refresh() {
    if (!state.root) return openFolder();
    if (state.source === "fallback") {
      setStatus("Choose the folder again to discover filesystem changes.");
      return;
    }
    const expanded = new Set(state.expandedPaths);
    const selected = state.selectedPath;
    state.root.children = null;
    await readDirectory(state.root);
    if (state.permission !== "granted") return;
    state.expandedPaths = expanded;
    state.selectedPath = selected;
    await restoreExpandedPaths();
    setStatus("Folder refreshed.");
    setTimeout(() => { if (statusEl.textContent === "Folder refreshed.") setStatus(""); }, 1800);
  }

  function collapseAll() {
    state.expandedPaths.clear();
    persistView();
    render();
  }

  function setLoadState(path, status, error = "") {
    state.loadStatus = status;
    state.loadingPath = status === "loading" ? normalizeProjectPath(path) : "";
    state.error = error;
    if (status === "error") setStatus(error || "Could not load file.", "error");
    else if (status === "loading") setStatus(`Loading ${path.split("/").at(-1)}…`, "loading");
    else if (status === "ready") setStatus("");
    else if (status === "idle") setStatus("");
    render();
    notifyProject();
  }

  function setActiveFile(path, type) {
    state.activePath = normalizeProjectPath(path);
    state.activeType = type || dataFileType(path);
    state.loadStatus = "ready";
    state.loadingPath = "";
    state.error = "";
    setStatus("");
    render();
    notifyProject();
  }

  function clearActiveFile() {
    state.activePath = "";
    state.activeType = null;
    state.loadingPath = "";
    state.loadStatus = "idle";
    render();
    notifyProject();
  }

  function cancelPendingFileOpen() { fileOpenSequence++; }

  $("openFolderBtn").addEventListener("click", openFolder);
  $("explorerOpenFolder").addEventListener("click", openFolder);
  $("refreshProjectBtn").addEventListener("click", refresh);
  $("collapseProjectBtn").addEventListener("click", collapseAll);
  reconnectBtn.addEventListener("click", reconnect);
  $("directoryInput").addEventListener("change", (event) => {
    const files = event.target.files;
    if (!files?.length) return;
    ++projectOpenSequence;
    const root = buildVirtualTree(files);
    setProject(root, { source: "fallback", permission: "granted" });
    event.target.value = "";
  });

  async function restore() {
    const sequence = ++projectOpenSequence;
    const handle = await loadDirectoryHandle();
    if (sequence !== projectOpenSequence) return;
    if (!handle) return render();
    const permission = await permissionOf(handle);
    if (sequence !== projectOpenSequence) return;
    state.projectName = handle.name;
    state.projectHandle = handle;
    state.root = makeDirectoryNode(handle.name, "", { handle, source: "native" });
    state.source = "native";
    state.permission = permission;
    if (permission === "granted") await attachNativeHandle(handle, permission, true);
    else {
      projectNameEl.textContent = handle.name;
      reconnectBtn.classList.remove("hidden");
      setStatus(permission === "prompt" ? "Reconnect to restore this folder." : "Folder permission is unavailable.", "error");
      render();
    }
  }

  render();
  restore();
  return {
    state, openFolder, refresh, collapseAll, setLoadState, setActiveFile,
    clearActiveFile, cancelPendingFileOpen, render, listSupportedFiles, openPath,
  };
}
