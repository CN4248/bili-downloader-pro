// 图文（opus）图片提取回归测试：新版图文把相册放在 MODULE_TYPE_TOP.module_top.display.album，
// 不能再只扫 MODULE_TYPE_CONTENT.paragraphs，否则会报「图文里没有找到图片」。
//
// 跑法（项目根目录）：
//   node tests/opus_pics_test.js tampermonkey-standalone/bilidl-standalone.user.js

"use strict";

const fs = require("fs");
const file = process.argv[2] || "tampermonkey-standalone/bilidl-standalone.user.js";
const src = fs.readFileSync(file, "utf8");

let failed = false;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
};

const start = src.indexOf("function opusPics(item)");
const end = src.indexOf("function opusTitle", start);
if (start < 0 || end < 0) throw new Error("找不到 opusPics");
const opusPics = new Function(src.slice(start, end) + "\nreturn opusPics;")();

const top = {
  modules: [{
    module_type: "MODULE_TYPE_TOP",
    module_top: { display: { album: { pics: [
      { url: "http://i0.hdslb.com/bfs/new_dyn/64c24fde11655e30f28625f88aca71681860662.jpg" },
      { url: "//i0.hdslb.com/bfs/new_dyn/4d415b5ce2a136262573cdf479f81ad91860662.jpg@720w_406h_1e_1c.avif" },
      { url: "https://i0.hdslb.com/bfs/new_dyn/5e914d65e513907b3256e18d11f40de71860662.jpg" },
    ] } } },
  }],
};
const ps = opusPics(top);
ok(ps.length === 3, "MODULE_TYPE_TOP 的 album 能取到 3 张");
ok(ps[0] === "https://i0.hdslb.com/bfs/new_dyn/64c24fde11655e30f28625f88aca71681860662.jpg", "http 升 https");
ok(ps[1] === "https://i0.hdslb.com/bfs/new_dyn/4d415b5ce2a136262573cdf479f81ad91860662.jpg", "剥掉 @ 缩略参数");
ok(ps[2] === "https://i0.hdslb.com/bfs/new_dyn/5e914d65e513907b3256e18d11f40de71860662.jpg", "原样保留 https");

const content = {
  modules: [{
    module_type: "MODULE_TYPE_CONTENT",
    module_content: { paragraphs: [
      { para_type: 1, text: { nodes: [] } },
      { para_type: 2, pic: { pics: [{ url: "http://i0.hdslb.com/bfs/new_dyn/aaa.jpg" }] } },
      { para_type: 2, pic: { pics: [{ url: "https://i0.hdslb.com/bfs/new_dyn/aaa.jpg" }] } },
    ] },
  }],
};
const cs = opusPics(content);
ok(cs.length === 1 && cs[0] === "https://i0.hdslb.com/bfs/new_dyn/aaa.jpg", "旧版 CONTENT 仍可提取并按 URL 去重");

const both = { modules: [...top.modules, ...content.modules] };
ok(opusPics(both).length === 4, "TOP 与 CONTENT 同时存在时合并");

ok(opusPics({ basic: { image: "http://i0.hdslb.com/bfs/new_dyn/cover.jpg" } })[0] === "https://i0.hdslb.com/bfs/new_dyn/cover.jpg", "basic.image 兜底");

ok(opusPics({ modules: [] }).length === 0, "没图时返回空数组（由调用方报错）");

process.exitCode = failed ? 1 : 0;
