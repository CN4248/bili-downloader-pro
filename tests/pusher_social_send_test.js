// 推送版多选发送：抖音/小红书选中项必须走 body.social（带 source/ident/web_url/xsec_token，
// 服务端毫秒建任务、worker 下载前再补真实信息），B站视频仍走 body.videos（带 all_pages），两者可混选。
// 只有拆不出作品 ID 的短链才回退 body.links。
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "tampermonkey", "bilidl-pusher.user.js"), "utf8");

function extract(name) {
  const start = src.indexOf("async function " + name);
  if (start < 0) throw new Error("找不到函数 " + name);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("函数体不完整：" + name);
}

function makeSend() {
  const fnSrc = extract("sendPicked");
  const calls = [];
  const q = () => ({ textContent: "", disabled: false, style: {} });
  const factory = new Function(
    "picked", "keyOf", "q", "msg", "request", "syncCount", "location", "document", "setTimeout", "clearTimeout", "xhsTokenFromUrl",
    fnSrc + "\nreturn sendPicked;"
  );
  const picked = new Map();
  const fn = factory(
    picked,
    (k, i) => k + ":" + i,
    q,
    () => {},
    (method, url, body) => { calls.push({ method, url, body }); return Promise.resolve({ count: 1, failed: [] }); },
    () => {},
    { pathname: "/explore" },
    { title: "小红书 - 你的生活兴趣社区" },
    (f) => 0,
    () => {},
    (u) => { try { return new URL(u, "https://www.xiaohongshu.com").searchParams.get("xsec_token") || ""; } catch (e) { return ""; } }
  );
  return { fn, picked, calls };
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}

(async () => {
  // 1) 只选抖音 + 小红书
  {
    const { fn, picked, calls } = makeSend();
    picked.set("douyin:7318693128016252212", {
      kind: "douyin", ident: "7318693128016252212",
      title: "抖音视频", url: "https://www.douyin.com/video/7318693128016252212",
    });
    picked.set("xhs:6acc5dbf000000000a024ddc", {
      kind: "xhs", ident: "6acc5dbf000000000a024ddc",
      title: "小红书图文", url: "https://www.xiaohongshu.com/explore/6acc5dbf000000000a024ddc?xsec_token=ABC&xsec_source=pc_feed",
    });
    await fn();
    ok("只选社交作品时发送了一次请求", calls.length === 1, JSON.stringify(calls));
    const body = calls[0] && calls[0].body || {};
    ok("请求路径是 /api/download", calls[0] && calls[0].url === "/api/download");
    const social = body.social || [];
    ok("body.social 有两条", social.length === 2, JSON.stringify(body));
    ok("抖音项带 source/ident/web_url", social[0] && social[0].source === "douyin" && social[0].ident === "7318693128016252212" && /douyin\.com\/video\/7318693128016252212/.test(social[0].web_url));
    ok("小红书项带 xsec_token", social[1] && social[1].source === "xhs" && social[1].xsec_token === "ABC");
    ok("没有误发 videos/opus/links", !body.videos && !body.opus && !body.links);
    ok("推送后清空选择", picked.size === 0);
  }
  // 2) B站视频 + 抖音混选
  {
    const { fn, picked, calls } = makeSend();
    picked.set("video:BV1ppvFeDERi", { kind: "video", ident: "BV1ppvFeDERi", title: "大雄兔" });
    picked.set("douyin:7469411074119322899", {
      kind: "douyin", ident: "7469411074119322899",
      title: "抖音图文", url: "https://www.douyin.com/note/7469411074119322899",
    });
    await fn();
    const body = calls[0].body;
    ok("混选时 videos 带上 B站视频", Array.isArray(body.videos) && body.videos[0].bvid === "BV1ppvFeDERi" && body.videos[0].all_pages === true);
    ok("混选时 social 只含抖音", Array.isArray(body.social) && body.social.length === 1 && body.social[0].ident === "7469411074119322899");
    ok("混选不产生 opus/links", !body.opus && !body.links);
  }
  // 3) 缺 url 时仍用 ident 建任务（web_url 为空，worker 只能靠 ident 解析）
  {
    const { fn, picked, calls } = makeSend();
    picked.set("xhs:6ad1970f000000001500a8db", { kind: "xhs", ident: "6ad1970f000000001500a8db", title: "无地址" });
    await fn();
    const soc = (calls[0].body.social || [])[0] || {};
    ok("缺 url 时仍带 ident", soc.ident === "6ad1970f000000001500a8db");
    ok("缺 url 时 web_url 为空字符串", soc.web_url === "" && soc.xsec_token === "");
  }
  // 4) 请求失败时恢复选择，方便重试
  {
    const fnSrc = extract("sendPicked");
    const picked = new Map();
    const keyOf = (k, i) => k + ":" + i;
    picked.set("xhs:abc", { kind: "xhs", ident: "abc", title: "x", url: "https://www.xiaohongshu.com/explore/abc?xsec_token=1" });
    const fn = new Function(
      "picked", "keyOf", "q", "msg", "request", "syncCount", "location", "document", "setTimeout", "clearTimeout", "xhsTokenFromUrl",
      fnSrc + "\nreturn sendPicked;"
    )(
      picked, keyOf, () => ({ textContent: "", disabled: false }),
      () => {}, () => Promise.reject(new Error("network down")), () => {},
      { pathname: "/" }, { title: "x" }, (f) => 0, () => {},
      (u) => { try { return new URL(u, "https://www.xiaohongshu.com").searchParams.get("xsec_token") || ""; } catch (e) { return ""; } }
    );
    await fn();
    ok("失败后把选择放回去", picked.has("xhs:abc"));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
