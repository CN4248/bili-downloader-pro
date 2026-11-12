// 回归测试：合集（ugc_season）里每一集都是独立视频，任务里的 video_title
// 必须是「这一集自己的标题」，不能沿用解析入口那个视频的标题。
//
// 用法（项目根目录）：
//   node tests/collect_season_test.js web/app.js
//
// 做法：把 web/app.js 里的 collectDownloads() 原样抽出来，用一个假 state 跑，
// 断言产出的 payload —— 不复制业务代码，改坏了测试就会红。

"use strict";

const fs = require("fs");

const appPath = process.argv[2] || "web/app.js";
const src = fs.readFileSync(appPath, "utf8");

const MARKER = "function collectDownloads() {";
const start = src.indexOf(MARKER);
if (start < 0) throw new Error("在 " + appPath + " 里找不到 collectDownloads()，测试需要同步更新");

// 从函数体开头做括号配对，抽出完整源码
let inStr = null;
let escaped = false;
let depth = 0;
let end = -1;
const bodyStart = src.indexOf("{", start);
for (let i = bodyStart; i < src.length; i++) {
  const ch = src[i];
  if (escaped) {
    escaped = false;
    continue;
  }
  if (ch === "\\") {
    escaped = true;
    continue;
  }
  if (inStr) {
    if (ch === inStr) inStr = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    inStr = ch;
    continue;
  }
  if (ch === "{") depth++;
  else if (ch === "}") {
    depth--;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end < 0) throw new Error("collectDownloads() 括号不配对");

const fnSrc = src.slice(start, end);

// 模拟一次解析结果：入口视频 BV1 自己也在合集里（第 1 集）
const item = {
  ok: true,
  kind: "video",
  bvid: "BV1",
  title: "入口视频标题Vol.29",
  author: "UP",
  pubdate: 1700000000,
  mid: "42",
  // 真实 /api/parse 会给每个 page 带上它所在合集的信息（_parse_ref 注入）
  pages: [
    {
      index: 1,
      cid: 11,
      title: "入口视频标题Vol.29",
      season_id: "4104277",
      season_title: "碧蓝档案-角色广播剧",
      season_order: 1,
      author_uid: "42",
    },
  ],
  season: {
    id: "4104277",
    title: "碧蓝档案-角色广播剧",
    episodes: [
      { index: 1, bvid: "BV1", cid: 11, title: "入口视频标题Vol.29" },
      { index: 2, bvid: "BV2", cid: 22, title: "第二集的标题Vol.19" },
      { index: 3, bvid: "BV3", cid: 33, title: "第三集的标题Vol.26" },
    ],
  },
  _pages: new Set([1]),
  _eps: new Set([1, 2, 3]), // 点「全选合集」
};

const state = { parsed: [item] };
const collectDownloads = new Function("state", fnSrc + "; return collectDownloads;")(state);
const out = collectDownloads();

const failures = [];
if (out.videos.length !== 3) failures.push(`分集数量应为 3，实际 ${out.videos.length}`);
if (out.opus.length !== 0) failures.push(`不应产生图文任务，实际 ${out.opus.length}`);

const expected = ["入口视频标题Vol.29", "第二集的标题Vol.19", "第三集的标题Vol.26"];
out.videos.forEach((v, i) => {
  if (v.video_title !== expected[i]) {
    failures.push(`第 ${i + 1} 个任务 video_title=${JSON.stringify(v.video_title)}，期望 ${JSON.stringify(expected[i])}`);
  }
  if (v.season_title !== "碧蓝档案-角色广播剧") failures.push(`第 ${i + 1} 个任务缺 season_title`);
  if (v.season_order !== i + 1) failures.push(`第 ${i + 1} 个任务 season_order 应为 ${i + 1}`);
});
const distinct = new Set(out.videos.map((v) => v.video_title));
if (distinct.size !== 3) failures.push(`3 集应有 3 个不同标题，实际 ${distinct.size} 个`);

if (failures.length) {
  console.error("FAIL:");
  failures.forEach((f) => console.error("  - " + f));
  process.exit(1);
}
console.log("PASS：合集 3 集各自使用自己的标题：" + [...distinct].join(" / "));
