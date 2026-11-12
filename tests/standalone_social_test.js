/**
 * 独立版油猴脚本：抖音 / 小红书 的解析与命名纯函数测试（不联网、不开浏览器）。
 *
 * 跑法（项目根目录）：
 *   node tests/standalone_social_test.js
 */
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "tampermonkey-standalone", "bilidl-standalone.user.js");
const src = fs.readFileSync(file, "utf8");

function block(marker, endMarker) {
  const a = src.indexOf(marker);
  if (a < 0) throw new Error(`没找到 ${marker}`);
  if (endMarker) return src.slice(a, src.indexOf(endMarker, a));
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

const naming = block("  const ILLEGAL =", "  /* ------------------------------------------------------------ 下载 */");
const social = block("  /* ------------------------------------------------- 抖音 / 小红书 */", "  function gmResolve(url) {");
const classify = block("  function classify(url) {");

const conf = {
  quality: 116, subDir: "BiliDL",
  videoTpl: "<video_title>-<video_id>-<video_episode>.<ext>",
  opusTpl: "<opus_title>-<opus_id>-<opus_order>.<ext>",
};

const BV_RE = /BV[0-9A-Za-z]{10}/;
const AV_RE = /av(\d{1,12})/i;
const api = new Function(
  "conf", "location", "GM_xmlhttpRequest", "GM_download", "BV_RE", "AV_RE", "isYouTubeUrl", "ytDetect",
  naming + "\n" + social + "\n" + classify + `
  return { classify, isSocialShort, dyInfo, xhsInfo, dyImageUrl, xhsImageUrl, xhsStreamUrl, socialRatio, renderPath, truncBytes, scriptJson, routerItem };
`)(conf, { href: "https://www.douyin.com/", hostname: "www.douyin.com" }, () => {}, () => {}, BV_RE, AV_RE, () => false, () => null);

let ok = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) ok++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

// 1) 链接识别
const dy = api.classify("https://www.douyin.com/video/7318693128016252212");
check("classify 抖音视频", dy && dy.kind === "douyin" && dy.ident === "7318693128016252212");
// 短链在面板里会先 resolveShort 展开再 classify；这里只校验能被识别成「需要展开的短链」
check("识别抖音短链", api.isSocialShort("https://v.douyin.com/iLkweNS1/"));
check("短链展开后能识别", api.classify("https://www.iesdouyin.com/share/video/7318693128016252212/").kind === "douyin");
check("识别小红书短链", api.isSocialShort("https://xhslink.com/a/abcDEF"));
const xhs = api.classify("https://www.xiaohongshu.com/explore/6aaf5cfb000000002b000454?xsec_token=ABC&xsec_source=pc_feed");
check("classify 小红书（带 token）", xhs && xhs.kind === "xhs" && xhs.token === "ABC");
check("classify B站不变", api.classify("https://www.bilibili.com/video/BV1xx411c7mD").kind === "video");

// 2) 抖音视频：去水印 play 地址 + 变量
const videoItem = {
  aweme_id: "7318693128016252212", desc: "大碗姐的说唱", create_time: 1704016079,
  author: { nickname: "大碗姐", uid: "u-dy" },
  video: { play_addr: { uri: "v0200fg10000abc", url_list: ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=x"] }, duration: 35665, cover: { url_list: ["https://p3-sign.douyinpic.com/cover.jpg"] } },
};
const vInfo = api.dyInfo(videoItem, "");
check("抖音视频 kind=video", vInfo.kind === "video");
check("抖音视频去水印 play 接口", vInfo.videoUrl.includes("/aweme/v1/play/?video_id=v0200fg10000abc"), vInfo.videoUrl.slice(0, 60));
check("抖音视频清晰度映射", /1080P|720P|480P|360P/.test(vInfo.quality), vInfo.quality);
check("抖音视频作者/时长", vInfo.author === "大碗姐" && vInfo.duration === 35);

// 3) 抖音图集：video 是实况照片占位，不能当视频
const galleryItem = {
  aweme_id: "7469411074119322899", desc: "不老实的Mortis", create_time: 1739107801,
  author: { nickname: "kamada", uid: "u-k" },
  images: [{ url_list: ["https://p26-sign.douyinpic.com/p1.webp"] }, { url_list: ["https://p26-sign.douyinpic.com/p2.webp"] }],
  video: { play_addr: { uri: "https://lf3.example/audio.mp3" } },
};
const gInfo = api.dyInfo(galleryItem, "");
check("抖音图集 kind=opus", gInfo.kind === "opus");
check("抖音图集没有视频地址", gInfo.videoUrl === "");
check("抖音图集 2 张图", gInfo.images.length === 2);

// 4) 小红书：视频 / 图文
const xhsVideoNote = {
  noteId: "6aaf5cfb000000002b000454", type: "video", title: "布偶猫", time: 1739107801000,
  user: { nickname: "猫舍", userId: "x-1" },
  imageList: [{ fileId: "notes_pre_post/1040g3k0abc" }],
  video: { media: { stream: { h264: [{ masterUrl: "http://sns-video-v2.xhscdn.com/stream/a.mp4", height: 1080 }] } } },
};
const xv = api.xhsInfo(xhsVideoNote, "6aaf5cfb000000002b000454", "");
check("小红书视频 kind=video", xv.kind === "video");
check("小红书视频 https 化", xv.videoUrl.startsWith("https://sns-video-v2.xhscdn.com/stream/a.mp4"), xv.videoUrl.slice(0, 55));
check("小红书视频不混入图片任务", xv.images.length === 0);
check("小红书时间毫秒转换", xv.pubdate === 1739107801);

const xhsImageNote = {
  noteId: "6ad6b177000000002600909d", type: "normal", desc: "求助！\n第二行", time: 1739107801,
  user: { nickname: "装修中", userId: "x-2" },
  imageList: [{ fileId: "notes_pre_post/1040g3k0p1" }, { urlDefault: "https://sns-webpic-qc.xhscdn.com/b.webp!nd_dft" }],
};
const xi = api.xhsInfo(xhsImageNote, "6ad6b177000000002600909d", "");
check("小红书图文 kind=opus", xi.kind === "opus");
check("小红书图文图片数", xi.images.length === 2);
check("小红书图文标题取首行", xi.title === "求助！", xi.title);
check("小红书原图去参数", xi.images[1] === "https://sns-webpic-qc.xhscdn.com/b.webp", xi.images[1]);

// 5) 命名：与 B站 同一套变量；超长标题按字节截断
const nameVars = { video_title: "说唱".repeat(120), video_id: "7318693128016252212", video_episode: "1" };
const longName = api.renderPath(conf.videoTpl, nameVars, "mp4");
const longBase = longName.split("/").pop();
check("超长文件名末段 ≤200 字节", Buffer.byteLength(longBase, "utf8") <= 200, String(Buffer.byteLength(longBase, "utf8")));
check("超长文件名保留扩展名", longName.endsWith(".mp4"));
const shortName = api.renderPath(conf.videoTpl, { video_title: "示例", video_id: "BV1xx411c7mD", video_episode: "1" }, "mp4");
check("普通文件名保留全部变量", shortName === "BiliDL/示例-BV1xx411c7mD-1.mp4", shortName);
const opusName = api.renderPath(conf.opusTpl, { opus_title: "图集", opus_id: "123", opus_order: 2 }, "jpg");
check("图文模板与 B站 一致", opusName === "BiliDL/图集-123-2.jpg", opusName);

console.log(`\n${ok}/${total} passed`);
process.exit(ok === total ? 0 : 1);
