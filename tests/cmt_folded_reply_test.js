// 折叠楼中楼（bili-comment-reply-renderer）下载按钮回归测试。
//
// 背景：B站新版评论区把「共 N 条回复，点击查看」展开后的回复渲染成
// <bili-comment-reply-renderer>，而不是根评论的 <bili-comment-renderer>。
// 旧版 cmtMountIn/cmtScanAll 只认后者，导致折叠回复里的图片/动图没有下载按钮。
//
// 这个测试用最小的 Shadow DOM 假树跑真实的 cmtCollect + cmtMountIn + cmtScanAll：
//   1) 图片只在 reply renderer → bili-rich-text 的 shadowRoot 里，也必须能收到；
//   2) 扫描必须识别 BILI-COMMENT-REPLY-RENDERER 并在其 shadowRoot 里挂按钮；
//   3) 根评论 BILI-COMMENT-RENDERER 仍然正常，不能被改坏。
//
// 跑法（项目根目录）：
//   node tests/cmt_folded_reply_test.js tampermonkey/bilidl-pusher.user.js tampermonkey-standalone/bilidl-standalone.user.js

"use strict";

const fs = require("fs");

const files = process.argv.slice(2);
if (!files.length) files.push("tampermonkey/bilidl-pusher.user.js", "tampermonkey-standalone/bilidl-standalone.user.js");

let failed = false;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failed = true;
};

// ---------- 极简 DOM：只实现评论模块用到的 API ----------
function match(node, sel) {
  sel = String(sel).trim();
  if (!sel) return false;
  if (sel === "*") return true;
  const m = sel.match(/^([a-zA-Z0-9-]*)\[([a-zA-Z0-9_-]+)(?:([*^$]?)=["']?(.*?)["']?)?\]$/);
  if (m) {
    const tag = m[1].toLowerCase();
    const attr = m[2];
    const op = m[3];
    const want = m[4];
    if (tag && node.tagName.toLowerCase() !== tag) return false;
    const v = node.getAttribute ? node.getAttribute(attr) : null;
    if (v == null) return false;
    if (!op) return true;
    if (op === "*") return String(v).includes(want);
    if (op === "^") return String(v).startsWith(want);
    if (op === "$") return String(v).endsWith(want);
    return String(v) === want;
  }
  if (sel[0] === ".") return String(node.className || "").split(/\s+/).includes(sel.slice(1));
  if (sel[0] === "[") {
    const m2 = sel.match(/^\[class\*=["']?(.*?)["']?\]$/);
    return !!m2 && String(node.className || "").includes(m2[1]);
  }
  return node.tagName.toLowerCase() === sel.toLowerCase();
}

class FakeNode {
  constructor(tag, attrs, shadow) {
    this.nodeType = tag === "#fragment" ? 11 : 1;
    this.tagName = tag.toUpperCase();
    this.className = "";
    this.style = { backgroundImage: "" };
    this.attributes = [];
    this.children = [];
    this.parentNode = null;
    this.shadowRoot = shadow || null;
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
    this.title = "";
    this.type = "";
    if (attrs) for (const [k, v] of Object.entries(attrs)) this.setAttribute(k, v);
  }
  setAttribute(k, v) { this.attributes.push({ name: k, value: String(v) }); }
  getAttribute(k) {
    const hit = this.attributes.find((a) => a.name === k);
    return hit ? hit.value : null;
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  _desc() {
    const out = [];
    for (const c of this.children) { out.push(c, ...c._desc()); }
    return out;
  }
  querySelectorAll(sel) {
    const sels = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
    return this._desc().filter((n) => sels.some((s) => match(n, s)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getRootNode() { return this.parentNode ? this.parentNode.getRootNode() : this; }
  closest(sel) {
    const sels = String(sel).split(",").map((s) => s.trim()).filter(Boolean);
    for (let n = this; n; n = n.parentNode) if (sels.some((s) => match(n, s))) return n;
    return null;
  }
  addEventListener() {}
}

const frag = () => new FakeNode("#fragment");

function build(file) {
  const src = fs.readFileSync(file, "utf8");
  const cStart = src.indexOf("const CMT_DENY =");
  const cEnd = src.indexOf("function dynPics(node)");
  const mStart = src.indexOf("const cmtMounted = new Set();");
  const mEnd = src.indexOf("let cmtTimer = 0;");
  if (cStart < 0 || cEnd < 0 || mStart < 0 || mEnd < 0) {
    throw new Error(file + "：找不到评论收集/挂载代码块（结构变了要同步测试）");
  }
  const collectCode = src.slice(cStart, cEnd);
  const mountCode = src.slice(mStart, mEnd);
  const style = new FakeNode("style");
  style.textContent = ".bilidl-cmt{display:inline-flex}";
  const doc = {
    head: frag(),
    documentElement: frag(),
    createElement: (t) => new FakeNode(t),
    getElementById: (id) => (id === "bilidl-cmt-style" ? style : null),
    querySelector: (sel) => doc._root.querySelector(sel),
    querySelectorAll: (sel) => doc._root.querySelectorAll(sel),
  };
  doc._root = frag();
  const factory = new Function(
    "isLive", "document", "cmtIdFrom", "cmtObserve", "cmtButtonLabel", "cmtFullPics", "cmtDownload", "setTimeout",
    collectCode + "\n" + mountCode +
    "\nreturn { cmtCollect, cmtMountIn, cmtScanAll, cmtMounted };"
  );
  const api = factory(
    false,
    doc,
    () => "",
    () => {},
    (n) => "BTN:" + n,
    async (node, pics) => pics,
    () => {},
    (fn) => fn()
  );
  return { api, doc };
}

for (const file of files) {
  const label = file.split("/").pop();
  const { api, doc } = build(file);

  const root = doc._root;
  const commentsRoot = frag();
  const comments = new FakeNode("bili-comments", null, commentsRoot);
  root.appendChild(comments);
  const threadRoot = frag();
  const thread = new FakeNode("bili-comment-thread-renderer", null, threadRoot);
  commentsRoot.appendChild(thread);
  const repliesRoot = frag();
  const replies = new FakeNode("bili-comment-replies-renderer", null, repliesRoot);
  threadRoot.appendChild(replies);

  // 回复卡片：图片只存在于 bili-rich-text 的 shadowRoot，模拟真实懒加载结构
  const replyRoot = frag();
  const reply = new FakeNode("bili-comment-reply-renderer", null, replyRoot);
  const richRoot = frag();
  const rich = new FakeNode("bili-rich-text", null, richRoot);
  const img = new FakeNode("img", { src: "//i0.hdslb.com/bfs/new_dyn/folded-comment.gif" });
  richRoot.appendChild(img);
  replyRoot.appendChild(rich);
  repliesRoot.appendChild(reply);

  // 根评论：对照，不能因为改动而不挂
  const rootCmtRoot = frag();
  const rootCmt = new FakeNode("bili-comment-renderer", null, rootCmtRoot);
  const rootRichRoot = frag();
  const rootRich = new FakeNode("bili-rich-text", null, rootRichRoot);
  rootRichRoot.appendChild(new FakeNode("img", { src: "//i0.hdslb.com/bfs/comment/root-pic.jpg" }));
  rootCmtRoot.appendChild(rootRich);
  threadRoot.appendChild(rootCmt);

  // 展开回复后，整页扫描必须识别 reply renderer
  api.cmtScanAll();

  const replyBtns = replyRoot.querySelectorAll(".bilidl-cmt");
  ok(replyBtns.length === 1, `${label}: 折叠回复（bili-comment-reply-renderer）挂 1 个下载按钮（${replyBtns.length}）`);
  ok(replyBtns[0] && /BTN:1/.test(replyBtns[0].innerHTML), `${label}: 折叠回复按钮统计到 1 张图`);

  const rootBtns = rootCmtRoot.querySelectorAll(".bilidl-cmt");
  ok(rootBtns.length === 1, `${label}: 根评论按钮仍然正常（${rootBtns.length}）`);

  // 用户截图里的场景：长评论/带图评论被折叠成「展开」，图片节点不在 DOM，
  // 但 lit 组件把原始数据挂在 __data.content.pictures 上，也必须挂按钮。
  const foldedRoot = frag();
  const foldedCmt = new FakeNode("bili-comment-renderer", null, foldedRoot);
  foldedCmt.__data = {
    rpid: "323261654448",
    content: { message: "知道我喜欢了多少年吗", pictures: [{ img_src: "http://i0.hdslb.com/bfs/new_dyn/collapsed-comment.jpg" }] },
  };
  foldedRoot.appendChild(new FakeNode("bili-rich-text", null, frag())); // 模拟图片未渲染
  threadRoot.appendChild(foldedCmt);
  api.cmtMountIn(foldedCmt);
  const foldedBtns = foldedRoot.querySelectorAll(".bilidl-cmt");
  ok(foldedBtns.length === 1, `${label}: 折叠长评论（图片只在 __data）也挂 1 个按钮（${foldedBtns.length}）`);
  ok(foldedBtns[0] && /BTN:1/.test(foldedBtns[0].innerHTML), `${label}: 折叠长评论按钮统计到 1 张图`);

  // 重复扫描不能重复挂
  api.cmtScanAll();
  ok(replyRoot.querySelectorAll(".bilidl-cmt").length === 1, `${label}: 重复扫描不重复挂按钮`);

  // 折叠回复也只把图片放在 __data 里，同样要能挂按钮
  const dataReplyRoot = frag();
  const dataReply = new FakeNode("bili-comment-reply-renderer", null, dataReplyRoot);
  dataReply.__data = { rpid: "323261654449", content: { pictures: [{ img_src: "//i0.hdslb.com/bfs/new_dyn/data-reply.png" }] } };
  dataReplyRoot.appendChild(new FakeNode("bili-rich-text", null, frag()));
  repliesRoot.appendChild(dataReply);
  api.cmtMountIn(dataReply);
  const dataReplyBtns = dataReplyRoot.querySelectorAll(".bilidl-cmt");
  ok(dataReplyBtns.length === 1, `${label}: 折叠回复（图片只在 __data）也挂 1 个按钮（${dataReplyBtns.length}）`);

  // 没有图的回复不能挂空按钮
  const emptyRoot = frag();
  const empty = new FakeNode("bili-comment-reply-renderer", null, emptyRoot);
  emptyRoot.appendChild(new FakeNode("bili-rich-text", null, frag()));
  repliesRoot.appendChild(empty);
  api.cmtMountIn(empty);
  ok(emptyRoot.querySelectorAll(".bilidl-cmt").length === 0, `${label}: 无图回复不挂按钮`);
}

console.log(failed ? "cmt_folded_reply_test: FAIL" : "cmt_folded_reply_test: PASS");
process.exitCode = failed ? 1 : 0;
