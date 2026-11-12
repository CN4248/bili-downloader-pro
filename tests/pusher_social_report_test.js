#!/usr/bin/env node
/**
 * 推送版脚本：抖音 / 小红书作者主页 → 追更上报 的纯逻辑测试。
 *
 * 这两个平台的作者作品列表接口需要平台签名，服务端拿不到，只能由脚本在作者主页
 * 把作品 POST 到 /api/subs/report。这里抽源码里的 socialAuthorOf / socialWorkType
 * 两个函数做断言，不启动浏览器、不联网。
 *
 * 跑法：node tests/pusher_social_report_test.js
 */
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "tampermonkey", "bilidl-pusher.user.js"),
  "utf8",
);

// 用大括号配对从源码里切出一个函数体
function cut(name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("找不到函数 " + name);
  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("函数未闭合：" + name);
}

const body = [
  cut("socialAuthorOf"),
  cut("socialWorkType"),
  "return { socialAuthorOf, socialWorkType };",
].join("\n");
const make = new Function("location", body);
const api = make({ href: "https://www.douyin.com/video/7318693128016252212" });

let pass = 0;
let fail = 0;
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log("  FAIL " + label + "\n       got  " + JSON.stringify(got) + "\n       want " + JSON.stringify(want));
  }
}

console.log("socialAuthorOf：");
eq("抖音作者主页", api.socialAuthorOf("https://www.douyin.com/user/MS4wLjABAAAAqUVcCjQ2QkdlY3MaweIh3SQDditufbRDq1lm"),
  { source: "douyin", target: "MS4wLjABAAAAqUVcCjQ2QkdlY3MaweIh3SQDditufbRDQ1lm".replace("RDQ1lm", "RDq1lm") });
eq("抖音主页带参数", api.socialAuthorOf("https://www.douyin.com/user/MS4wLjABAAAAqUVcCjQ2QkdlY3MaweIh3SQDditufbRDq1lm?from_tab_name=main"),
  { source: "douyin", target: "MS4wLjABAAAAqUVcCjQ2QkdlY3MaweIh3SQDditufbRDq1lm" });
eq("抖音视频页不是作者页", api.socialAuthorOf("https://www.douyin.com/video/7318693128016252212"), null);
eq("小红书作者主页", api.socialAuthorOf("https://www.xiaohongshu.com/user/profile/6603db30000000000d027c6b"),
  { source: "xhs", target: "6603db30000000000d027c6b" });
eq("小红书主页带 token", api.socialAuthorOf("https://www.xiaohongshu.com/user/profile/6603db30000000000d027c6b?xsec_token=AB&xsec_source=pc_user"),
  { source: "xhs", target: "6603db30000000000d027c6b" });
eq("小红书 explore 不是作者页", api.socialAuthorOf("https://www.xiaohongshu.com/explore/6ac854d3000000001a0284ff"), null);
eq("B站空间不是这两个平台", api.socialAuthorOf("https://space.bilibili.com/2/upload"), null);

console.log("socialWorkType：");
const rootVideo = { querySelector: (sel) => (sel === "video" ? {} : null) };
const rootPlain = { querySelector: () => null };
eq("抖音 /video/ → video", api.socialWorkType({ root: rootPlain }, "douyin", "https://www.douyin.com/video/7318693128016252212"), "video");
eq("抖音 /note/ → opus", api.socialWorkType({ root: rootPlain }, "douyin", "https://www.douyin.com/note/7469411074119322899"), "opus");
eq("抖音 /slides/ → opus", api.socialWorkType({ root: rootPlain }, "douyin", "https://www.iesdouyin.com/share/slides/7450744229229235491/"), "opus");
eq("小红书卡内有 video → video", api.socialWorkType({ root: rootVideo }, "xhs", "https://www.xiaohongshu.com/explore/6ac854d3000000001a0284ff"), "video");
eq("小红书图文卡 → opus", api.socialWorkType({ root: rootPlain }, "xhs", "https://www.xiaohongshu.com/explore/6ac854d3000000001a0284ff"), "opus");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
