// Pure project-tree helpers shared by the browser explorer and Node tests.

export const DATA_FILE_EXTENSIONS = new Map([
  ["edf", "edf"], ["edf+", "edf"], ["bdf", "edf"],
  ["h5", "h5"], ["hdf", "h5"], ["hdf5", "h5"],
]);

export function normalizeProjectPath(path) {
  const parts = String(path || "").replaceAll("\\", "/").split("/");
  const clean = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") clean.pop();
    else clean.push(part);
  }
  return clean.join("/");
}

export function extensionOf(name) {
  const match = String(name || "").toLowerCase().match(/\.([^./]+)$/);
  return match ? match[1] : "";
}

export function dataFileType(name) {
  return DATA_FILE_EXTENSIONS.get(extensionOf(name)) || null;
}

export function isSupportedDataFile(name) {
  return dataFileType(name) !== null;
}

export function compareTreeNodes(a, b) {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
}

export function sortTreeNodes(nodes) {
  return [...nodes].sort(compareTreeNodes);
}

export function makeDirectoryNode(name, path = "", extra = {}) {
  return { kind: "directory", name, path: normalizeProjectPath(path), children: null, ...extra };
}

export function makeFileNode(name, path, file, extra = {}) {
  return {
    kind: "file",
    name,
    path: normalizeProjectPath(path),
    file,
    dataType: dataFileType(name),
    ...extra,
  };
}

/** Build a read-only virtual tree from a webkitdirectory FileList. */
export function buildVirtualTree(fileList, preferredName = "") {
  const files = Array.from(fileList || []).filter((file) => file?.name !== ".DS_Store");
  const relative = files.map((file) => normalizeProjectPath(file.webkitRelativePath || file.name));
  const firstParts = relative.map((path) => path.split("/")[0]).filter(Boolean);
  const commonRoot = firstParts.length && firstParts.every((part) => part === firstParts[0]) &&
    relative.some((path) => path.includes("/")) ? firstParts[0] : "";
  const rootName = preferredName || commonRoot || "Project";
  const root = makeDirectoryNode(rootName, "", { children: [], source: "fallback" });
  const directories = new Map([["", root]]);

  files.forEach((file, index) => {
    let path = relative[index];
    if (commonRoot && (path === commonRoot || path.startsWith(commonRoot + "/"))) {
      path = path.slice(commonRoot.length).replace(/^\//, "");
    }
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return;
    let parent = root;
    let parentPath = "";
    for (const part of parts.slice(0, -1)) {
      const dirPath = normalizeProjectPath(`${parentPath}/${part}`);
      let directory = directories.get(dirPath);
      if (!directory) {
        directory = makeDirectoryNode(part, dirPath, { children: [], source: "fallback" });
        parent.children.push(directory);
        directories.set(dirPath, directory);
      }
      parent = directory;
      parentPath = dirPath;
    }
    const name = parts.at(-1);
    parent.children.push(makeFileNode(name, normalizeProjectPath(`${parentPath}/${name}`), file, { source: "fallback" }));
  });

  for (const directory of directories.values()) directory.children = sortTreeNodes(directory.children || []);
  return root;
}

export function serializeProjectView({ projectName = "", selectedPath = "", expandedPaths = [] } = {}) {
  return {
    projectName: String(projectName || ""),
    selectedPath: normalizeProjectPath(selectedPath),
    expandedPaths: [...new Set(Array.from(expandedPaths || [], normalizeProjectPath).filter(Boolean))].sort(),
  };
}

export function parseProjectView(value) {
  if (!value || typeof value !== "object") return serializeProjectView();
  return serializeProjectView(value);
}
