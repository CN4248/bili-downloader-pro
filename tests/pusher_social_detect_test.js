/**
 * 推送版油猴脚本：抖音 / 小红书 页面识别的纯函数测试（不联网、不开浏览器）。
 *
 * 跑法（项目根目录）：
 *   node tests/pusher_social_detect_test.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "tampermonkey", "bilidl-pusher.user.js");
const src = fs.readFileSync(file, "utf8");

function block(marker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error(`没找到 ${marker}`);
  const open = src.indexOf("{", a);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (!depth) return src.slice(a, i + 1);
    }
  }
  throw new Error(`括号不配对：${marker}`);
}

const body = block("  function socialHosts(url) {") + "\n" + block("  function socialFromUrl(href) {") + "\n" + block("  function detect() {");
let href = "";
const location = { get href() { return href; } };
const api = new Function("location", "isYouTubeUrl", "detectYouTube", body + "\nreturn { detect, socialHosts };")(location, () => false, () => ({ kind: "" }));

const cases = [
  ["https://www.douyin.com/video/7318693128016252212", "douyin"],
  ["https://www.douyin.com/note/7469411074119322899", "douyin"],
  ["https://v.douyin.com/iLkweNS1/", "douyin"],
  ["https://www.iesdouyin.com/share/slides/7450744229229235491/", "douyin"],
  ["https://www.xiaohongshu.com/explore/6aaf5cfb000000002b000454?xsec_token=ABC&xsec_source=pc_feed", "xhs"],
  ["https://www.xiaohongshu.com/discovery/item/6aaf5cfb000000002b000454", "xhs"],
  ["https://xhslink.com/a/abcDEF", "xhs"],
  ["https://www.bilibili.com/video/BV1xx411c7mD", "video"],
  ["https://www.bilibili.com/opus/88434234", "opus"],
];

let ok = 0;
for (const [url, want] of cases) {
  href = url;
  const got = api.detect();
  const pass = got.kind === want;
  if (pass) ok++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${want.padEnd(7)} -> ${got.kind.padEnd(9)} ${url}`);
}
// detect() 还要带出作品 ID：推送时靠它直建任务（不等服务端解析）
href = "https://www.douyin.com/video/7318693128016252212";
let d = api.detect();
console.log(`${d.ident === "7318693128016252212" ? "PASS" : "FAIL"}  douyin ident -> ${d.ident}`);
if (d.ident === "7318693128016252212") ok++;
href = "https://www.xiaohongshu.com/explore/6aaf5cfb000000002b000454?xsec_token=ABC&xsec_source=pc_feed";
d = api.detect();
console.log(`${d.ident === "6aaf5cfb000000002b000454" ? "PASS" : "FAIL"}  xhs ident -> ${d.ident}`);
if (d.ident === "6aaf5cfb000000002b000454") ok++;

console.log(`\n${ok}/${cases.length + 2} passed`);
process.exit(ok === cases.length + 2 ? 0 : 1);
