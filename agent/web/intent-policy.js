// Per-turn side-effect authorization. These checks are intentionally
// conservative: unclear requests stay read-only and the agent can ask the user
// to make the requested mutation explicit.

const annotationPositive = [
  /(?:打|加|做|创建|新增|修改|更新|删除|移除|清除).{0,8}(?:标签|标注|标记|事件)/i,
  /(?:标注|标记|记录).{0,10}(?:时间|事件|发作|异常|区间|起止|onset|offset)/i,
  /(?:标上|记上|加上|删掉|移除掉|改掉)(?:吧|去|它|这些|这个)?\s*$/i,
  /\b(?:annotate|mark|label|tag|record|add|create|update|edit|delete|remove)\b.{0,24}\b(?:event|events|annotation|annotations|marker|markers|onset|offset|interval)\b/i,
];
const annotationNegative = [
  /(?:不要|不用|无需|别|禁止|不需要|不必).{0,14}(?:打标签|标签|标注|标记|事件|落标)/i,
  /(?:只|仅).{0,8}(?:分析|观察|检查|报告|看看)/i,
  /\b(?:do not|don't|dont|no|without|avoid)\b.{0,20}\b(?:annotat|mark|label|tag|event)/i,
];

const filePositive = [
  /(?:打开|切换|加载|换到|进入|比较|对比).{0,12}(?:文件|记录|数据|项目|样例|sample|h5|hdf|edf|bdf)/i,
  /(?:下一个|上一(?:个)?).{0,6}(?:文件|记录)/i,
  /\b(?:open|switch|load|change to|compare)\b.{0,24}\b(?:file|recording|record|dataset|sample|h5|hdf5|edf|bdf)\b/i,
];
const fileNegative = [
  /(?:不要|不用|无需|别|禁止).{0,12}(?:打开|切换|加载|换文件)/i,
  /\b(?:do not|don't|dont|without|avoid)\b.{0,16}\b(?:open|switch|load)\b/i,
];

const exportPositive = [
  /(?:导出|下载|保存|打包|生成).{0,14}(?:文件|图片|图像|数据|结果|png|zip|csv|json|h5|hdf|edf)/i,
  /(?:导出|下载|保存|打包)\s*$/i,
  /\b(?:export|download|save|write)\b.{0,24}\b(?:file|image|png|zip|csv|json|h5|hdf5|edf|data|result|artifact)\b/i,
];
const exportNegative = [
  /(?:不要|不用|无需|别|禁止|不需要).{0,12}(?:导出|下载|保存|生成文件)/i,
  /\b(?:do not|don't|dont|without|avoid)\b.{0,16}\b(?:export|download|save|write)\b/i,
];

const skillWritePositive = [
  /(?:创建|新建|写|编写|生成|做|制作|保存|更新|修改|改进|完善|沉淀|总结|整理|提炼|归纳|封装).{0,12}(?:一个|个|这个|新的)?\s*(?:skill|技能|能力包|prior|上下文包)/i,
  /(?:把|将).{0,20}(?:做成|变成|沉淀为|保存为|封装成|总结为|整理成|提炼成|归纳成).{0,6}(?:skill|技能|能力包|prior|上下文包)/i,
  /\b(?:create|write|make|build|generate|author|save|update|edit|improve|revise)\b.{0,40}\bskill\b/i,
  /\b(?:turn|capture|convert|summarize|package|distill)\b.{0,40}\b(?:into|as)\b.{0,12}\bskill\b/i,
];
const skillWriteNegative = [
  /(?:不要|不用|无需|别|禁止|不需要|先别|暂时不).{0,14}(?:创建|新建|写|生成|保存|更新|落盘|写入).{0,8}(?:skill|技能|能力包|prior|上下文包)/i,
  /(?:不保存|不落盘|不写入).{0,12}(?:skill|技能|能力包|prior|上下文包)?/i,
  /(?:只|仅).{0,8}(?:草拟|起草|给出|展示|预览).{0,8}(?:skill|技能)/i,
  /\b(?:do not|don't|dont|no|without|avoid|just draft|only draft|don't save|do not save)\b.{0,24}\bskill\b/i,
];
const skillInspectPositive = [
  /(?:查看|展示|列出|读取|检查|比较|解释|管理|启用|关闭|禁用).{0,16}(?:skill|技能|能力包|prior|上下文包)/i,
  /(?:这个|那个|某个|哪些|所有).{0,8}(?:skill|技能|能力包)/i,
  /\b(?:list|show|view|read|inspect|compare|explain|manage|enable|disable|use)\b.{0,32}\b(?:skill|skills|prior|context pack)\b/i,
];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}
function authorized(text, positive, negative) {
  return !matchesAny(text, negative) && matchesAny(text, positive);
}

export function deriveActionPolicy(userText = "") {
  const text = String(userText || "").replace(/\s+/g, " ").trim();
  return Object.freeze({
    userText: text,
    annotation: authorized(text, annotationPositive, annotationNegative),
    fileSwitch: authorized(text, filePositive, fileNegative),
    export: authorized(text, exportPositive, exportNegative),
    skillWrite: authorized(text, skillWritePositive, skillWriteNegative),
    skillInspect: authorized(text, skillInspectPositive, []),
  });
}

export function requireAction(policy, capability) {
  if (policy?.[capability]) return;
  const messages = {
    annotation: "Event changes are blocked because the user did not explicitly request annotation in this turn.",
    fileSwitch: "Opening another signal source is blocked because the user did not explicitly request a file switch in this turn.",
    export: "Downloading an artifact is blocked because the user did not explicitly request an export in this turn.",
    skillWrite: "Saving a skill is blocked because the user did not explicitly ask to create or update a skill in this turn. Draft the SKILL.md in your reply instead, or ask the user to confirm.",
  };
  throw new Error(messages[capability] || `Action is not authorized: ${capability}`);
}
