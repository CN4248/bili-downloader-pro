// 直播间「弹幕/聊天评论图片」功能已移除的回归测试（1.7.27 / 1.2.43）。
// 保留 live.bilibili.com 的 @match 是为了「TA的动态」图片；聊天区的采集/挂载/样式必须全部消失。
//
// 跑法（项目根目录）：
//   node tests/live_cmt_test.js tampermonkey/bilidl-pusher.user.js tampermonkey-standalone/bilidl-standalone.user.js

"use strict";

const fs = require("fs");

let files = process.argv.slice(2);
if (!files.length) files = ["tampermonkey/bilidl-pusher.user.js", "tampermonkey-standalone/bilidl-standalone.user.js"];

let failed = false;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
};

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");

  ok(/@match\s+https:\/\/live\.bilibili\.com\/\*/.test(src), `${file}：仍匹配直播间（供主播动态使用）`);
  ok(!/function cmtLivePics\(/.test(src), `${file}：已移除 cmtLivePics`);
  ok(!/function cmtLiveMountIn\(/.test(src), `${file}：已移除 cmtLiveMountIn`);
  ok(!/function cmtLiveScanAll\(/.test(src), `${file}：已移除 cmtLiveScanAll`);
  ok(!/CMT_LIVE_DENY/.test(src), `${file}：已移除直播间图片放行规则`);
  ok(!/bilidl-cmt-live/.test(src), `${file}：已移除直播聊天紧凑按钮样式`);
  ok(!/data-bilidl-cmt="1"/.test(src), `${file}：不再给聊天项打按钮标记`);
  ok(!/danmaku-item-right/.test(src), `${file}：不再扫描聊天正文区`);
  ok(!/data-image/.test(src), `${file}：不再读取聊天图片 data-image`);
  ok(!/#chat-items|chat-history-list/.test(src), `${file}：不再观察聊天列表`);
  ok(/function dynPics\(node\)/.test(src), `${file}：主播动态 dynPics 仍存在`);
  ok(/if \(isLive\) \{ dynScanAll\(\); return; \}/.test(src), `${file}：live 扫描只扫动态`);
  ok(!/if \(isLive\) return cmtLiveMountIn\(node\)/.test(src), `${file}：评论挂载不再分流直播聊天`);
}

process.exitCode = failed ? 1 : 0;
