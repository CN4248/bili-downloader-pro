// 评论区「9 张只挂 8 张」回归测试（1.7.29 / 1.2.46）。
//
// 背景：B站 九宫格最多铺 8 张，第 9 张折进「+1」遮罩，DOM 里没有这张图。
// 按钮数量要跟评论接口的 content.pictures 对齐，这里覆盖三个真实踩过的坑：
//   1) 楼中楼（二级评论）的图以前只并进父评论的 key，子评论自己查不到 → 永远 8 张；
//   2) 接口返回 http://i0.hdslb.com/...，DOM 是 https，URL 反查以前永远匹配不上；
//   3) 只扫了前 3 页评论，滚动后加载的评论不在 map 里 → 需要按 rpid 单独补查评论串。
//
// 跑法（项目根目录）：
//   node tests/cmt_pics_count_test.js tampermonkey/bilidl-pusher.user.js tampermonkey-standalone/bilidl-standalone.user.js

"use strict";

const fs = require("fs");

const files = process.argv.slice(2);
if (!files.length) {
  files.push("tampermonkey/bilidl-pusher.user.js", "tampermonkey-standalone/bilidl-standalone.user.js");
}

let failed = false;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
};

const pic = (name, size) => ({ img_src: `http://i0.hdslb.com/bfs/new_dyn/${name}.jpg${size ? "@" + size : ""}` });
const domPic = (name) => `https://i0.hdslb.com/bfs/new_dyn/${name}.jpg`;
const cmt = (rpid, pics, replies) => ({
  rpid_str: String(rpid),
  member: { uname: "某用户" },
  content: { pictures: pics },
  replies: replies || [],
});

function build(file, opts) {
  const src = fs.readFileSync(file, "utf8");
  const normStart = src.indexOf("const CMT_DENY =");
  const normEnd = src.indexOf("// 一张图可能有多个属性");
  const coreStart = src.indexOf("let cmtBvid =");
  const coreEnd = src.indexOf("function cmtButtonLabel");
  if (normStart < 0 || normEnd < 0 || coreStart < 0 || coreEnd < 0) {
    throw new Error(`${file}：找不到评论计数代码块（结构变了要同步测试）`);
  }
  const normCode = src.slice(normStart, normEnd);
  const coreCode = src.slice(coreStart, coreEnd);

  const state = { calls: [], threads: 0, opts };
  const fetchMock = async (url) => {
    state.calls.push(String(url));
    if (String(url).includes("/x/v2/reply/reply")) {
      state.threads++;
      return { json: async () => opts.thread(String(url), state.threads) };
    }
    if (String(url).includes("/x/v2/reply?")) {
      const pn = Number((String(url).match(/[?&]pn=(\d+)/) || [])[1] || 1);
      return { json: async () => opts.pages[pn - 1] || { data: { replies: [] } } };
    }
    return { json: async () => ({}) };
  };
  const factory = new Function(
    "isLive", "liveRoomId", "location", "window", "fetch", "console", "setTimeout", "cmtIdFrom",
    normCode + "\n" + coreCode + "\nreturn { cmtFullPics, cmtPicsByRpid };"
  );
  const api = factory(
    false,
    "",
    { href: "https://www.bilibili.com/video/BV1xx411c7mD", pathname: "/video/BV1xx411c7mD" },
    { __INITIAL_STATE__: { aid: 1001 } },
    fetchMock,
    { warn() {} },
    (fn) => fn(),
    opts.idOf
  );
  return { api, state };
}

(async () => {
  for (const file of files) {
    const label = file.split("/").pop();

    // ---------- 1) 楼中楼：9 张图，DOM 只铺得下 8 张 ----------
    {
      const subPics = Array.from({ length: 9 }, (_, i) => pic("sub" + (i + 1), "800w"));
      const sub = cmt("222222222222", subPics);
      const root = cmt("111111111111", [pic("root1")], [sub]);
      const { api } = build(file, {
        pages: [{ data: { replies: [root] } }],
        thread: () => ({ data: {} }),
        idOf: () => "222222222222",
      });
      const dom = Array.from({ length: 8 }, (_, i) => domPic("sub" + (i + 1)));
      const got = await api.cmtFullPics({}, dom);
      ok(got.length === 9, `${label}: 楼中楼 9 张（DOM 8）→ 按钮 ${got.length} 张`);
      ok(got.includes(domPic("sub9")), `${label}: 楼中楼补回「+1」里的第 9 张`);
      ok(got[0] === dom[0] && got[7] === dom[7], `${label}: 前 8 张保持 DOM 顺序`);
    }

    // ---------- 2) 接口 http:// + URL 反查 ----------
    {
      const pics = Array.from({ length: 9 }, (_, i) => pic("root" + (i + 1)));
      const root = cmt("333333333333", pics);
      const { api } = build(file, {
        pages: [{ data: { replies: [root] } }],
        thread: () => ({ data: {} }),          // 没有评论串可查，只能靠 URL 反查
        idOf: () => "9999999999",              // 故意拿错 rpid（模拟 2^53 掉精度）
      });
      const dom = Array.from({ length: 8 }, (_, i) => domPic("root" + (i + 1)));
      const got = await api.cmtFullPics({}, dom);
      ok(got.length === 9, `${label}: http→https 规范化后 URL 反查成功（${got.length} 张）`);
    }

    // ---------- 3) 前 3 页之外：按 rpid 补查评论串 ----------
    {
      const pics = Array.from({ length: 9 }, (_, i) => pic("far" + (i + 1)));
      const { api, state } = build(file, {
        pages: [{ data: { replies: [] } }],    // 首屏列表里没有这条评论
        thread: (url) => {
          ok(url.includes("root=444444444444"), `${label}: 评论串按 rpid 查询`);
          return { data: { root: cmt("444444444444", pics) } };
        },
        idOf: () => "444444444444",
      });
      const dom = Array.from({ length: 8 }, (_, i) => domPic("far" + (i + 1)));
      const got = await api.cmtFullPics({}, dom);
      ok(got.length === 9, `${label}: 前 3 页之外也能补成 9 张（${got.length}）`);
      ok(state.threads === 1, `${label}: 只多请求 1 次评论串（${state.threads}）`);
    }

    // ---------- 4) 普通 3 张图：不打扰接口 ----------
    {
      const pics = [pic("a"), pic("b"), pic("c")];
      const root = cmt("555555555555", pics);
      const { api, state } = build(file, {
        pages: [{ data: { replies: [root] } }],
        thread: () => ({ data: {} }),
        idOf: () => "555555555555",
      });
      const dom = ["a", "b", "c"].map(domPic);
      const got = await api.cmtFullPics({}, dom);
      ok(got.length === 3 && state.threads === 0, `${label}: 3 张图不触发额外请求（${got.length} 张 / ${state.threads} 次）`);
    }
  }

  console.log(failed ? "cmt_pics_count_test: FAIL" : "cmt_pics_count_test: PASS");
  process.exitCode = failed ? 1 : 0;
})();
