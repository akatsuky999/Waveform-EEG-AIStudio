import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("launchers contain no developer-machine Python path", () => {
  const launchers = `${read("run.sh")}\n${read(".claude/launch.json")}`;
  assert.equal(launchers.includes("anaconda3/envs/pytorch"), false);
  assert.equal(/"runtimeExecutable"\s*:\s*"\//.test(launchers), false);
  assert.match(launchers, /uv/);
  assert.match(launchers, /--frozen/);
});

test("runtime dependencies and Python are explicitly pinned", () => {
  assert.equal(read(".python-version").trim(), "3.11.15");
  const requirements = read("requirements.txt")
    .split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  assert.equal(requirements.length, 8);
  requirements.forEach((requirement) => assert.match(requirement, /^[A-Za-z0-9_-]+==[^=]+$/));
  const project = read("pyproject.toml");
  requirements.forEach((requirement) => assert.equal(project.includes(`"${requirement}"`), true, requirement));
  assert.match(project, /requires-python = "==3\.11\.\*"/);
});
