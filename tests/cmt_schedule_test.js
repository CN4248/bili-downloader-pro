// 评论区按钮「出现太慢」的回归测试：
//   1) 调度必须是节流（不被持续 DOM 变化饿死），2 秒内至少扫几次；
//   2) cmtMountIn 必须「先确认有图，再记 mounted」，否则图片懒加载出来也不会再挂按钮。
//
// 跑法（项目根目录）：
//   node tests/cmt_schedule_test.js tampermonkey/bilidl-pusher.user.js tampermonkey-standalone/bilidl-standalone.user.js

"use strict";

const fs = require("fs");

const files = process.argv.slice(2);
if (!files.length) files.push("tampermonkey/bilidl-pusher.user.js");

let failed = false;

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");

  // ---------- 1) 调度节流 ----------
  const start = src.indexOf("let cmtTimer = 0;");
  const end = src.indexOf("function cmtInjectCss()", start);
  if (start < 0 || end < 0) throw new Error(file + "：找不到 cmtSchedule 代码块");
  const block = src.slice(start, end);

  let scans = 0;
  class FakeMO {
    observe() {}
    disconnect() {}
  }
  const factory = new Function(
    "cmtScanAll",
    "MutationObserver",
    block + "\nreturn { cmtSchedule };"
  );
  const { cmtSchedule } = factory(() => { scans++; }, FakeMO);

  // 模拟 B站 页面持续 DOM 变化：每 50ms 触发一次 schedule，持续 2 秒
  const timer = setInterval(() => cmtSchedule(), 50);
  setTimeout(() => {
    clearInterval(timer);
    const n = scans;
    const ok = n >= 3;
    console.log(`${file}：持续变化 2s 内扫描 ${n} 次 → ${ok ? "PASS" : "FAIL"}`);
    if (!ok) failed = true;

    // ---------- 2) 先有图再记 mounted ----------
    const mStart = src.indexOf("function cmtMountIn(node)");
    const mEnd = src.indexOf("function cmtScanAll()", mStart);
    const body = src.slice(mStart, mEnd);
    const picsAt = body.indexOf("const pics = cmtCollect(node)");
    const addAt = body.indexOf("cmtMounted.add(key)");
    const orderOk = picsAt >= 0 && addAt > picsAt;
    console.log(`${file}：先确认图片再记 mounted → ${orderOk ? "PASS" : "FAIL"}`);
    if (!orderOk) failed = true;

    process.exitCode = failed ? 1 : 0;
  }, 2000);
}
