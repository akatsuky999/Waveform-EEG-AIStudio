import test from "node:test";
import assert from "node:assert/strict";

import {
  buildVirtualTree, compareTreeNodes, dataFileType, isSupportedDataFile,
  normalizeProjectPath, parseProjectView, serializeProjectView,
} from "../frontend/js/core/project-tree.js";
import { dispatchProjectFileLoad } from "../frontend/js/ui/project-explorer.js";

function fakeFile(name, path) {
  return { name, webkitRelativePath: path };
}

test("recognizes every supported EEG extension case-insensitively", () => {
  assert.equal(dataFileType("recording.EDF"), "edf");
  assert.equal(dataFileType("recording.bdf"), "edf");
  assert.equal(dataFileType("window.H5"), "h5");
  assert.equal(dataFileType("window.hdf"), "h5");
  assert.equal(dataFileType("window.hdf5"), "h5");
  assert.equal(isSupportedDataFile("notes.txt"), false);
});

test("normalizes relative project paths without exposing host paths", () => {
  assert.equal(normalizeProjectPath("./patients\\p01//day1/../scan.edf"), "patients/p01/scan.edf");
  assert.equal(normalizeProjectPath("../../scan.edf"), "scan.edf");
});

test("sorts directories first and names case-insensitively", () => {
  const items = [
    { kind: "file", name: "A.edf" },
    { kind: "directory", name: "zeta" },
    { kind: "directory", name: "Alpha" },
    { kind: "file", name: "b.h5" },
  ].sort(compareTreeNodes);
  assert.deepEqual(items.map((item) => item.name), ["Alpha", "zeta", "A.edf", "b.h5"]);
});

test("builds a folder-first virtual tree from webkitdirectory files", () => {
  const files = [
    fakeFile("root.edf", "study/root.edf"),
    fakeFile("ignore.txt", "study/notes/ignore.txt"),
    fakeFile("nested.h5", "study/patient/nested.h5"),
    fakeFile(".DS_Store", "study/.DS_Store"),
  ];
  const root = buildVirtualTree(files);
  assert.equal(root.name, "study");
  assert.deepEqual(root.children.map((node) => node.name), ["notes", "patient", "root.edf"]);
  assert.equal(root.children[1].children[0].path, "patient/nested.h5");
  assert.equal(root.children[1].children[0].dataType, "h5");
  assert.equal(root.children.some((node) => node.name === ".DS_Store"), false);
});

test("serializes selection and expanded state deterministically", () => {
  const saved = serializeProjectView({
    projectName: "study",
    selectedPath: "patient\\nested.h5",
    expandedPaths: new Set(["patient/day2", "patient", "patient"]),
  });
  assert.deepEqual(saved, {
    projectName: "study",
    selectedPath: "patient/nested.h5",
    expandedPaths: ["patient", "patient/day2"],
  });
  assert.deepEqual(parseProjectView({ ...saved, expandedPaths: null }), {
    projectName: "study",
    selectedPath: "patient/nested.h5",
    expandedPaths: [],
  });
});

test("project file loading rejects a loader failure instead of reporting success", async () => {
  const file = { name: "broken.edf" };
  const node = { path: "study/broken.edf", dataType: "edf", file };
  await assert.rejects(
    dispatchProjectFileLoad(node, async () => false, { source: "project" }),
    /Could not load signal file: study\/broken\.edf/,
  );
});

test("project file loading resolves only after the loader confirms success", async () => {
  const file = { name: "recording.h5" };
  const node = { path: "study/recording.h5", dataType: "h5", file };
  let received = null;
  const loaded = await dispatchProjectFileLoad(node, async (value, context) => {
    received = { value, context };
    return true;
  }, { source: "project", preserveProcessing: true });
  assert.equal(loaded, true);
  assert.equal(received.value, file);
  assert.deepEqual(received.context, { source: "project", preserveProcessing: true });
});
