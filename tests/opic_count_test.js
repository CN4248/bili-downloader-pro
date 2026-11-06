// 图文页右下角「N 张图」计数回归：
// 1) 新版图文相册在 MODULE_TYPE_TOP，旧代码只数 MODULE_TYPE_CONTENT；
// 2) 正文里的 /bfs/emote/ 是文字表情，不是投稿图，不能计入。
// 跑法：node tests/opic_count_test.js <script1> [script2 ...]
"use strict";
const fs = require("fs");

let failed = false;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
};

for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, "utf8");
  const start = src.indexOf("function opicCountFromModules");
  const end = src.indexOf("async function refreshOpusCount", start);
  if (start < 0 || end < 0) throw new Error(`${file}: 找不到计数函数`);
  const code = src.slice(start, end);

  // 真实接口 1262380051833290755 的形状：TOP 相册 6 张，正文只有文字/表情。
  const item = {
    modules: [
      { module_type: "MODULE_TYPE_TOP", module_top: { display: { album: { pics: [
        "a", "b", "c", "d", "e", "f",
      ].map((x) => ({ url: `https://i0.hdslb.com/bfs/new_dyn/${x}.jpg` })) } } } },
      { module_type: "MODULE_TYPE_CONTENT", module_content: { paragraphs: [
        { para_type: 1, text: { nodes: [{ word: { words: "在找我？" } }] } },
      ] } },
    ],
  };

  const doc = { querySelectorAll() { return [
    // 轮播首图 + 6 个缩略图（缩略图与首图同源，按 base URL 去重后仍是 6 张）
    { currentSrc: "https://i0.hdslb.com/bfs/new_dyn/a.jpg@1084w_1044h.webp" },
    ...["a", "b", "c", "d", "e", "f"].map((x) => ({
      currentSrc: `https://i0.hdslb.com/bfs/new_dyn/${x}.jpg@80w_80h_1c`,
    })),
    // 正文 3 个表情图：不能算进投稿图
    { currentSrc: "https://i0.hdslb.com/bfs/emote/191d9c19bc99d1308b7d2bcac79b5ce83fd4decd.png" },
    { currentSrc: "https://i0.hdslb.com/bfs/emote/495e6e3930a6fa18695cab3a63c9e85fb40e2bfc.png" },
    { currentSrc: "https://i0.hdslb.com/bfs/emote/536a89983add29caa27fe62017b9e9b7245b6290.png" },
    // 横幅/头像也不能混入
    { currentSrc: "https://i0.hdslb.com/bfs/banner/15ba085f05a9834ab1a365bdbf41618e1e5299dc.png" },
    { currentSrc: "https://i2.hdslb.com/bfs/face/5cdc23f66362f8684bf66faac1860509cad73fd7.jpg@74w" },
  ]; } };

  const mod = new Function("document", code + "\nreturn { opicCountFromModules, opicCountFromDom }; ")(doc);
  const label = file.split("/").pop();
  ok(mod.opicCountFromModules(item.modules) === 6, `${label}: TOP 相册计数=6（旧代码=0）`);
  ok(mod.opicCountFromDom(false) === 6, `${label}: DOM 轮播去重+排除表情/头像=6（旧代码=3）`);
  ok(mod.opicCountFromDom(false) !== 3, `${label}: 不再只数正文 3 个表情`);
}

process.exitCode = failed ? 1 : 0;
