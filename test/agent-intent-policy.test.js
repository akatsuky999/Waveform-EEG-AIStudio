import test from "node:test";
import assert from "node:assert/strict";

import { deriveActionPolicy } from "../agent/web/intent-policy.js";

test("recognizes explicit Chinese and English side-effect requests", () => {
  assert.equal(deriveActionPolicy("请把 3.2 秒到 4.1 秒标注为发作").annotation, true);
  assert.equal(deriveActionPolicy("Mark this interval as artifact").annotation, true);
  assert.equal(deriveActionPolicy("切换到 patient02.edf").fileSwitch, true);
  assert.equal(deriveActionPolicy("Please export the result as H5 file").export, true);
});

test("negative and analysis-only instructions override side-effect words", () => {
  const annotation = deriveActionPolicy("只分析异常，不要打标签");
  assert.equal(annotation.annotation, false);
  assert.equal(deriveActionPolicy("Do not annotate or mark any event").annotation, false);
  assert.equal(deriveActionPolicy("不要切换文件，只看当前记录").fileSwitch, false);
  assert.equal(deriveActionPolicy("分析结果，不用保存文件").export, false);
});

test("ambiguous discovery requests remain read-only", () => {
  const policy = deriveActionPolicy("找出可能的发作起止时间并告诉我");
  assert.deepEqual({ annotation: policy.annotation, fileSwitch: policy.fileSwitch, export: policy.export }, {
    annotation: false, fileSwitch: false, export: false,
  });
});

test("recognizes explicit skill-authoring requests and respects opt-out", () => {
  assert.equal(deriveActionPolicy("帮我把这个流程做成一个 skill").skillWrite, true);
  assert.equal(deriveActionPolicy("创建一个发作定位的skill").skillWrite, true);
  assert.equal(deriveActionPolicy("Create a skill for our center's reporting format").skillWrite, true);
  assert.equal(deriveActionPolicy("update the seizure-localization skill").skillWrite, true);
  assert.equal(deriveActionPolicy("先别保存skill，只给我看看草稿").skillWrite, false);
  assert.equal(deriveActionPolicy("分析这个发作的形态").skillWrite, false);
});

test("skill-write authorization is independent of other side effects", () => {
  const policy = deriveActionPolicy("写一个skill");
  assert.deepEqual(
    { annotation: policy.annotation, fileSwitch: policy.fileSwitch, export: policy.export },
    { annotation: false, fileSwitch: false, export: false },
  );
});
