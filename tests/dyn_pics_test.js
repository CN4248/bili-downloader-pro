// 直播间「TA的动态」图片下载回归测试。
//   1) 两个脚本都要匹配 live.bilibili.com，并在 live 扫描时扫主播动态；
//   2) dynPics 只取动态相册图，剥离 @720w... 缩略参数，http 升 https，去重；
//   3) 每条动态只挂一个按钮，没图不挂；
//   4) 头像/粉丝牌不会被当成动态图片（cmtNorm 继续排除 /bfs/face/）。
//
// 跑法（项目根目录）：
//   node tests/dyn_pics_test.js tampermonkey/bilidl-pusher.user.js tampermonkey-standalone/bilidl-standalone.user.js

"use strict";

const fs = require("fs");

let files = process.argv.slice(2);
if (!files.length) files = ["tampermonkey/bilidl-pusher.user.js", "tampermonkey-standalone/bilidl-standalone.user.js"];

let failed = false;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
};

function matchLine(src, name) {
  const line = src.split(/\r?\n/).find((x) => x.trim().startsWith(`const ${name} =`));
  if (!line) throw new Error(`找不到 ${name}`);
  return line.trim();
}

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");

  ok(/@match\s+https:\/\/live\.bilibili\.com\/\*/.test(src), `${file}：@match 包含直播间`);
  ok(/function dynPics\(node\)/.test(src), `${file}：存在 dynPics`);
  ok(/function dynMountIn\(node\)/.test(src), `${file}：存在 dynMountIn`);
  ok(/function dynScanAll\(\)/.test(src), `${file}：存在 dynScanAll`);
  ok(/if \(isLive\) \{ dynScanAll\(\); return; \}/.test(src), `${file}：live 扫描只扫动态`);
  ok(/data-bilidl-dyn/.test(src), `${file}：动态节点用 data-bilidl-dyn 去重`);
  ok(/cmtDownload\(node, btn, dynPics, "动态图片"\)/.test(src), `${file}：动态按钮走 dynPics 下载`);

  // ---------- 提取采集/挂载代码，用假 DOM 验证 ----------
  const start = src.indexOf("function cmtNorm(u)");
  const end = src.indexOf("function cmtBtnHTML", start);
  if (start < 0 || end < 0) throw new Error(`${file}：找不到采集代码块`);
  const code = [
    matchLine(src, "CMT_DENY"),
    matchLine(src, "CMT_USER_PIC"),
    matchLine(src, "CMT_ATTRS"),
    src.slice(start, end),
  ].join("\n");
  const { dynPics } = new Function(code + "\nreturn { dynPics };" )();

  const mkImg = (src) => ({ getAttribute: (k) => (k === "src" ? src : null), closest: () => null });
  const imgs = [
    mkImg("//i2.hdslb.com/bfs/new_dyn/a.jpg@720w_406h_1e_1c.avif"),
    mkImg("//i2.hdslb.com/bfs/new_dyn/a.jpg@264w_264h_1e_1c.avif"), // 同一张，去掉缩略参数后重复
    mkImg("http://i2.hdslb.com/bfs/new_dyn/b.png@264w_264h_1e_1c.avif"),
    mkImg(""), // 懒加载占位
    mkImg("//i2.hdslb.com/bfs/face/not-a-dyn.jpg"),
  ];
  const sources = [
    { getAttribute: (k) => (k === "srcset" ? "//i2.hdslb.com/bfs/new_dyn/c.webp 1x, //i2.hdslb.com/bfs/new_dyn/d.webp 2x" : null) },
  ];
  const scope = {
    querySelectorAll: (sel) => (/source/.test(sel) ? sources : imgs),
  };
  const node = { querySelectorAll: (sel) => scope.querySelectorAll(sel) };
  const pics = dynPics(node);
  ok(pics.length === 3, `${file}：只保留 3 张去重后的相册图（实际 ${pics.length}）`);
  ok(pics[0] === "https://i2.hdslb.com/bfs/new_dyn/a.jpg", `${file}：剥离 @720w 缩略参数`);
  ok(pics[1] === "https://i2.hdslb.com/bfs/new_dyn/b.png", `${file}：http 原图升 https`);
  ok(pics[2] === "https://i2.hdslb.com/bfs/new_dyn/c.webp", `${file}：source srcset 兜底`);
  ok(!pics.some((u) => /bfs\/face\//.test(u)), `${file}：动态图排除头像`);

  // ---------- 每条动态只挂一次 ----------
  const mStart = src.indexOf("function dynMountIn(node)");
  const mEnd = src.indexOf("function dynScanAll()", mStart);
  const mountCode = src.slice(mStart, mEnd);
  const appended = [];
  const host = { appendChild: (b) => appended.push(b) };
  const fakeDoc = {
    createElement: () => ({ className: "", innerHTML: "", title: "", disabled: false, addEventListener() {}, setAttribute() {} }),
  };
  const mount = new Function(
    "dynPics", "cmtBtnHTML", "cmtDownload", "document",
    mountCode + "\nreturn dynMountIn;"
  )(() => ["https://i2.hdslb.com/bfs/new_dyn/a.jpg"], () => "<btn>", () => {}, fakeDoc);

  const attrs = {};
  const item = {
    nodeType: 1,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    querySelector: () => host,
    appendChild: (b) => appended.push(b),
  };
  mount(item);
  ok(attrs["data-bilidl-dyn"] === "1" && appended.length === 1, `${file}：有图动态挂一个按钮`);
  mount(item);
  ok(appended.length === 1, `${file}：同一条动态不重复挂按钮`);

  const emptyAttrs = {};
  const empty = {
    nodeType: 1,
    getAttribute: (k) => (k in emptyAttrs ? emptyAttrs[k] : null),
    setAttribute: (k, v) => { emptyAttrs[k] = v; },
    querySelector: () => host,
    appendChild: (b) => appended.push(b),
  };
  const emptyMount = new Function(
    "dynPics", "cmtBtnHTML", "cmtDownload", "document",
    mountCode + "\nreturn dynMountIn;"
  )(() => [], () => "<btn>", () => {}, fakeDoc);
  emptyMount(empty);
  ok(!emptyAttrs["data-bilidl-dyn"] && appended.length === 1, `${file}：没图动态不挂按钮`);
}

process.exitCode = failed ? 1 : 0;
