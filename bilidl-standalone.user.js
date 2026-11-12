// ==UserScript==
// @name         BiliDL 独立版 · 页面内多选下载
// @namespace    https://github.com/bilidl/standalone
// @version      1.9.1
// @description  不依赖电脑端服务：在 B站 / 抖音 / 小红书 / YouTube 页面里直接解析、下载视频与图文；B站作品页、抖音主页/推荐/搜索、小红书发现页/用户主页等列表均可勾选多选，批量下载。自带设置小窗（登录 / 下载目录 / 重命名 / 清晰度）。
// @author       BiliDL
// @match        https://space.bilibili.com/*
// @match        https://www.bilibili.com/*
// @match        https://m.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://b23.tv/*
// @match        https://live.bilibili.com/*
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://youtu.be/*
// @match        https://www.douyin.com/*
// @match        https://v.douyin.com/*
// @match        https://www.iesdouyin.com/*
// @match        https://www.xiaohongshu.com/*
// @match        https://*.rednote.com/*
// @match        https://xhslink.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @connect      bilibili.com
// @connect      hdslb.com
// @connect      bilivideo.com
// @connect      biliapi.net
// @connect      b23.tv
// @connect      youtube.com
// @connect      www.youtube.com
// @connect      youtu.be
// @connect      googlevideo.com
// @connect      ytimg.com
// @connect      douyin.com
// @connect      iesdouyin.com
// @connect      douyinpic.com
// @connect      douyinvod.com
// @connect      xiaohongshu.com
// @connect      rednote.com
// @connect      xhscdn.com
// @connect      xhslink.com
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  /* ---------------------------------------------------------------- 设置 */

  const APP = "bilidl_sa_";
  const QUALITY = [
    ["8K", 127], ["4K", 120], ["1080P60", 116], ["1080P+", 112], ["1080P", 80],
    ["720P60", 74], ["720P", 64], ["480P", 32], ["360P", 16],
  ];
  const QN_NAME = { 127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P" };

  const DEFAULTS = {
    quality: 116,
    exAudio: false,
    exVideoMute: false,
    exSub: false,
    exDm: false,
    exCover: false,
    exNfo: false,
    subDir: "BiliDL",
    videoTpl: "<video_title>-<video_id>-<video_episode>.<ext>",
    opusTpl: "<opus_title>-<opus_id>-<opus_order>.<ext>",
    readlistTpl: "<readlist_title>/<readlist_order>-<opus_title>/<opus_id>-<opus_order>.<ext>",
    gmSave: false,   // 图文/封面等小文件是否用 GM_download 保存（支持子目录，但个别环境会弹新标签）
    interval: 900,
    concurrency: 2,
    apiDelay: 700,
    lastOpusDir: "",
    lastVideoDir: "",
    selMode: false,
  };

  // 双后端：优先 GM 存储，同时写一份 localStorage。
  // 某些浏览器的 TM 沙箱里 GM_setValue 会静默失败，只写 GM 会导致「换页面就丢设置」。
  const store = {
    key(k) { return APP + k; },
    get(k, d) {
      let v;
      try { v = GM_getValue(this.key(k), undefined); } catch (e) { v = undefined; }
      if (v === undefined) {
        try { const raw = localStorage.getItem(this.key(k)); if (raw !== null) v = JSON.parse(raw); } catch (e) {}
      }
      return v === undefined || v === null ? d : v;
    },
    set(k, v) {
      let ok = false;
      try { GM_setValue(this.key(k), v); ok = true; } catch (e) {}
      try { localStorage.setItem(this.key(k), JSON.stringify(v)); ok = true; } catch (e) {}
      if (!ok) console.warn("[BiliDL] 设置保存失败", k);
      return ok;
    },
    reset(keys) { keys.forEach((k) => this.set(k, DEFAULTS[k])); },
  };

  const conf = {};
  for (const k in DEFAULTS) conf[k] = store.get(k, DEFAULTS[k]);

  function saveConf(patch) {
    Object.assign(conf, patch || {});
    for (const k in (patch || {})) store.set(k, conf[k]);
  }

  /* ------------------------------------------------------------ 小工具 */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rand = (a, b) => a + Math.random() * (b - a);
  const fmtSize = (n) => {
    if (!n || n < 0) return "?";
    const u = ["B", "KB", "MB", "GB"]; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + u[i];
  };

  function toast(msg, ms) {
    let el = $("#bilidl-sa-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "bilidl-sa-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("on");
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove("on"), ms || 2600);
  }

  /* --------------------------------------------------------- B 站 API */

  const RISK = new Set([-352, -412, -403, -509, -799]);
  let coolUntil = 0;
  let lastApi = 0;

  async function apiGet(url, opts) {
    opts = opts || {};
    const now = Date.now();
    if (now < coolUntil) await sleep(coolUntil - now);
    const wait = lastApi + (conf.apiDelay || 700) - Date.now();
    if (wait > 0) await sleep(wait + rand(0, 250));
    lastApi = Date.now();
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      let r, j;
      try {
        r = await fetch(url, { credentials: "include", headers: { Accept: "application/json, text/plain, */*" } });
      } catch (e) {
        lastErr = new Error("网络错误：" + e.message);
        await sleep(1500 * (i + 1));
        continue;
      }
      if (r.status === 412 || r.status === 429) {
        coolUntil = Date.now() + 20000 * (i + 1);
        lastErr = new Error("触发风控（HTTP " + r.status + "），已自动冷却");
        continue;
      }
      try { j = await r.json(); } catch (e) { lastErr = new Error("返回不是 JSON"); continue; }
      if (j.code === 0) return j.data === undefined ? {} : j.data;
      if (RISK.has(j.code)) { coolUntil = Date.now() + 20000 * (i + 1); lastErr = new Error("触发风控（" + j.code + "），已自动冷却"); continue; }
      if (j.code === -101 || j.code === -111) throw new Error("需要登录：请在设置里点「扫码登录」或用 Cookie 登录");
      if (j.code === -404 || j.code === 62002 || j.code === 62004) throw new Error("内容不存在或已删除");
      throw new Error(j.message || ("接口错误 " + j.code));
    }
    throw lastErr || new Error("请求失败");
  }

  const nav = () => apiGet("https://api.bilibili.com/x/web-interface/nav");
  const view = (bvid) => apiGet("https://api.bilibili.com/x/web-interface/view?bvid=" + encodeURIComponent(bvid));
  const opusDetail = (id) => apiGet("https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=" + encodeURIComponent(id));
  const dynamicDetail = (id) => apiGet("https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=" + encodeURIComponent(id));

  async function playurl(bvid, cid, qn) {
    const q = [
      "bvid=" + encodeURIComponent(bvid), "cid=" + cid, "qn=" + qn,
      "fnval=0", "fnver=0", "fourk=1", "platform=pc", "type=mp4",
    ].join("&");
    const data = await apiGet("https://api.bilibili.com/x/player/playurl?" + q);
    const durl = data.durl || [];
    if (!durl.length) return null;
    return { url: durl[0].url, backup: (durl[0].backup_url || [])[0] || "", quality: data.quality || qn, size: durl[0].size || 0 };
  }

  async function dashStreams(bvid, cid, qn) {
    const q = ["bvid=" + encodeURIComponent(bvid), "cid=" + cid, "qn=" + qn, "fnval=4048", "fnver=0", "fourk=1", "platform=pc"].join("&");
    const data = await apiGet("https://api.bilibili.com/x/player/playurl?" + q);
    const dash = data.dash || {};
    const videos = (dash.video || []).filter((v) => v.id <= qn && v.id !== 125 && v.id !== 126);
    videos.sort((a, b) => b.id - a.id || (b.bandwidth || 0) - (a.bandwidth || 0));
    const audios = (dash.audio || []).concat((dash.dolby && dash.dolby.audio) || []);
    audios.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    return {
      video: videos[0] ? { url: videos[0].baseUrl || videos[0].base_url, id: videos[0].id } : null,
      audio: audios[0] ? { url: audios[0].baseUrl || audios[0].base_url } : null,
      quality: videos[0] ? videos[0].id : data.quality || qn,
    };
  }

  function xmlToSrt(xml) {
    const out = [];
    const re = /<d p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
    let m, i = 0;
    const clock = (sec) => {
      sec = Math.max(0, sec);
      const h = Math.floor(sec / 3600), mi = Math.floor((sec % 3600) / 60), se = Math.floor(sec % 60);
      const ms = Math.round((sec - Math.floor(sec)) * 1000);
      const p = (n, w) => String(n).padStart(w, "0");
      return `${p(h,2)}:${p(mi,2)}:${p(se,2)},${p(ms < 1000 ? ms : 999,3)}`;
    };
    while ((m = re.exec(xml))) {
      const t = parseFloat((m[1] || "").split(",")[0]);
      if (!isFinite(t)) continue;
      const text = m[2].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
      if (!text) continue;
      i++;
      out.push(`${i}\n${clock(t)} --> ${clock(t + 4)}\n${text}\n`);
    }
    return out.join("\n");
  }

  function textDownload(name, text, mime) {
    try {
      saveBlob(new Blob([text], { type: mime || "text/plain;charset=utf-8" }), name);
      dlLog({ name, how: "text" });
      return true;
    } catch (e) { console.warn("[BiliDL] 文本文件下载失败", e); return false; }
  }

  async function extraFiles(bvid, cid, nameFor) {
    const made = [];
    if (conf.exCover) {
      const pic = (await view(bvid)).pic || "";
      if (pic) { await blobDownload({ url: pic, name: nameFor("jpg", ""), headers: { Referer: "https://www.bilibili.com/video/" + bvid } }).catch(() => {}); made.push("封面"); }
    }
    if (conf.exNfo) {
      const d = await view(bvid);
      const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n  <title>${esc(d.title)}</title>\n  <uniqueid type="bilibili" default="true">${esc(bvid)}</uniqueid>\n  <plot>${esc(d.desc)}</plot>\n  <premiered>${new Date((d.pubdate || 0) * 1000).toISOString().slice(0, 10)}</premiered>\n  <studio>${esc(d.owner && d.owner.name)}</studio>\n  <thumb>${esc(d.pic)}</thumb>\n</movie>\n`;
      if (textDownload(nameFor("nfo", ""), nfo, "application/xml")) made.push("NFO");
    }
    if (conf.exDm) {
      const xml = await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({ method: "GET", url: "https://comment.bilibili.com/" + cid + ".xml", onload: (r) => resolve(r.responseText || ""), onerror: reject, timeout: 20000 });
      }).catch(() => "");
      const srt = xml ? xmlToSrt(xml) : "";
      if (srt) { if (textDownload(nameFor("srt", "danmaku"), srt)) made.push("弹幕SRT"); } else toast("这个视频没有抓到弹幕");
    }
    if (conf.exSub) {
      try {
        const p = await apiGet(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`);
        const list = ((p.subtitle || {}).subtitles) || [];
        if (!list.length) toast("没有可用字幕（多为 UP 主未上传或未登录）");
        for (const it of list) {
          const url = it.subtitle_url && (it.subtitle_url.startsWith("//") ? "https:" + it.subtitle_url : it.subtitle_url);
          if (!url) continue;
          const j = await apiGet(url);
          const body = (j.body || []).map((b, i) => `${i + 1}\n00:${String(Math.floor(b.from / 60)).padStart(2, "0")}:${String(Math.floor(b.from % 60)).padStart(2, "0")},${String(Math.round((b.from % 1) * 1000)).padStart(3, "0")} --> 00:${String(Math.floor(b.to / 60)).padStart(2, "0")}:${String(Math.floor(b.to % 60)).padStart(2, "0")},${String(Math.round((b.to % 1) * 1000)).padStart(3, "0")}\n${String(b.content || "").trim()}\n`).join("\n");
          if (body && textDownload(nameFor("srt", it.lan), body)) made.push("字幕SRT");
        }
      } catch (e) { console.warn("[BiliDL] 字幕失败", e); }
    }
    if (made.length) toast("附加文件：" + made.join("、"));
  }

  /* ------------------------------------------------------------ 命名 */

  const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;
  const ALIAS = {
    "<视频标题>": "video_title", "<视频BV号>": "video_id", "<视频分集序号>": "video_episode",
    "<分集标题>": "video_page_title", "<UP主昵称>": "video_author", "<清晰度>": "video_quality",
    "<发布时间>": "video_date",
    "<专栏或动态标题>": "opus_title", "<专栏或动态id>": "opus_id", "<专栏或动态图片序号>": "opus_order",
    "<UP主>": "opus_author", "<日期>": "opus_date",
  };

  function cleanSeg(s) {
    return String(s || "").replace(ILLEGAL, "_").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 120);
  }

  function utf8Len(str) { return new TextEncoder().encode(String(str)).length; }

  // 文件名按 UTF-8 字节截断（Linux 单段 255 字节），保留扩展名
  function truncBytes(name, limit) {
    const text = String(name || "");
    if (utf8Len(text) <= limit) return text;
    const m = text.match(/^(.*?)(\.[A-Za-z0-9]{1,8})$/);
    let base = m ? m[1] : text;
    const suffix = m ? m[2] : "";
    while (base && utf8Len(base + suffix) > limit) base = base.slice(0, -1);
    return (base || "bili") + suffix;
  }

  function renderPath(tpl, vars, ext) {
    let t = String(tpl || "").trim() || "<title>.<ext>";
    for (const zh in ALIAS) t = t.split(zh).join("<" + ALIAS[zh] + ">");
    const MISS = "\u0000";
    const repl = (name) => {
      const key = name.replace(/[<>${}]/g, "").trim();
      const v = vars[key];
      if (v === undefined || v === null || String(v) === "") return MISS;   // 缺失变量先打标记
      return String(v);
    };
    t = t.replace(/<([a-zA-Z0-9_]+)>/g, (m, k) => (k === "ext" ? ext : repl(m)));
    t = t.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k === "ext" ? ext : repl(m)));
    // 把「缺失变量 + 相邻的 - / _ 空格」整段删掉，避免出现 `-单集.mp4` 这种残渣
    t = t.replace(/[\s_\-\/]*\u0000[\s_\-\/]*/g, (mm) => (mm.includes("/") ? "/" : ""));
    t = t.replace(/^[\s_\-\/]+|[\s_\-\/]+$/g, "");
    const parts = String(t).split(/[\\/]+/).map(cleanSeg).filter((p) => p && p !== "." && p !== "..");
    if (!parts.length) parts.push("untitled");
    let last = parts.pop();
    if (!/\.[a-z0-9]{1,5}$/i.test(last)) last += "." + ext;
    last = truncBytes(last, 200);
    const prefix = cleanSeg(conf.subDir || "").replace(/^\/+|\/+$/g, "");
    return [prefix, ...parts, last].filter(Boolean).join("/");
  }

  /* ------------------------------------------------------------ 下载 */

  const queue = [];
  let running = 0;
  let paused = false;
  const done = { ok: 0, fail: 0, skip: 0 };
  const failedJobs = [];   // 失败的任务留一份，方便一键重试
  const usedNames = new Set();
  const runningJobs = new Set();   // 正在下载的任务对象（取消全部要标记它们）
  const activeReqs = new Set();    // 在途的 GM_download / GM_xmlhttpRequest 句柄（取消全部要 abort）
  function trackReq(handle) { if (handle) activeReqs.add(handle); return handle; }
  function untrackReq(handle) { if (handle) activeReqs.delete(handle); }

  function unique(name) {
    if (!usedNames.has(name)) { usedNames.add(name); return name; }
    const m = name.match(/^(.*?)(\.[a-z0-9]{1,5})$/i);
    const base = m ? m[1] : name; const ext = m ? m[2] : "";
    for (let i = 1; i < 1000; i++) {
      const cand = base + "-" + i + ext;
      if (!usedNames.has(cand)) { usedNames.add(cand); return cand; }
    }
    return name;
  }

  function dlLog(rec) {
    try {
      window.__bilidlDlLog = window.__bilidlDlLog || [];
      window.__bilidlDlLog.push(Object.assign({ t: Date.now() }, rec));
      if (window.__bilidlDlLog.length > 50) window.__bilidlDlLog.shift();
    } catch (e) {}
  }

  // 从 TM 拿到的响应里取出二进制（不同 TM 版本可能给 Blob / ArrayBuffer / 字符串）
  function toBlob(r, mime) {
    const body = r && r.response;
    if (!body) throw new Error("空响应");
    if (body instanceof Blob) return body;
    if (body instanceof ArrayBuffer) return new Blob([body], { type: mime || "application/octet-stream" });
    if (ArrayBuffer.isView(body)) return new Blob([body.buffer], { type: mime || "application/octet-stream" });
    if (typeof body === "string") return new Blob([body], { type: mime || "text/plain;charset=utf-8" });
    return new Blob([body], { type: mime || "application/octet-stream" });
  }

  // 把 blob 存成文件。要点：保存点击**绝不能让 B站 的 document 级监听看到**，
  // 否则它会把这次点击当成「打开图片」，于是下载成功 + 另外弹一个标签页。
  // 做法：把 <a> 放进一个 closed shadow root 里再派发 click ——
  // composed:false 的事件不会跨出 shadow 边界，document 上的捕获/冒泡监听都收不到。
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const fname = String(name || "download").split("/").pop() || "download";
    const mk = () => {
      const a = document.createElement("a");
      a.download = fname; a.href = url; a.rel = "noopener"; a.style.display = "none";
      a.addEventListener("click", (e) => e.stopPropagation(), true);
      return a;
    };
    let ok = false;
    try {
      const host = document.createElement("div");
      host.style.cssText = "display:none!important";
      (document.body || document.documentElement).appendChild(host);
      const root = host.attachShadow({ mode: "closed" });
      const a = mk();
      root.appendChild(a);
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: false }));
      setTimeout(() => { try { host.remove(); } catch (e) {} }, 3000);
      ok = true;
    } catch (e) { ok = false; }
    if (!ok) {                                    // 极端内核：游离节点直接点
      try { mk().click(); ok = true; } catch (e) { ok = false; }
    }
    if (!ok) {                                    // 最后的兜底（会经过页面监听，但只在前两条都失败时）
      try {
        const a = mk();
        (document.body || document.documentElement).appendChild(a);
        a.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
        a.remove();
      } catch (e) { console.warn("[BiliDL] saveBlob 失败", e); }
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function blobDownload(opt) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("缺少 GM_xmlhttpRequest（检查 @grant）"));
      // 不要手动加 Origin / Referer：TM 与浏览器都把它们当受限头，
      // 带上反而可能让请求直接失败（这是 1.2.11 全量下载失败的原因）。
      const headers = Object.assign({}, opt.headers || {});
      let handle = null;
      handle = GM_xmlhttpRequest({
        method: "GET", url: opt.url, headers, responseType: "arraybuffer", timeout: 120000,
        onprogress: (p) => { if (p && p.total) opt.onProgress && opt.onProgress(p.loaded / p.total); },
        onload: (r) => {
          untrackReq(handle);
          const status = (r && r.status) || 0;
          if (status >= 400) return reject(new Error("HTTP " + status));
          try {
            const blob = toBlob(r, opt.mime);
            saveBlob(blob, opt.name);
            dlLog({ name: opt.name, how: "blob", size: blob.size });
            resolve(true);
          } catch (e) { reject(e); }
        },
        onerror: () => { untrackReq(handle); reject(new Error("网络错误（可能被 @connect / 防盗链拦截）")); },
        ontimeout: () => { untrackReq(handle); reject(new Error("下载超时")); },
      });
      trackReq(handle);
    });
  }

  function flatten(name) {
    return String(name || "").replace(/^[\/\\]+|[\/\\]+$/g, "").replace(/[\/\\]+/g, "-");
  }

  function gmDownload(opt) {
    const native = () => new Promise((resolve, reject) => {
      let handle = null;
      handle = GM_download({
        url: opt.url, name: opt.name, headers: opt.headers, saveAs: false,
        onprogress: (p) => { if (p && p.total) opt.onProgress && opt.onProgress(p.loaded / p.total); },
        onload: () => { untrackReq(handle); resolve(true); },
        onerror: (e) => { untrackReq(handle); reject(new Error((e && (e.error || e.details)) || "下载失败")); },
        ontimeout: () => { untrackReq(handle); reject(new Error("下载超时")); },
      });
      trackReq(handle);
    });
    const isVideo = opt.kind === "video";
    if (!isVideo) {
      // 浏览器自身的 a[download] 不支持子目录（"/" 会被替换成 "_"），
      // 所以规则里带 "/" 时改用 GM_download（TM 走 downloads API，支持相对路径）；失败再退回 blob 平铺保存。
      const wantsPath = !!conf.gmSave && typeof GM_download === "function";
      if (wantsPath) {
        return native().then(
          (r) => { dlLog({ name: opt.name, how: "native-path" }); return r; },
          (e) => {
            dlLog({ name: opt.name, how: "native-path-fail", err: String(e && e.message) });
            return blobDownload(Object.assign({}, opt, { name: flatten(opt.name) })).catch((e2) => {
              dlLog({ name: opt.name, how: "blob-fail", err: String(e2 && e2.message) });
              throw e2;
            });
          });
      }
      // 没有子目录：一律 blob，绝不交给 GM_download（避免个别 TM 配置把跨域地址开成标签页）
      return blobDownload(opt).catch((e) => {
        dlLog({ name: opt.name, how: "blob-fail", err: String(e && e.message) });
        throw e;
      });
    }
    return native().then((r) => { dlLog({ name: opt.name, how: "native" }); return r; },
      (e) => {
        dlLog({ name: opt.name, how: "native-fail", err: String(e && e.message) });
        return blobDownload(opt);
      });
  }

  function enqueue(job) {
    queue.push(job);
    renderQueue();
    pump();
  }

  /** 取消全部：清空排队 + 中止在途下载 + 清掉失败/计数，任务不再留在队列里。 */
  function cancelAllJobs() {
    const removed = queue.length + runningJobs.size;
    queue.length = 0;
    failedJobs.length = 0;
    done.ok = done.fail = done.skip = 0;
    for (const job of runningJobs) job.canceled = true;
    for (const handle of [...activeReqs]) {
      try { handle.abort && handle.abort(); } catch (e) { console.warn("[BiliDL] abort", e); }
    }
    activeReqs.clear();
    runningJobs.clear();
    running = 0;   // 句柄 abort 后回调不保证立刻回来，计数先归零
    paused = false;
    const pauseBtn = $("#bilidl-sa-pause");
    if (pauseBtn) pauseBtn.textContent = "暂停";
    renderQueue();
    toast(removed ? "已取消并移除 " + removed + " 个任务" : "下载队列已经是空的");
  }

  function pump() {
    if (paused) return;
    const limit = Math.max(1, Math.min(4, conf.concurrency || 2));
    while (running < limit && queue.length) {
      const job = queue.shift();
      running++;
      job.status = "run"; job.progress = 0;
      runningJobs.add(job);
      renderQueue();
      runJob(job)
        .then((r) => {
          if (job.canceled) return;
          job.status = r === "skip" ? "skip" : "ok";
          if (r === "skip") done.skip++; else done.ok++;
        })
        .catch((e) => {
          if (job.canceled) { job.status = "canceled"; return; }
          job.status = "fail";
          job.error = e && e.message ? e.message : String(e);
          done.fail++;
          failedJobs.push(job);
          console.warn("[BiliDL]", e);
        })
        .finally(async () => {
          runningJobs.delete(job);
          running = Math.max(0, running - 1);
          renderQueue();
          await sleep(rand(conf.interval || 900, (conf.interval || 900) + 600));
          pump();
        });
    }
    if (!running && !queue.length) renderQueue();
  }

  async function runJob(job) {
    const name = unique(job.name);
    await gmDownload({
      url: job.url, name, headers: job.headers, kind: job.kind,
      onProgress: (p) => { job.progress = p; renderQueue(); },
    });
    if (job.extra && job.extra.social) {
      if (!job.extra.skipExtras && !extrasDone.has(job.extra.ident)) {
        extrasDone.add(job.extra.ident);
        try { await socialExtras(job.extra.info, job.extra.nameFor); } catch (e) { console.warn("[BiliDL] 附加文件失败", e); }
      }
    } else if (job.extra && job.extra.yt) {
      if (!job.extra.skipExtras && !extrasDone.has("yt:" + job.extra.info.id)) {
        extrasDone.add("yt:" + job.extra.info.id);
        try { await ytExtraFiles(job.extra.info, job.extra.nameFor); } catch (e) { console.warn("[BiliDL] YouTube 附加文件失败", e); }
      }
    } else if (job.extra && !extrasDone.has(job.extra.cid)) {
      extrasDone.add(job.extra.cid);
      try { await extraFiles(job.extra.bvid, job.extra.cid, job.extra.nameFor); } catch (e) { console.warn("[BiliDL] 附加文件失败", e); }
    }
    return "ok";
  }

  const extrasDone = new Set();
  // 供调试/自动化测试用（浏览器控制台可调用）
  try {
    window.__bilidlSA = { extraFiles, dashStreams, conf, gmDownload, renderPath, xmlToSrt, blobDownload, saveBlob, toBlob, buildVideoJobs, buildOpusJobs, buildArticleJobs, buildYouTubeJobs, ytDetect, ytBuildDecipher, ytExtractJson, ytToSrt };
    window.__bilidlSA.getWorkOf = (el) => workOf(el);
  } catch (e) {}

  /* -------------------------------------------------- 解析链接 / 作品 */

  const BV_RE = /BV[0-9A-Za-z]{10}/;
  const AV_RE = /av(\d{1,12})/i;

  function classify(url) {
    if (!url) return null;
    if (isYouTubeUrl(url)) {
      const yt = ytDetect(url);
      return yt ? { ...yt, youtube: true } : null;
    }
    if (isDouyinUrl(url)) {
      const dy = dyUrlInfo(url);
      if (dy) return { kind: "douyin", ident: dy.ident, dyType: dy.type, shareUrl: url, social: true };
    }
    if (isXhsUrl(url)) {
      const xhs = xhsUrlInfo(url);
      if (xhs) return { kind: "xhs", ident: xhs.ident, token: xhs.token, shareUrl: url, social: true };
    }
    if (/\/opus\/(\d{6,})/.test(url)) return { kind: "opus", ident: url.match(/\/opus\/(\d{6,})/)[1] };
    if (/\/read\/cv(\d{1,12})/.test(url)) return { kind: "article", ident: url.match(/\/read\/cv(\d{1,12})/)[1] };
    if (/t\.bilibili\.com\/(\d{15,})/.test(url)) return { kind: "dynamic", ident: url.match(/t\.bilibili\.com\/(\d{15,})/)[1] };
    const bv = url.match(BV_RE); if (bv) return { kind: "video", ident: bv[0] };
    const av = url.match(AV_RE); if (av) return { kind: "video", ident: "av" + av[1] };
    return null;
  }

  /* ------------------------------------------------- 抖音 / 小红书 */

  function hostOf(url) {
    try { return new URL(url, location.href).hostname.toLowerCase(); } catch (e) { return ""; }
  }
  function hostIn(host, list) { return list.some((s) => host === s || host.endsWith("." + s)); }
  const DY_HOSTS = ["douyin.com", "iesdouyin.com"];
  const DY_SHORT = ["v.douyin.com", "jx.douyin.com"];
  const XHS_HOSTS = ["xiaohongshu.com", "xiaohongshu.cn", "rednote.com", "rednote.cn"];
  const XHS_SHORT = ["xhslink.com", "xhslink.cn"];
  function isDouyinUrl(u) { const h = hostOf(u); return hostIn(h, DY_HOSTS) || hostIn(h, DY_SHORT); }
  function isXhsUrl(u) { const h = hostOf(u); return hostIn(h, XHS_HOSTS) || hostIn(h, XHS_SHORT); }
  function isDouyinShort(u) { return hostIn(hostOf(u), DY_SHORT); }
  function isXhsShort(u) { return hostIn(hostOf(u), XHS_SHORT); }
  function isSocialShort(u) { return isDouyinShort(u) || isXhsShort(u); }

  function dyUrlInfo(url) {
    let m = url.match(/\/(?:share\/)?(video|note|slides)\/(\d{8,})/);
    if (m) return { type: m[1], ident: m[2] };
    m = url.match(/[?&](?:modal_id|aweme_id|vid)=(\d{8,})/);
    if (m) return { type: "", ident: m[1] };
    return null;
  }
  function xhsUrlInfo(url) {
    let m = url.match(/\/(?:explore|discovery\/item|user\/profile\/[^/]+)\/([0-9a-fA-F]{20,32})/);
    let ident = m ? m[1] : "";
    if (!ident) { m = url.match(/[?&](?:note_id|noteId)=([0-9a-fA-F]{20,32})/); ident = m ? m[1] : ""; }
    if (!ident) return null;
    const t = url.match(/[?&]xsec_token=([^&]+)/);
    return { ident, token: t ? decodeURIComponent(t[1]) : "" };
  }

  function extOf(url) {
    try {
      const p = new URL(url, location.href).pathname.toLowerCase();
      const m = p.match(/\.([a-z0-9]{2,5})$/);
      const ok = ["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "bmp"];
      return m && ok.includes(m[1]) ? m[1] : "jpg";
    } catch (e) { return "jpg"; }
  }

  function socialRatio() {
    const q = Number(conf.quality) || 116;
    if (q >= 112) return "1080p";
    if (q >= 64) return "720p";
    if (q >= 32) return "540p";
    return "360p";
  }
  const RATIO_NAME = { "1080p": "1080P", "720p": "720P", "540p": "480P", "360p": "360P" };

  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("缺少 GM_xmlhttpRequest"));
      try {
        GM_xmlhttpRequest({
          method: opts.method || "GET", url: opts.url, headers: opts.headers || {}, data: opts.data,
          timeout: opts.timeout || 25000,
          onload: (r) => {
            if (!r || (r.status && r.status >= 400)) return reject(new Error("HTTP " + ((r && r.status) || 0)));
            resolve({ text: String((r && r.responseText) || ""), headers: String((r && r.responseHeaders) || "") });
          },
          onerror: () => reject(new Error("网络错误（可能被 @connect 拦截）")),
          ontimeout: () => reject(new Error("请求超时")),
        });
      } catch (e) { reject(e); }
    });
  }

  function gmGetRaw(url, referer, extraHeaders) {
    const headers = Object.assign({}, extraHeaders || {});
    if (referer) headers.Referer = referer;
    return gmRequest({ url, headers }).then((r) => r.text);
  }

  /** 抖音分享页要求带 ttwid（不然只返回空壳）；注册后必须再访问回调，ttwid 才会种到 iesdouyin。 */
  let dyTtwid = "";
  let dyTtwidAt = 0;
  function ensureDouyinTtwid() {
    if (dyTtwid && Date.now() - dyTtwidAt < 3600 * 1000) return Promise.resolve(dyTtwid);
    const body = JSON.stringify({ region: "cn", aid: 1768, needFid: false, service: "www.iesdouyin.com", union: true, fid: "" });
    return gmRequest({
      url: "https://ttwid.bytedance.com/ttwid/union/register/", method: "POST",
      headers: { "Content-Type": "application/json" }, data: body,
    }).then(async (r) => {
      const m = String(r.headers || "").match(/ttwid=([^;]+)/i);
      if (!m) return "";
      dyTtwid = m[1];
      dyTtwidAt = Date.now();
      let callback = "";
      try { callback = String((JSON.parse(r.text) || {}).redirect_url || ""); } catch (e) { callback = ""; }
      if (callback.startsWith("https://")) {
        const cm = String((await gmRequest({ url: callback, headers: { Referer: "https://www.iesdouyin.com/" } })).headers || "").match(/ttwid=([^;]+)/i);
        if (cm) dyTtwid = cm[1];
      }
      return dyTtwid;
    }).catch(() => "");
  }

  /** 从 HTML/脚本文本里取 marker 之后的第一个 JSON 对象 */
  function scriptJson(text, marker, endMark) {
    const src = String(text || "");
    const i = src.indexOf(marker);
    if (i < 0) return null;
    const s = src.indexOf("{", i);
    if (s < 0) return null;
    let e = endMark ? src.indexOf(endMark, s) : -1;
    if (e < 0) e = src.length;
    let raw = src.slice(s, e).trim().replace(/;+$/, "").replace(/undefined/g, "null");
    try { return JSON.parse(raw); } catch (err) { return null; }
  }

  function routerItem(html) {
    const data = scriptJson(html, "window._ROUTER_DATA", "</script>");
    if (!data) return null;
    const nodes = [];
    if (data.loaderData && typeof data.loaderData === "object") nodes.push(...Object.values(data.loaderData));
    nodes.push(data);
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const res = node.videoInfoRes;
      const list = (res && res.item_list) || [];
      if (list[0]) return list[0];
    }
    return null;
  }

  function dyImageUrl(image) {
    for (const key of ["url_list", "download_url_list"]) {
      for (const url of (image && image[key]) || []) {
        if (typeof url === "string" && url.startsWith("http") && url.indexOf("-water:") < 0) return url;
      }
    }
    for (const key of ["url_list", "download_url_list"]) {
      for (const url of (image && image[key]) || []) {
        if (typeof url === "string" && url.startsWith("http")) return url;
      }
    }
    return "";
  }

  function dyInfo(item, shareUrl) {
    const ident = String(item.aweme_id || "");
    const author = item.author || {};
    const desc = String(item.desc || "").trim();
    const images = (item.images || []).map(dyImageUrl).filter(Boolean);
    const video = item.video || {};
    const play = video.play_addr || {};
    const ratio = socialRatio();
    // 图集/动图作品里的 video 常是实况照片的占位（无声 mp3 或 http 占位地址），不能当作品视频
    let videoUrl = "";
    const gallery = images.length > 0;
    const uri = String(play.uri || "");
    if (!gallery && uri && !uri.startsWith("http") && uri.indexOf(".mp3") < 0) {
      videoUrl = "https://aweme.snssdk.com/aweme/v1/play/?video_id=" + encodeURIComponent(uri) + "&ratio=" + ratio + "&line=0";
    } else if (!gallery) {
      const list = play.url_list || [];
      for (const url of list) { if (typeof url === "string" && url.startsWith("http")) { videoUrl = url.replace("playwm", "play"); break; } }
    }
    let cover = "";
    for (const key of ["cover", "origin_cover", "dynamic_cover"]) {
      const list = (video[key] && video[key].url_list) || [];
      cover = list.find((u) => typeof u === "string" && u.startsWith("http")) || "";
      if (cover) break;
    }
    if (!cover && images.length) cover = images[0];
    return {
      site: "douyin", kind: gallery ? "opus" : "video", ident, title: desc || "无标题", desc,
      author: String(author.nickname || "未知作者"),
      authorUid: String(author.uid || author.sec_uid || ""),
      pubdate: Number(item.create_time || 0),
      duration: Math.floor(Number(video.duration || 0) / 1000),
      cover, images, videoUrl, quality: RATIO_NAME[ratio] || "",
      url: shareUrl || ("https://www.douyin.com/video/" + ident),
    };
  }

  // 抖音分享页只在移动端 UA 下返回 SSR 数据（桌面 UA 只给空壳页），
  // Tampermonkey 的 GM_xmlhttpRequest 允许覆盖 User-Agent，这里显式带上。
  const DY_MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  async function douyinDetail(ident, shareUrl) {
    const ttwid = await ensureDouyinTtwid();
    const dyHeaders = { "User-Agent": DY_MOBILE_UA };
    if (ttwid) dyHeaders.Cookie = "ttwid=" + ttwid;
    const cands = [];
    if (shareUrl) cands.push(shareUrl);
    cands.push("https://www.iesdouyin.com/share/note/" + ident + "/");
    cands.push("https://www.iesdouyin.com/share/video/" + ident + "/");
    let item = null;
    for (const url of cands) {
      try { item = routerItem(await gmGetRaw(url, null, dyHeaders)); } catch (e) { item = null; }
      if (item) break;
    }
    if (!item) {
      try {
        const text = await gmGetRaw("https://www.iesdouyin.com/web/api/v2/aweme/slidesinfo/?aweme_ids=%5B" + ident + "%5D&request_source=200", null, dyHeaders);
        const data = JSON.parse(text);
        item = (data && data.aweme_details && data.aweme_details[0]) || null;
      } catch (e) { item = null; }
    }
    if (!item) {
      throw new Error("抖音解析失败：作品不存在、已删除，或当前浏览器的 GM 请求未能模拟移动端 UA。" +
        "可改用推送版脚本（由服务端解析）或把分享链接粘贴到 WebUI。");
    }
    return dyInfo(item, shareUrl || ("https://www.iesdouyin.com/share/video/" + ident + "/"));
  }

  function xhsImageUrl(image) {
    const fileId = String((image && (image.fileId || image.traceId)) || "").trim();
    if (fileId) {
      if (/^https?:/i.test(fileId)) return fileId.split("!")[0];
      return "https://sns-img-qc.xhscdn.com/" + encodeURI(fileId).replace(/%2F/gi, "/");
    }
    for (const key of ["urlDefault", "url", "urlPre"]) {
      const url = image && image[key];
      if (typeof url === "string" && url.startsWith("http")) return url.split("!")[0];
    }
    return "";
  }

  function xhsStreamUrl(video) {
    const stream = ((video && video.media && video.media.stream) || {});
    for (const codec of ["h264", "h265", "av1", "h266"]) {
      for (const item of stream[codec] || []) {
        let url = item.masterUrl || item.url || "";
        if (typeof url !== "string" || !url.startsWith("http")) continue;
        url = url.replace(/^http:/, "https:");
        const h = Number(item.height || 0);
        const label = h >= 2160 ? "4K" : h >= 1440 ? "2K" : h >= 1080 ? "1080P" : h >= 720 ? "720P" : "540P";
        return { url, quality: label };
      }
    }
    return { url: "", quality: "" };
  }

  function xhsInfo(note, ident, shareUrl) {
    const user = note.user || {};
    const desc = String(note.desc || "").trim();
    const title = String(note.title || "").trim() || desc.split("\n")[0].slice(0, 80) || "无标题";
    const images = (note.imageList || []).map(xhsImageUrl).filter(Boolean);
    const isVideo = String(note.type || "").toLowerCase() === "video";
    const stream = isVideo ? xhsStreamUrl(note.video) : { url: "", quality: "" };
    let created = Number(note.time || 0);
    if (created > 1e10) created = Math.floor(created / 1000);
    return {
      site: "xhs", kind: isVideo ? "video" : "opus", ident: String(note.noteId || ident), title, desc,
      author: String(user.nickname || user.nickName || "未知作者"),
      authorUid: String(user.userId || user.user_id || ""),
      pubdate: created, duration: 0,
      cover: images[0] || "", images: isVideo ? [] : images,
      videoUrl: stream.url, quality: stream.quality,
      url: shareUrl || ("https://www.xiaohongshu.com/explore/" + ident),
    };
  }

  function pageInitialState() {
    const nodes = document.querySelectorAll("script:not([src])");
    for (const node of nodes) {
      const text = node.textContent || "";
      if (text.indexOf("window.__INITIAL_STATE__") < 0) continue;
      const state = scriptJson(text, "window.__INITIAL_STATE__");
      if (state) return state;
    }
    return null;
  }

  function xhsHasMedia(note) {
    if (!note) return false;
    const imgs = note.imageList || [];
    const stream = note.video && note.video.media && note.video.media.stream;
    return imgs.length > 0 || !!stream;
  }

  function pickXhsNote(state, ident) {
    const map = (state && state.note && state.note.noteDetailMap) || {};
    // 先按 id 精确取；取不到再退回第一条。但只有「真的带图/视频」的才算解析成功，
    // 信息流页面里预置的 noteDetailMap 常常只有标题、imageList 为空。
    let entry = ident ? map[ident] : null;
    if (!entry) entry = Object.values(map).find((v) => v && xhsHasMedia(v.note || v));
    if (!entry) return null;
    const note = entry.note || entry;
    return note && xhsHasMedia(note) ? note : null;
  }

  async function xhsDetail(ident, token, shareUrl) {
    let note = null;
    let state = null;
    if (hostIn(hostOf(location.href), XHS_HOSTS)) state = pageInitialState();
    if (state) note = pickXhsNote(state, ident);
    if (!note) {
      let url = shareUrl || ("https://www.xiaohongshu.com/explore/" + ident);
      if (token && !/[?&]xsec_token=/.test(url)) {
        url += (url.indexOf("?") >= 0 ? "&" : "?") + "xsec_token=" + encodeURIComponent(token) + "&xsec_source=pc_share";
      }
      const html = await gmGetRaw(url);
      state = scriptJson(html, "window.__INITIAL_STATE__", "</script>");
      note = state ? pickXhsNote(state, ident) : null;
      // 服务端渲染的页面偶尔也把图集放在别的键下，做一次兜底收集
      if (!note) note = xhsNoteFallback(state, ident);
    }
    if (!note) {
      throw new Error(token
        ? "小红书笔记不存在、已删除或仅登录可见"
        : "小红书需要带 xsec_token 的分享链接（在笔记页点「分享 → 复制链接」）");
    }
    return xhsInfo(note, ident, shareUrl);
  }

  function xhsNoteFallback(state, ident) {
    let found = null;
    let seen = 0;
    const walk = (o, d) => {
      if (found || !o || typeof o !== "object" || d > 8 || seen > 30000) return;
      seen++;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
      const nid = o.noteId || o.note_id || o.id;
      if (nid === ident && xhsHasMedia(o)) { found = o; return; }
      Object.keys(o).forEach((k) => walk(o[k], d + 1));
    };
    try { walk(state, 0); } catch (e) {}
    return found;
  }

  async function socialDetail(work) {
    if (work.kind === "douyin") return douyinDetail(work.ident, work.shareUrl);
    return xhsDetail(work.ident, work.token, work.shareUrl);
  }

  function socialNfo(info) {
    const escXml = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const date = info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : "";
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n  <title>${escXml(info.title)}</title>\n  <uniqueid type="${escXml(info.site)}" default="true">${escXml(info.ident)}</uniqueid>\n  <plot>${escXml(info.desc)}</plot>\n  <premiered>${date}</premiered>\n  <studio>${escXml(info.author)}</studio>\n  <thumb>${escXml(info.cover)}</thumb>\n</movie>\n`;
  }

  async function socialExtras(info, nameFor) {
    const made = [];
    if (conf.exCover && info.cover) {
      await blobDownload({ url: info.cover, name: nameFor(extOf(info.cover), "") }).catch(() => {});
      made.push("封面");
    }
    if (conf.exNfo && textDownload(nameFor("nfo", ""), socialNfo(info), "application/xml")) made.push("NFO");
    if (conf.exSub || conf.exDm) toast("抖音/小红书没有字幕与弹幕文件，已跳过");
    if (made.length) toast("附加文件：" + made.join("、"));
  }

  async function buildSocialJobs(work) {
    const info = await socialDetail(work);
    const date = info.pubdate ? new Date(info.pubdate * 1000).toISOString().slice(0, 10) : "";
    const jobs = [];
    const vars = {
      video_title: info.title, video_id: info.ident, video_episode: "1", video_page_title: info.title,
      video_author: info.author, video_quality: info.quality || RATIO_NAME[socialRatio()],
      video_date: date, video_author_uid: info.authorUid,
    };
    if (info.kind !== "opus" && info.videoUrl) {
      const nameFor = (ext, suffix) => {
        const n = renderPath(conf.videoTpl, vars, ext);
        return suffix ? n.replace(/(\.[^.\/]+)$/, "-" + suffix + "$1") : n;
      };
      jobs.push({
        kind: "video", title: info.title, url: info.videoUrl, headers: {},
        name: nameFor("mp4", ""), status: "wait", extra: { social: true, ident: info.site + ":" + info.ident, info, nameFor, skipExtras: false },
      });
      return jobs;
    }
    if (!info.images.length) throw new Error("作品里没有找到可下载的图片");
    const ovars = {
      opus_title: info.title, opus_id: info.ident, opus_author: info.author, opus_date: date,
    };
    info.images.forEach((url, i) => {
      jobs.push({
        kind: "opus", title: info.title, url, headers: {},
        name: renderPath(conf.opusTpl, Object.assign({}, ovars, { opus_order: i + 1 }), extOf(url)),
        status: "wait",
      });
    });
    return jobs;
  }

  function gmResolve(url) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== "function") return resolve(null);
      try {
        GM_xmlhttpRequest({
          method: "GET", url, timeout: 15000,
          onload: (r) => resolve((r && (r.finalUrl || r.responseURL)) || null),
          onerror: () => resolve(null), ontimeout: () => resolve(null),
        });
      } catch (e) { resolve(null); }
    });
  }

  async function resolveShort(url) {
    // b23.tv 等短链：先试 GM_xmlhttpRequest（不受跨域限制），失败再退回 fetch
    const viaGm = await gmResolve(url);
    if (viaGm && viaGm !== url) return viaGm;
    try {
      const r = await fetch(url, { method: "GET", redirect: "follow", credentials: "omit" });
      if (r.url && r.url !== url) return r.url;
    } catch (e) {}
    return url;
  }

  function opusPics(item) {
    const pics = [];
    const add = (u) => {
      let v = String(u || "").trim();
      if (!v) return;
      if (v.startsWith("//")) v = "https:" + v;
      v = v.replace(/^http:\/\/([\w.-]*hdslb\.com\/bfs\/)/i, "https://$1");
      v = v.replace(/@[^/]*$/, "");
      if (v) pics.push(v);
    };
    const mods = (item && item.modules) || [];
    for (const m of mods) {
      // 新版图文（如 /opus/1262380051833290755）把九宫格放在 MODULE_TYPE_TOP 的
      // module_top.display.album.pics 里，正文 module_content 只有文字。
      if (m.module_type === "MODULE_TYPE_TOP") {
        const album = m.module_top && m.module_top.display && m.module_top.display.album;
        for (const pic of (album && album.pics) || []) add(pic && (pic.url || pic.src));
      }
      if (m.module_type === "MODULE_TYPE_CONTENT" && m.module_content) {
        for (const p of m.module_content.paragraphs || []) {
          if (p.para_type === 2 && p.pic && p.pic.pics) for (const pic of p.pic.pics) add(pic && (pic.url || pic.src));
        }
      }
    }
    if (!pics.length && item && item.basic && item.basic.image) {
      const im = item.basic.image;
      add(typeof im === "string" ? im : (im && (im.url || im.src)));
    }
    return [...new Set(pics)];
  }

  function opusTitle(item) {
    let t = "";
    for (const m of (item && item.modules) || []) {
      if (m.module_type === "MODULE_TYPE_TITLE" && m.module_title) t = m.module_title.text || "";
    }
    if (!t && item && item.basic) t = item.basic.title || "";
    return String(t || "图文").replace(/\s*-\s*哔哩哔哩\s*$/, "").trim();
  }

  function opusAuthor(item) {
    for (const m of (item && item.modules) || []) {
      if (m.module_type === "MODULE_TYPE_AUTHOR" && m.module_author) return m.module_author.name || "";
    }
    return "";
  }

  async function buildOpusJobs(work) {
    const d = await opusDetail(work.ident);
    const item = d.item || d;
    const title = work.title || opusTitle(item);
    const author = opusAuthor(item);
    const pics = opusPics(item);
    if (!pics.length) throw new Error("图文里没有找到图片");
    const jobs = [];
    pics.forEach((url, i) => {
      jobs.push({
        kind: "opus", title, url,
        headers: { Referer: "https://www.bilibili.com/opus/" + work.ident, Origin: "https://www.bilibili.com" },
        name: renderPath(conf.opusTpl, { opus_title: title, opus_id: work.ident, opus_order: i + 1, opus_author: author, opus_date: "" }, "jpg"),
        status: "wait",
      });
    });
    return jobs;
  }

  function gmGetText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("缺少 GM_xmlhttpRequest"));
      try {
        GM_xmlhttpRequest({
          method: "GET", url, timeout: 20000,
          headers: { Referer: "https://www.bilibili.com/" },
          onload: (r) => resolve(String((r && r.responseText) || "")),
          onerror: () => reject(new Error("网络错误")), ontimeout: () => reject(new Error("超时")),
        });
      } catch (e) { reject(e); }
    });
  }

  async function buildArticleJobs(work) {
    const cv = work.ident;
    // 新版专栏正文是一条动态图文：先用 /x/article/view 拿 dyn_id_str，再用 opus/detail 取全部图片
    let title = work.title || "";
    let urls = [];
    let opusId = "";   // 新版专栏的 <opus_id>（动态图文 id），不是 cv 号
    try {
      const v = await apiGet("https://api.bilibili.com/x/article/view?id=" + cv);
      const vd = (v && (v.data || v)) || {};
      title = title || vd.title || "";
      opusId = String((vd.opus && vd.opus.opus_id) || "").trim();
      const dyn = String(vd.dyn_id_str || "").trim();
      if (!opusId) opusId = dyn;
      if (dyn) {
        const od = await opusDetail(dyn);
        const item = (od && od.item) || od || {};
        urls = opusPics(item);
        if (!title) title = opusTitle(item);
      }
    } catch (e) { /* 老专栏退回抓页面 */ }
    if (!urls.length) {
      const html = await gmGetText("https://www.bilibili.com/read/cv" + cv);
      const doc = new DOMParser().parseFromString(html, "text/html");
      const holder = doc.querySelector(".article-holder, .article-content, #read-article-holder") || doc;
      urls = [...holder.querySelectorAll("img")]
        .map((i) => i.getAttribute("data-src") || i.getAttribute("src") || "")
        .filter((u) => /hdslb\.com\/bfs\//.test(u))
        .map((u) => (u.startsWith("//") ? "https:" + u : u).split("@")[0]);
    }
    const uniq = [...new Set(urls)];
    if (!uniq.length) throw new Error("专栏里没有找到图片");
    title = String(title || ("专栏 " + cv)).trim();
    const rl = work.readlist;
    const varsBase = { opus_title: title, opus_id: opusId || cv, opus_author: "", opus_date: "" };
    return uniq.map((url, i) => {
      const vars = { ...varsBase, opus_order: i + 1 };
      if (rl) { vars.readlist_title = rl.title; vars.readlist_order = rl.order || ""; vars.readlist_id = rl.id; }
      const tpl = rl ? (conf.readlistTpl || DEFAULTS.readlistTpl) : (conf.opusTpl || DEFAULTS.opusTpl);
      return {
        kind: "article", title, url,
        headers: { Referer: "https://www.bilibili.com/read/cv" + cv, Origin: "https://www.bilibili.com" },
        name: renderPath(tpl, vars, "jpg"),
        status: "wait",
      };
    });
  }

  async function buildDynamicJobs(work) {
    const d = await dynamicDetail(work.ident);
    const mods = d.item || d;
    const desc = (mods.modules && mods.modules.module_dynamic && mods.modules.module_dynamic.desc && mods.modules.module_dynamic.desc.text) || "动态";
    const author = (mods.modules && mods.modules.module_author && mods.modules.module_author.name) || "";
    const major = (mods.modules && mods.modules.module_dynamic && mods.modules.module_dynamic.major) || {};
    const pics = [];
    const push = (u) => { if (u) pics.push(String(u).replace(/@[^/]*$/, "")); };
    if (major.opus && major.opus.pics) major.opus.pics.forEach((p) => push(p.url));
    if (major.draw && major.draw.items) major.draw.items.forEach((p) => push(p.src));
    if (major.article && major.article.covers) major.article.covers.forEach(push);
    if (!pics.length) throw new Error("动态里没有图片");
    return pics.map((url, i) => ({
      kind: "opus", title: desc.slice(0, 80), url,
      headers: { Referer: "https://t.bilibili.com/" + work.ident, Origin: "https://t.bilibili.com" },
      name: renderPath(conf.opusTpl, { opus_title: desc.slice(0, 80), opus_id: work.ident, opus_order: i + 1, opus_author: author, opus_date: "" }, "jpg"),
      status: "wait",
    }));
  }

  async function buildVideoJobs(work, pages) {
    const info = await view(work.ident);
    const bvid = info.bvid; const title = work.title || info.title;
    const author = (info.owner && info.owner.name) || "";
    const date = new Date((info.pubdate || 0) * 1000).toISOString().slice(0, 10);
    const all = (info.pages || []).map((p) => ({ page: p.page, cid: p.cid, part: p.part || "" }));
    if (!all.length) throw new Error("视频没有分集信息");
    const wanted = pages && pages.length ? all.filter((p) => pages.includes(p.page)) : all;
    const jobs = [];
    // 合集变量：优先用页面上下文（合集页选中的视频），其次用视频自带的 ugc_season
    let vlInfo = work.videolist || null;
    if (!vlInfo && info.ugc_season && info.ugc_season.title) {
      const eps = [];
      for (const sec of info.ugc_season.sections || []) for (const ep of sec.episodes || []) eps.push(ep.bvid);
      const idx = eps.indexOf(bvid);
      vlInfo = { id: String(info.ugc_season.id || info.ugc_season.season_id || ""), title: info.ugc_season.title, order: idx >= 0 ? idx + 1 : 0 };
    }
    const authorUid = String((info.owner && (info.owner.mid || info.owner.uid)) || "");
    for (const pg of wanted) {
      const vars = {
        video_title: title, video_id: bvid, video_episode: pg.page,
        video_page_title: pg.part || "", video_author: author,
        video_quality: QN_NAME[conf.quality] || conf.quality, video_date: date,
        video_author_uid: authorUid,
      };
      if (vlInfo) {
        vars.videolist_title = vlInfo.title || "";
        vars.videolist_order = vlInfo.order || "";
        vars.videolist_id = vlInfo.id || "";
      }
      const nameFor = (ext, suffix) => {
        let n = renderPath(conf.videoTpl, vars, ext);
        return suffix ? n.replace(/(\.[^.\/]+)$/, "-" + suffix + "$1") : n;
      };
      const refHeaders = { Referer: "https://www.bilibili.com/video/" + bvid, Origin: "https://www.bilibili.com" };
      const partTitle = title + (pg.part ? " · " + pg.part : "");
      const extra = { bvid, cid: pg.cid, nameFor };
      const push = (label, url, name, quality, size) => {
        jobs.push({
          kind: "video", title: label ? partTitle + "（" + label + "）" : partTitle, url,
          headers: refHeaders, name, status: "wait", size: size || 0, quality, extra,
        });
      };

      // 「只下载无声视频」「只下载纯音频」是「替代普通视频」的两个开关，
      // 但两个可以同时勾（各出一份），并且都能和字幕/弹幕/封面/NFO 这些附加文件共存。
      // 以前写成 if / else if，多选时只会出一个文件；现在按勾选逐项产出。
      if (conf.exAudio || conf.exVideoMute) {
        const ds = await dashStreams(bvid, pg.cid, conf.quality).catch(() => null);
        if (conf.exAudio) {
          if (ds && ds.audio) push("音频轨", ds.audio.url, nameFor("m4a", ""), ds.quality, 0);
          else toast("取不到纯音频轨（可能需要登录），已跳过该项", 4000);
        }
        if (conf.exVideoMute) {
          if (ds && ds.video) push("无声", ds.video.url, nameFor("mp4", "mute"), ds.video.quality, 0);
          else toast("取不到无声视频轨（可能需要登录），已跳过该项", 4000);
        }
        continue;
      }

      let stream = null;
      for (const qn of [conf.quality, 80, 64, 32, 16].filter((v, i, a) => a.indexOf(v) === i && v <= conf.quality)) {
        try { stream = await playurl(bvid, pg.cid, qn); } catch (e) { if (/需要登录/.test(e.message)) throw e; }
        if (stream && stream.url) break;
      }
      if (!stream) throw new Error("取不到播放地址（可能需要登录或该清晰度不可用）");

      // 渐进式 MP4 最高只到 720P；1080P / 1080P60 只能拿 DASH 分离流，
      // 浏览器没有 ffmpeg 合不了，于是拆成「视频轨 + 音频轨」两个文件。
      if (stream.quality < conf.quality) {
        let ds = null;
        try { ds = await dashStreams(bvid, pg.cid, conf.quality); } catch (e) { ds = null; }
        if (ds && ds.video && ds.video.quality > stream.quality) {
          push("视频轨", ds.video.url, nameFor("mp4", "v"), ds.video.quality, 0);
          if (ds.audio) push("音频轨", ds.audio.url, nameFor("m4a", "a"), ds.quality, 0);
          toast("「" + (QN_NAME[conf.quality] || conf.quality) + "」需要 DASH：已下载视频轨+音频轨（浏览器无法合并，用 EXE/Docker/APK 版可直接出单文件）", 6000);
          continue;
        }
      }
      push("", stream.url, nameFor("mp4", ""), stream.quality, stream.size);
    }
    return jobs;
  }

  async function addWorks(works) {
    let n = 0;
    for (const w of works) {
      try {
        let jobs = [];
        if (w.kind === "video") jobs = await buildVideoJobs(w);
        else if (w.kind === "yt_video") jobs = await buildYouTubeJobs("https://www.youtube.com/watch?v=" + w.ident);
        else if (w.kind === "yt_channel" || w.kind === "yt_playlist") {
          const ids = await ytListVideos(w.url || w.shareUrl || location.href, 30);
          if (!ids.length) throw new Error("这个页面里没抓到视频（可能需要滚动加载，或登录后重试）");
          for (const id of ids) {
            try { jobs.push(...await buildYouTubeJobs("https://www.youtube.com/watch?v=" + id)); }
            catch (e) { pushLog("warn", "跳过 " + id + "：" + e.message); }
          }
        }
        else if (w.kind === "douyin" || w.kind === "xhs") jobs = await buildSocialJobs(w);
        else if (w.kind === "opus") jobs = await buildOpusJobs(w);
        else if (w.kind === "dynamic") jobs = await buildDynamicJobs(w);
        else if (w.kind === "article") jobs = await buildArticleJobs(w);
        else throw new Error("暂不支持的链接类型：" + w.kind);
        jobs.forEach(enqueue);
        n += jobs.length;
        toast("已加入 " + jobs.length + " 个下载：" + (w.title || w.ident).slice(0, 20));
      } catch (e) {
        toast("失败：" + (w.title || w.ident).slice(0, 14) + " · " + e.message, 4200);
        pushLog("error", (w.title || w.ident) + "：" + e.message);
      }
    }
    return n;
  }

  /* ------------------------------------------------------------ 日志 */

  const logs = [];
  function pushLog(level, text) {
    logs.unshift({ t: new Date().toLocaleTimeString(), level, text });
    if (logs.length > 120) logs.pop();
    renderQueue();
  }

  /* ---------------------------------------------------- 页面作品扫描 */

  const picked = new Map();
  // 每次打开页面都从「关闭」开始：只有用户在设置窗口里主动勾选才会出现勾选框
  let selMode = false;
  let opicSeq = 0;                     // 图文图片计数用的请求序号（必须在任何调用之前声明）
  let lastPath = location.pathname;

  function workOf(anchor) {
    // 空间「作品搜索」页的「动态」结果不是 <a>：作品链接写在 data-url 上
    const href = anchor.getAttribute("href") || anchor.getAttribute("data-url") || "";
    let abs = href;
    try { abs = new URL(href, location.href).href; } catch (e) { abs = href.startsWith("//") ? "https:" + href : href; }
    const w = classify(abs);
    if (!w) return w;
    // 抖音 / 小红书：把绝对地址带下去（小红书批量推送时 xsec_token 必须原样保留）
    w.url = abs;
    // 文集页：给每篇文章补上「文集 id / 标题 / 序号」，下载时才能按文集规则命名
    const rl = location.pathname.match(/\/read\/readlist\/(rl\d+)/i);
    if (rl) {
      const id = rl[1];
      let title = String(document.title || "").replace(/\s*-\s*哔哩哔哩.*$/, "").trim();
      const h = document.querySelector(".read-list-title, .read-list__title, h1");
      if (h && h.textContent.trim()) title = h.textContent.trim();
      const cards = [...document.querySelectorAll("a[href*='/read/cv']")];
      const idx = cards.indexOf(anchor);
      w.readlist = { id, title, order: idx >= 0 ? idx + 1 : 0 };
    }
    // 合集页（space.bilibili.com/<uid>/lists/<id>）：补上合集 id/标题/序号
    const vl = location.pathname.match(/\/lists\/(\d{3,})/i);
    if (vl) {
      const vtitle = (() => {
        const h = document.querySelector(".list-title, .detail-header h1, h1");
        if (h && h.textContent.trim()) return h.textContent.trim();
        return String(document.title || "").replace(/\s*-\s*哔哩哔哩.*$/, "").trim();
      })();
      const cards = [...document.querySelectorAll("a[href*='/video/BV']")];
      const idx = cards.indexOf(anchor);
      w.videolist = { id: vl[1], title: vtitle, order: idx >= 0 ? idx + 1 : 0 };
    }
    return w;
  }

  // 一张卡片里可能有「封面链接 + 标题链接」指向同一个作品，也可能（列表页）塞了好几篇：
  // 用「不同作品 key 的数量」判断，而不是链接个数
  const CARD_LINK_SEL = 'a[href*="/opus/"], a[href*="/video/BV"], a[href*="/read/cv"], a[href*="/video/"], a[href*="/note/"], a[href*="/explore/"], a[href*="/discovery/item/"]';

  function distinctKeysIn(el) {
    const set = new Set();
    el.querySelectorAll(CARD_LINK_SEL).forEach((x) => {
      const w = workOf(x);
      if (w) set.add(w.kind + ":" + w.ident);
    });
    return set;
  }

  function cardRootOf(anchor) {
    const hit = anchor.closest(".opus-card, .bili-video-card, .bili-dyn-card-opus, .bili-dyn-list__item, section.note-item, li.note-item");
    if (hit) return hit;
    let el = anchor.parentElement;
    for (let i = 0; i < 9 && el; i++) {
      const w = el.getBoundingClientRect().width;
      if (el.tagName !== "A" && w > 90 && w < window.innerWidth * 0.92 && distinctKeysIn(el).size === 1) return el;
      el = el.parentElement;
    }
    return anchor.parentElement;
  }

  function cardTitleOf(root) {
    const t = root.querySelector(".dyn-card-opus__title, .bili-dyn-card-video__title, .opus-card__title, .bili-video-card__title, .bili-video-card__info--tit, h3[title], .title");
    let s = (t && (t.getAttribute("title") || t.textContent)) || "";
    if (!s.trim()) {
      // 搜索页动态卡：标题为空时用正文首行（“X@xxx 翻译…”），别把 UP 主昵称当标题
      const sum = root.querySelector(".dyn-card-opus__summary");
      if (sum) s = (sum.innerText || sum.textContent || "").split("\n").map((x) => x.trim()).find(Boolean) || "";
    }
    if (!s.trim()) s = root.textContent || "";
    return s.replace(/\s+/g, " ").trim().slice(0, 120);
  }

  // 动态卡没有 <a>，只能从 data-url 找外层卡片
  function dataCardRootOf(el) {
    return el.closest(
      ".dyn-card-opus, .bili-dyn-card-opus, .bili-dyn-content__orig__major, .dynamic-list__item, .bili-dyn-list__item, .bili-dyn-item"
    );
  }

  // 动态卡里挑「封面」容器挂勾选框：优先相册/封面，找不到就用作品卡本身
  function dataThumbOf(root) {
    return (
      root.querySelector(".bili-album__preview") ||
      root.querySelector(".bili-cover-card") ||
      root.querySelector(".dyn-card-opus__pics") ||
      root.querySelector(".dyn-card-opus") ||
      root
    );
  }

  // 缩略图容器：勾选框只挂这里 → 永远在缩略图左上角，不压标题
  function thumbOf(anchor, root) {
    // 抖音 / 小红书：封面就是勾选框的宿主，直接用它（不再往上找可能含标题的容器）
    if (/douyin\.com|xiaohongshu\.com|rednote\.com/.test(location.hostname) || (root.closest && root.closest("section.note-item, li.note-item"))) {
      // 小红书卡片里第一个 <a> 可能是标题链接，封面要靠卡内的 a.cover / img 找
      const imgs = root.querySelector("img");
      const cv =
        (anchor.querySelector("img") && anchor) ||
        anchor.closest("a.cover, a.mask") ||
        root.querySelector("a.cover, a.mask") ||
        (imgs && imgs.parentElement) ||
        root;
      return cv;
    }
    const a = anchor.closest("a.bili-cover-card, a.opus-card__cover") || anchor;
    const ar = a.getBoundingClientRect();
    const covers = (el) => !!el && (el === a || el.contains(a)) && el !== root;
    let t = a.parentElement;
    if (!covers(t) || t.getBoundingClientRect().height > Math.max(ar.height * 1.8, 120)) {
      t = ar.width > 60 ? a : null;
    }
    if (t && t.getBoundingClientRect().width < 60) t = null;
    return t;
  }

  // 小红书：同一张卡片里「封面链接」带 xsec_token、「标题链接」不带。
  // 先看卡内链接，再查整页索引（卡片里可能只渲染了标题链接）。
  let _xhsHrefCache = { at: 0, map: new Map() };
  function xhsTokenHrefMap() {
    if (Date.now() - _xhsHrefCache.at < 8000) return _xhsHrefCache.map;
    const map = new Map();
    document.querySelectorAll('a[href*="xsec_token="]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/(?:explore|discovery\/item)\/([0-9a-f]{20,32})[^#]*?[?&]xsec_token=([^&]+)/i);
      if (m && !map.has(m[1])) map.set(m[1], { href, token: decodeURIComponent(m[2]) });
    });
    _xhsHrefCache = { at: Date.now(), map };
    return map;
  }

  function preferXhsUrl(root, url, ident) {
    if (/[?&]xsec_token=/.test(url || "")) return url;
    // 只认「同一篇笔记」的链接，避免把作者主页链接上的 token 当成笔记 token
    let best = "";
    if (root && root.querySelectorAll) {
      root.querySelectorAll('a[href*="xsec_token="]').forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (!href.includes(ident)) return;
        const m = href.match(/[?&]xsec_token=([^&]+)/);
        if (m && !best) best = m[1];
      });
    }
    if (best) return "https://www.xiaohongshu.com/explore/" + ident + "?xsec_token=" + best + "&xsec_source=pc_feed";
    const hit = xhsTokenHrefMap().get(ident);
    if (hit) {
      try {
        const u = new URL(hit.href, location.href);
        if (!/[?&]xsec_token=/.test(u.search)) u.searchParams.set("xsec_token", hit.token);
        if (!u.searchParams.get("xsec_source")) u.searchParams.set("xsec_source", "pc_feed");
        return u.href;
      } catch (e) {}
    }
    return url || ("https://www.xiaohongshu.com/explore/" + ident);
  }

  function scanCards() {
    const roots = new Map();
    const seenKey = new Set();
    const linkSel = 'a.bili-cover-card[href], a[href*="/opus/"], a[href*="/video/BV"], a[href*="/read/cv"], a[href*="/video/"], a[href*="/note/"], a[href*="/explore/"], a[href*="/discovery/item/"]';
    const dataSel = '[data-url*="/opus/"], [data-url*="/video/BV"], [data-url*="/read/cv"]';
    // 动态（空间搜索页的「动态」结果、动态 tab）用 data-url，视频/图文卡片用 <a href>，两者都要扫
    const anchors = document.querySelectorAll(linkSel + ", " + dataSel);
    anchors.forEach((a) => {
      const w = workOf(a);
      if (!w) return;
      const isLink = a.tagName === "A";
      let root = isLink ? cardRootOf(a) : dataCardRootOf(a);
      if (!root) return;
      if (isLink) {
        // 列表页（文集/列表）里多篇文章共用一个容器时，以链接自身为卡片，避免几个作品共用一个勾选框；
        // 普通视频卡里「封面链接 + 标题链接」指向同一个作品，不能因此退化成链接本身（否则标题会变成播放量）
        const innerKeys = new Set();
        root.querySelectorAll(linkSel).forEach((x) => {
          const w2 = workOf(x);
          if (w2) innerKeys.add(w2.kind + ":" + w2.ident);
        });
        if (innerKeys.size > 1) {
          root = a.closest("a") || a;
          // 这种「一个链接就是一张卡」的列表页，勾选框挂在它自己的封面上
          const img = root.querySelector("img");
          root._bilidlThumb = img ? img.parentElement : root;
        }
      }
      const key = w.kind + ":" + w.ident;
      if (w.kind === "xhs") w.url = preferXhsUrl(root, w.url, w.ident);
      // 同一作品只保留一张卡（封面链接和标题链接会命中同一个作品）
      if (seenKey.has(key)) return;
      seenKey.add(key);
      root.dataset.bilidlKey = key;
      root.dataset.bilidlKind = w.kind;
      root.dataset.bilidlIdent = w.ident;
      root.dataset.bilidlUrl = w.url || "";
      root.dataset.bilidlTitle = cardTitleOf(root);
      if (!root._bilidlThumb) {
        if (isLink) {
          // 优先用封面链接算缩略图（先命中的可能是标题链接，算出来会落在标题上）
          const coverA = root.querySelector("a.bili-cover-card, a.opus-card__cover") || a;
          root._bilidlThumb = thumbOf(coverA, root);
        } else {
          root._bilidlThumb = dataThumbOf(root);
        }
      }
      roots.set(root, w);
    });
    // 小红书用户主页/话题页：卡片的封面链接指向 /user/profile/<id>/，笔记 id 只在 data-note-id
    // 或一个隐藏的 /explore/ 链接里（要滚动懒加载后才填），这里按卡片再扫一遍补上
    const tokenMap = xhsTokenMap();
    document.querySelectorAll("section.note-item, .note-item, [data-note-id]").forEach((card) => {
      const id = xhsNoteIdOf(card);
      if (!id) return;
      const key = "xhs:" + id;
      const token = xhsTokenOf(card, tokenMap);
      const url = preferXhsUrl(card, "https://www.xiaohongshu.com/explore/" + id +
        (token ? "?xsec_token=" + encodeURIComponent(token) + "&xsec_source=pc_user" : ""), id);
      if (seenKey.has(key)) {
        const hit = [...roots.entries()].find(([, w]) => w.kind === "xhs" && w.ident === id);
        if (hit && /[?&]xsec_token=/.test(url)) hit[1].url = url, hit[1].shareUrl = url, (hit[0].dataset.bilidlUrl = url);
        return;
      }
      seenKey.add(key);
      const title = cardTitleOf(card);
      card.dataset.bilidlKey = key;
      card.dataset.bilidlKind = "xhs";
      card.dataset.bilidlIdent = id;
      card.dataset.bilidlUrl = url;
      card.dataset.bilidlTitle = title;
      if (!card._bilidlThumb) {
        card._bilidlThumb = card.querySelector("a.cover, a.mask, a[href*=\"xsec_token=\"]") || card;
      }
      roots.set(card, { kind: "xhs", ident: id, token, url, shareUrl: url, social: true });
    });
    // YouTube：搜索结果 / 频道 / 播放列表 / 首页 / 侧栏推荐的卡片（新旧两套布局都要认）
    if (/youtube\.com$|youtu\.be$/i.test(location.hostname)) {
      ytCardList().forEach((c) => {
        const key = "yt_video:" + c.id;
        if (roots.has(c.root)) return;
        c.root.dataset.bilidlKey = key;
        c.root.dataset.bilidlKind = "yt_video";
        c.root.dataset.bilidlIdent = c.id;
        c.root.dataset.bilidlUrl = c.url;
        c.root.dataset.bilidlTitle = c.title || c.id;
        if (!c.root._bilidlThumb) c.root._bilidlThumb = c.thumb || c.root;
        roots.set(c.root, { kind: "yt_video", ident: c.id, title: c.title || c.id, url: c.url, shareUrl: c.url });
      });
    }
    return roots;
  }

  // YouTube 卡片扫描：YouTube 的列表页有一堆不同的渲染器名字，这里统一收口。
  // 只认「卡片里同时有缩略图和标题」的，避免把播放器本身或推荐位的窄条当成作品。
  function ytCardList() {
    const out = [];
    const sel = [
      "ytd-rich-item-renderer", "ytd-grid-video-renderer", "ytd-video-renderer",
      "ytd-compact-video-renderer", "ytd-playlist-video-renderer",
      "ytd-playlist-video-item-renderer", "yt-lockup-view-model",
      "ytd-reel-item-renderer", "ytd-rich-grid-media",
    ].join(",");
    const seen = new Set();
    document.querySelectorAll(sel).forEach((root) => {
      if (!root.querySelector("img")) return;
      const a = root.querySelector('a[href*="watch?v="], a[href*="/shorts/"]');
      if (!a) return;
      const href = a.getAttribute("href") || "";
      const m = href.match(/[?&]v=([0-9A-Za-z_-]{11})/) || href.match(/\/shorts\/([0-9A-Za-z_-]{11})/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      const t = root.querySelector("#video-title, a#video-title-link, #video-title-link, h3 a, h3, .yt-lockup-metadata-view-model__title, [title]");
      let title = t ? (t.getAttribute("title") || t.textContent || "").trim() : "";
      if (!title) title = (a.getAttribute("title") || "").trim();
      const thumb = root.querySelector("ytd-thumbnail, yt-thumbnail-view-model, a#thumbnail, .yt-lockup-view-model__content-image, .ytThumbnailViewModelImage, img") || root;
      out.push({ root, thumb: thumb.closest("a#thumbnail, yt-thumbnail-view-model, ytd-thumbnail, .yt-lockup-view-model__content-image") || thumb, id, title, url: "https://www.youtube.com/watch?v=" + id });
    });
    return out;
  }

  // 小红书：从页面 __INITIAL_STATE__ 里收集 noteId -> xsecToken（用户主页的卡片常常没有可见的笔记链接）
  let _xhsTokenCache = { at: 0, map: new Map() };
  function xhsTokenMap() {
    if (Date.now() - _xhsTokenCache.at < 8000) return _xhsTokenCache.map;
    const map = new Map();
    let seen = 0;
    const walk = (o, d) => {
      if (!o || typeof o !== "object" || d > 7 || seen > 20000) return;
      seen++;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, d + 1)); return; }
      const id = o.noteId || o.note_id || o.id;
      const tk = o.xsecToken || o.xsec_token;
      if (typeof id === "string" && typeof tk === "string" && /^[0-9a-f]{20,32}$/i.test(id)) map.set(id, tk);
      Object.keys(o).forEach((k) => walk(o[k], d + 1));
    };
    try { walk(pageInitialState(), 0); } catch (e) {}
    _xhsTokenCache = { at: Date.now(), map };
    return map;
  }

  function xhsNoteIdOf(card) {
    const direct = card.getAttribute("data-note-id") || "";
    if (/^[0-9a-f]{20,32}$/i.test(direct)) return direct;
    const a = card.querySelector('a[href*="/explore/"], a[href*="/discovery/item/"]');
    const m = a && (a.getAttribute("href") || "").match(/\/(?:explore|discovery\/item)\/([0-9a-f]{20,32})/i);
    return m ? m[1] : "";
  }

  function xhsTokenOf(card, map) {
    const a = card.querySelector('a[href*="xsec_token="]');
    if (a) {
      const m = (a.getAttribute("href") || "").match(/[?&]xsec_token=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return map.get(xhsNoteIdOf(card)) || "";
  }

  function isPicked(key) { return picked.has(key); }

  function togglePick(card) {
    const key = card.dataset.bilidlKey;
    if (!key) return;
    if (picked.has(key)) { picked.delete(key); card.classList.remove("bilidl-sel"); }
    else {
      picked.set(key, {
        kind: card.dataset.bilidlKind, ident: card.dataset.bilidlIdent,
        title: card.dataset.bilidlTitle || "", url: card.dataset.bilidlUrl || "",
      });
      card.classList.add("bilidl-sel");
    }
    syncSel();
  }

  function clearPicked() {
    picked.clear();
    document.querySelectorAll(".bilidl-sel").forEach((e) => e.classList.remove("bilidl-sel"));
    document.querySelectorAll(".bilidl-ov-on").forEach((e) => { e.classList.remove("bilidl-ov-on"); });
    syncSel();
  }

  function mountOverlays() {
    if (!selMode) return;
    if (window.__bilidlOvOwner && window.__bilidlOvOwner !== "standalone") return;
    if (!window.__bilidlOvOwner) {
      window.__bilidlOvOwner = "standalone";
      document.querySelectorAll(".bilidl-ov").forEach((b) => b.remove());
    }
    scanCards().forEach((w, card) => {
      card.classList.add("bilidl-hit");
      const host = card._bilidlThumb;
      if (!host) return;
      if (!host._bilidlPos) {
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        host._bilidlPos = true;
      }
      host.querySelectorAll(":scope > .bilidl-ov").forEach((b) => b.remove());
      const box = document.createElement("span");
      box.className = "bilidl-ov";
      box.dataset.key = card.dataset.bilidlKey;
      box.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePick(card); });
      host.appendChild(box);
      const on = picked.has(card.dataset.bilidlKey);
      box.classList.toggle("bilidl-ov-on", on);
      card.classList.toggle("bilidl-sel", on);
    });
    // 清掉重复 / 过期的勾选框：同一作品只留一个
    const keys = new Set([...scanCards().keys()].map((c) => c.dataset.bilidlKey));
    const kept = new Set();
    document.querySelectorAll(".bilidl-ov").forEach((b) => {
      const k = b.dataset.key || ((b.parentElement && b.parentElement.closest("[data-bilidl-key]") || {}).dataset || {}).bilidlKey || "";
      if (!k || !keys.has(k) || kept.has(k) || !b.isConnected) { b.remove(); return; }
      kept.add(k);
    });
    syncSel();
  }

  function clearOverlays() {
    document.querySelectorAll(".bilidl-ov").forEach((e) => e.remove());
    document.querySelectorAll(".bilidl-hit").forEach((e) => e.classList.remove("bilidl-hit"));
    document.querySelectorAll(".bilidl-sel").forEach((e) => e.classList.remove("bilidl-sel"));
  }

  function syncSel() {
    try {
      const b = $("#bilidl-sa-send");
      if (b && !b.dataset.busy) { b.disabled = picked.size === 0; if (/解析中/.test(b.textContent)) b.textContent = "发送下载"; }
    } catch (e) {}
    const n = picked.size;
    const bar = $("#bilidl-sa-selbar");
    if (bar) {
      bar.style.display = selMode && (n || document.querySelector(".bilidl-ov")) ? "flex" : "none";
      const txt = $("#bilidl-sa-selcount");
      if (txt) {
        const items = [...picked.values()];
        const v = items.filter((x) => x.kind === "video" || x.kind === "yt_video" || x.kind === "youtube").length;
        const dy = items.filter((x) => x.kind === "douyin").length;
        const xhs = items.filter((x) => x.kind === "xhs").length;
        const other = n - v - dy - xhs;
        let detail = "";
        if (v) detail += " / 视频 " + v;
        if (other) detail += " / 图文 " + other;
        if (dy) detail += " / 抖音 " + dy;
        if (xhs) detail += " / 小红书 " + xhs;
        txt.textContent = "已选 " + n + " 个" + (detail ? "（" + detail.slice(3) + "）" : "");
      }
      const send = $("#bilidl-sa-send");
      if (send) send.disabled = n === 0;
    }
    const tip = $("#bilidl-sa-tip");
    if (tip) tip.style.display = selMode && document.querySelector(".bilidl-ov") ? "flex" : "none";
  }

  document.addEventListener("click", (e) => {
    if (!selMode) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest("#bilidl-sa-panel, #bilidl-sa-selbar, #bilidl-sa-tip, #bilidl-sa-toast")) return;
    if (t.classList.contains("bilidl-ov")) {
      e.preventDefault();
      return;
    }
    const card = t.closest("[data-bilidl-key]");
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    togglePick(card);
  }, true);

  let mountTimer = 0;
  function scheduleMount() {
    // 不能每次事件都重置计时器：抖音页面 MutationObserver 触发极频繁，纯防抖会被饿死，
    // 勾选框永远挂不上。这里改成「最多 250ms 一次」的节流。
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = 0;
      if (selMode) mountOverlays();
    }, 250);
  }

  refreshOpusCount();
  setTimeout(refreshOpusCount, 2500);
  new MutationObserver(() => { if (selMode) scheduleMount(); }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", () => { if (selMode) scheduleMount(); }, { passive: true });
  // ---- 当前图文 / 专栏的图片总数 ----
  function opicHost() {
    let el = document.getElementById("bilidl-sa-opic");
    if (el) return el;
    el = document.createElement("div");
    el.id = "bilidl-sa-opic";
    el.title = "当前图文/专栏的图片总数";
    el.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.6-4.2a2 2 0 0 1 2.7 0L20 20"/></svg>' +
      '<span class="n">0</span><span class="t">张图</span>';
    document.body.appendChild(el);
    return el;
  }
  function opicCountFromModules(mods) {
    let n = 0;
    for (const mo of mods || []) {
      // 新版图文（如 /opus/1262380051833290755）把相册放在 MODULE_TYPE_TOP，
      // 正文 module_content 里只有文字/表情，不能只数 paragraphs。
      if (mo && mo.module_type === "MODULE_TYPE_TOP") {
        const album = mo.module_top && mo.module_top.display && mo.module_top.display.album;
        if (album && Array.isArray(album.pics)) n += album.pics.length;
      }
      const ps = (mo && mo.module_content && mo.module_content.paragraphs) || [];
      for (const p of ps) {
        if (!p) continue;
        if (p.para_type === 2 && p.pic && Array.isArray(p.pic.pics)) n += p.pic.pics.length;
        if (p.para_type === 1 && p.text && Array.isArray(p.text.pics)) n += p.text.pics.length;
      }
    }
    return n;
  }
  function opicCountFromDom(isCv) {
    const sel = isCv
      ? ".article-holder img, #read-article-holder img, .article-content img, .opus-module-content img, .opus-module-top img"
      : ".opus-module-content img, .opus-module-top img, .horizontal-scroll-album img, .bili-album img, .opus-module-content .album img, .opus-card img";
    // B站 的图文页会把同一张图渲染两遍（SSR + 前端 hydration），所以必须按图片地址去重，
    // 否则 10 张图会数成 20 张。这里同时剥掉 @480w_1c 这类缩放后缀。
    // 正文里的 /bfs/emote/ 是文字表情，不是投稿图，不能计入。
    const seen = new Set();
    Array.from(document.querySelectorAll(sel)).forEach((i) => {
      const raw = i.currentSrc || i.src || i.getAttribute("data-src") || "";
      if (!/hdslb\.com\/bfs\//.test(raw)) return;
      if (/\/bfs\/(?:emote|face|garb|pendant|banner|small_dynamic_cover)\//.test(raw)) return;
      seen.add(raw.split("@")[0].split("?")[0]);
    });
    return seen.size;
  }
  async function refreshOpusCount() {
    // 两个脚本同时装时只留一个计数气泡
    if (window.__bilidlOpicOwner && window.__bilidlOpicOwner !== "sa") {
      const mine = document.getElementById("bilidl-sa-opic"); if (mine) mine.style.display = "none";
      return;
    }
    window.__bilidlOpicOwner = "sa";
    const mOpus = location.pathname.match(/\/opus\/(\d{6,})/);
    const mCv = location.pathname.match(/\/read\/cv(\d{1,12})/);
    const box = document.getElementById("bilidl-sa-opic");
    if (!mOpus && !mCv) { if (box) box.style.display = "none"; return; }
    const seq = ++opicSeq;
    let n = opicCountFromDom(!!mCv);          // 先数页面上真实渲染出来的图（最准，且不受接口风控影响）
    if (!n && mOpus) {                         // 页面还没渲染时，退回接口
      try {
        const r = await fetch("https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=" + mOpus[1], { credentials: "include" });
        const txt = await r.text();
        if (txt.trim().startsWith("{")) {
          const j = JSON.parse(txt);
          n = opicCountFromModules((j && j.data && j.data.item && j.data.item.modules) || []);
        }
      } catch (e) {}
    }
    if (seq !== opicSeq) return;
    const el = opicHost();
    el.style.display = n > 0 ? "inline-flex" : "none";
    el.querySelector(".n").textContent = String(n);
  }

  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; picked.clear(); scheduleMount(); refreshOpusCount(); }
  }, 1200);

  /* ------------------------------------------------------------ 登录 */

  let navCache = null;

  async function refreshLogin(show) {
    try {
      const d = await nav();
      navCache = d;
      const txt = $("#bilidl-sa-login");
      if (txt) {
        txt.textContent = d.isLogin ? "已登录：" + (d.uname || "") + "（" + (d.vipStatus === 1 ? "大会员" : "普通") + "）" : "未登录（只能下载 720P 以下）";
        txt.className = "sa-login " + (d.isLogin ? "ok" : "warn");
      }
      return d;
    } catch (e) {
      if (show) toast("登录状态检查失败：" + e.message);
      return null;
    }
  }

  function applyCookie(text) {
    const raw = String(text || "").trim();
    if (!raw) return 0;
    let pairs = [];
    if (raw.startsWith("{")) {
      try {
        const j = JSON.parse(raw);
        const arr = j.cookies || j;
        if (Array.isArray(arr)) pairs = arr.map((c) => [c.name || c.Name, c.value || c.Value]);
      } catch (e) {}
    }
    if (!pairs.length) {
      pairs = raw.split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((s) => {
        const i = s.indexOf("=");
        return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : null;
      }).filter(Boolean);
    }
    let n = 0;
    for (const [k, v] of pairs) {
      if (!k) continue;
      try {
        document.cookie = k + "=" + v + "; domain=.bilibili.com; path=/; max-age=15552000; secure";
        n++;
      } catch (e) {}
    }
    return n;
  }

  function qrLogin() {
    const w = window.open("https://passport.bilibili.com/login?gourl=" + encodeURIComponent(location.href), "bilidl_login", "width=460,height=620");
    if (!w) { toast("弹出窗被拦截，请允许弹窗后重试"); return; }
    toast("请在弹出窗口用 B 站 App 扫码，登录后会自动检测");
    let n = 0;
    const timer = setInterval(async () => {
      n++;
      const d = await refreshLogin(false);
      if (d && d.isLogin) {
        clearInterval(timer);
        try { w.close(); } catch (e) {}
        toast("登录成功：" + (d.uname || ""));
        renderPanel();
      } else if (n > 150) clearInterval(timer);
    }, 2000);
  }

  function logout() {
    ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"].forEach((k) => {
      document.cookie = k + "=; domain=.bilibili.com; path=/; max-age=0";
    });
    toast("已清除登录 Cookie");
    setTimeout(() => refreshLogin(true), 500);
  }

  /* ------------------------------------------------------------ 面板 */

  let panelBuilt = false;

  function buildPanel() {
    if (panelBuilt) return;
    panelBuilt = true;
    const qopt = QUALITY.map(([n, v]) => `<option value="${v}"${v === conf.quality ? " selected" : ""}>${n}</option>`).join("");
    const wrap = document.createElement("div");
    wrap.id = "bilidl-sa-wrap";
    setHtml(wrap, `
      <div id="bilidl-sa-fab" title="BiliDL 独立版">⬇</div>
      <div id="bilidl-sa-tip">选择模式已开：点卡片或缩略图选中（B站 / 抖音 / 小红书 / YouTube），底部条「发送下载」</div>
      <div id="bilidl-sa-selbar">
        <span id="bilidl-sa-selcount">已选 0 个</span>
        <button id="bilidl-sa-selall" class="ghost">全选本页</button>
        <button id="bilidl-sa-selclear" class="ghost">清空</button>
        <button id="bilidl-sa-send">发送下载</button>
      </div>
      <div id="bilidl-sa-panel">
        <div class="sa-head"><b>BiliDL 独立版</b><span id="bilidl-sa-ver">v1.9.1</span><button id="bilidl-sa-close" class="ghost">×</button></div>

        <div class="sa-sec">
          <div class="sa-h">账号</div>
          <div id="bilidl-sa-login" class="sa-login warn">未登录（只能下载 720P 以下）</div>
          <div class="sa-row">
            <button id="bilidl-sa-qr">B站 App 扫码登录</button>
            <button id="bilidl-sa-check" class="ghost">刷新状态</button>
            <button id="bilidl-sa-logout" class="ghost">退出登录</button>
          </div>
          <textarea id="bilidl-sa-cookie" rows="2" placeholder="手动粘贴 Cookie，例如 SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx"></textarea>
          <div class="sa-row"><button id="bilidl-sa-cookiebtn">用 Cookie 登录</button><span class="sa-note">只写进本机浏览器 Cookie，不上传</span></div>
        </div>

        <div class="sa-sec">
          <div class="sa-h">下载设置</div>
          <div class="sa-l" style="margin-top:8px">下载哪些文件（可多选，默认正常有声视频）</div>
          <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:12px;margin-bottom:6px">
            <label><input type="checkbox" id="bilidl-sa-exaudio" /> 纯音频</label>
            <label><input type="checkbox" id="bilidl-sa-exmute" /> 无声视频</label>
            <label><input type="checkbox" id="bilidl-sa-exsub" /> 字幕SRT</label>
            <label><input type="checkbox" id="bilidl-sa-exdm" /> 弹幕SRT</label>
            <label><input type="checkbox" id="bilidl-sa-excover" /> 封面</label>
            <label><input type="checkbox" id="bilidl-sa-exnfo" /> NFO</label>
          </div>
          <label class="sa-l">清晰度<select id="bilidl-sa-quality">${qopt}</select></label>
          <label class="sa-l">下载子目录（浏览器默认下载目录下）<input id="bilidl-sa-subdir" type="text" value="${esc(conf.subDir)}" placeholder="BiliDL"></label>
          <label class="sa-l">视频重命名规则<textarea id="bilidl-sa-vtpl" rows="2">${esc(conf.videoTpl)}</textarea></label>
          <div class="sa-note">变量：&lt;video_title&gt; 视频标题 · &lt;video_id&gt; 视频ID（B站BV号 / 抖音作品ID / 小红书笔记ID） · &lt;video_episode&gt; 分集序号（抖音/小红书固定 1） · &lt;video_page_title&gt; 分集标题 · &lt;video_author&gt; 作者昵称 · &lt;video_author_uid&gt; 作者UID · &lt;video_quality&gt; 清晰度 · &lt;video_date&gt; 日期 · &lt;videolist_title&gt; 合集标题 · &lt;videolist_order&gt; 合集内序号 · &lt;videolist_id&gt; 合集ID · &lt;ext&gt; 扩展名（不在合集时 videolist 三项自动忽略；写 / 可建子文件夹）</div>
          <label class="sa-l">图文重命名规则<textarea id="bilidl-sa-otpl" rows="2">${esc(conf.opusTpl)}</textarea></label>
          <label class="sa-l">文集重命名规则<textarea id="bilidl-sa-rtpl" rows="2">${esc(conf.readlistTpl || DEFAULTS.readlistTpl)}</textarea></label>
          <div class="sa-note">文集变量：&lt;readlist_title&gt; 文集标题 · &lt;readlist_order&gt; 文集内文章序号 · &lt;readlist_id&gt; 文集ID（rl…），另外沿用 &lt;opus_title&gt;/&lt;opus_id&gt;/&lt;opus_order&gt;/&lt;ext&gt;；写 / 可建子文件夹</div>
            <label class="sa-l" style="display:flex;align-items:center;gap:8px"><input type="checkbox" id="bilidl-sa-gmsave" ${conf.gmSave ? "checked" : ""}> 用 GM_download 保存小文件（规则里的 / 才能建子目录；个别环境会弹新标签）</label>
          <div class="sa-note">变量：&lt;opus_title&gt; 标题 · &lt;opus_id&gt; 作品ID（B站图文 / 抖音作品ID / 小红书笔记ID） · &lt;opus_order&gt; 图片序号 · &lt;opus_author&gt; 作者 · &lt;opus_date&gt; 日期 · &lt;ext&gt; 扩展名。抖音/小红书图文同样用这套规则；规则里写 <b>/</b> 会在子目录下再建文件夹。</div>
          <label class="sa-l">评论/动态图片重命名规则<textarea id="bilidl-sa-ctpl" rows="2">${esc(cmtTpl)}</textarea></label>
          <div class="sa-note">变量：&lt;author&gt; 评论者/主播昵称 · &lt;video_id&gt; 视频BV号 · &lt;comment_id&gt; 评论id · &lt;order&gt; 图片序号 · &lt;ext&gt; 扩展名。默认 &lt;author&gt;-&lt;video_id&gt;-&lt;comment_id&gt;-&lt;order&gt;.&lt;ext&gt;。</div>
          <label class="sa-l">同时下载数<input id="bilidl-sa-conc" type="number" min="1" max="4" value="${conf.concurrency}"></label>
          <label class="sa-l">每个文件之间的间隔（毫秒）<input id="bilidl-sa-interval" type="number" min="0" max="20000" step="100" value="${conf.interval}"></label>
          <div class="sa-row"><button id="bilidl-sa-save">保存设置</button>
          <button id="bilidl-sa-reset">恢复默认</button><span class="sa-note">浏览器只能存到默认下载目录，子目录用文件名前缀实现</span></div>
        </div>

        <div class="sa-sec">
          <div class="sa-h">页面多选</div>
          <label class="sa-tgl"><input id="bilidl-sa-selmode" type="checkbox"> 开启多选模式（点缩略图即选中）</label>
          <div class="sa-note">B站 / 抖音 / 小红书 / YouTube 都支持：主页、发现页、用户空间、搜索结果、视频页右侧推荐、YouTube 搜索/频道/播放列表里的卡片都会出现勾选框，点封面即选中（不跳转），再点「发送下载」。默认关闭，不影响正常浏览。</div>
        </div>

        <div class="sa-sec">
          <div class="sa-h">当前页面</div>
          <div class="sa-row"><button id="bilidl-sa-cur" class="primary">下载本页作品</button><span class="sa-note" id="bilidl-sa-curnote">自动识别本页的视频 / 图文 / 专栏 / 抖音 / 小红书 / YouTube 视频</span></div>
        </div>

        <div class="sa-sec">
          <div class="sa-h">粘贴链接下载</div>
          <textarea id="bilidl-sa-links" rows="2" placeholder="每行一个：B站视频 / opus / 专栏 / b23.tv 短链 / 抖音分享链接 / 小红书分享链接（带 xsec_token）/ YouTube"></textarea>
          <div class="sa-row"><button id="bilidl-sa-linkgo">解析并下载</button><span class="sa-note">支持一次多条</span></div>
        </div>

        <div class="sa-sec">
          <div class="sa-h">队列 <span id="bilidl-sa-qstat" class="sa-note"></span></div>
          <div id="bilidl-sa-queue" class="sa-q"></div>
          <div class="sa-row"><button id="bilidl-sa-pause" class="ghost">暂停</button><button id="bilidl-sa-cancelall" class="ghost">取消全部</button><button id="bilidl-sa-clearq" class="ghost">清除已完成</button><button id="bilidl-sa-retry" class="ghost">重试失败</button></div>
        </div>

        <div class="sa-sec">
          <div class="sa-h">日志</div>
          <div id="bilidl-sa-logs" class="sa-q"></div>
        </div>
      </div>`);
    document.body.appendChild(wrap);
    const verEl = wrap.querySelector("#bilidl-sa-ver");
    if (verEl) verEl.textContent = "v" + ((typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.9.1");

    // 关键样式也写死在元素上：B站 页面若拦掉 <style> 或压 z-index，面板照样能弹出来
    const saFab = $("#bilidl-sa-fab");
    const saPanel = $("#bilidl-sa-panel");
    Object.assign(saFab.style, { position: "fixed", right: "14px", bottom: "16px", width: "40px", height: "40px",
      borderRadius: "50%", background: "#fb7299", color: "#fff", border: "0", cursor: "pointer", fontSize: "18px",
      lineHeight: "40px", textAlign: "center", opacity: ".85", zIndex: "2147483000", padding: "0",
      boxShadow: "0 4px 14px rgba(0,0,0,.35)" });
    Object.assign(saPanel.style, { position: "fixed", right: "14px", bottom: "64px", width: "372px",
      maxWidth: "92vw", maxHeight: "76vh", overflow: "auto", background: "#171c24", color: "#e6edf3",
      border: "1px solid #2b3442", borderRadius: "14px", padding: "14px", display: "none",
      zIndex: "2147483001", boxShadow: "0 18px 50px rgba(0,0,0,.5)", fontSize: "13px", lineHeight: "1.6",
      boxSizing: "border-box" });

    let saPanelWanted = false;
    function setSaPanel(open) {
      const want = typeof open === "boolean" ? open : !saPanel.classList.contains("on");
      saPanelWanted = want;
      saPanel.classList.toggle("on", want);
      saPanel.style.display = want ? "block" : "none";
      if (want) { try { renderPanel(); refreshLogin(false); } catch (e) { console.warn("[BiliDL] 面板渲染失败", e); } }
    }

    // 一次真实点击会同时触发 mousedown 兜底和 click，如果两边都 toggle 就会「打开后立刻关闭」。
    // 统一走这个去抖的开关。
    let lastFabAt = 0;
    function toggleSaPanel() {
      const now = Date.now();
      if (now - lastFabAt < 400) return;
      lastFabAt = now;
      setSaPanel();
    }
    saFab.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleSaPanel(); });
    ["mousedown", "pointerdown"].forEach((ev) => {
      document.addEventListener(ev, (e) => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest("#bilidl-sa-fab")) {
          try { e.stopPropagation(); } catch (err) {}
          if (ev === "mousedown") toggleSaPanel();
        }
      }, true);
    });
    try {
      window.__bilidlSA = window.__bilidlSA || {};
      window.__bilidlSA.version = "1.2.7";
      window.__bilidlSA.openPanel = () => setSaPanel(true);
      window.__bilidlSA.closePanel = () => setSaPanel(false);
      window.__bilidlSA.state = () => ({ cls: saPanel.className, display: saPanel.style.display,
        rect: saPanel.getBoundingClientRect(), errors: window.__bilidlErrors || [] });
      window.__bilidlOpenPanel = () => setSaPanel(true);
      window.__bilidlErrors = window.__bilidlErrors || [];
      window.addEventListener("error", (e) => { window.__bilidlErrors.push(String(e.message)); }, true);
      window.addEventListener("unhandledrejection", (e) => { window.__bilidlErrors.push("promise: " + String(e.reason)); }, true);
    } catch (err) {}
    // 面板自愈：B站 的全局点击监听 / SPA 重渲染 / 别家脚本都可能把面板关掉或整块移除。
    // 只要用户没主动关，就每隔 700ms 检查并把面板恢复回来。
    setInterval(() => {
      if (!saPanelWanted) return;
      try {
        if (saPanel.isConnected === false) {
          const host = document.getElementById("bilidl-sa-wrap") || saPanel.parentElement;
          if (host && host.isConnected === false) (document.body || document.documentElement).appendChild(host);
        }
        if (saPanel.style.display !== "block") {
          saPanel.style.display = "block";
          saPanel.classList.add("on");
        }
      } catch (e) {}
    }, 700);

    saPanel.addEventListener("click", (e) => e.stopPropagation());
    $("#bilidl-sa-close").addEventListener("click", (e) => { e.preventDefault(); setSaPanel(false); });
    $("#bilidl-sa-check").addEventListener("click", () => refreshLogin(true));
    $("#bilidl-sa-qr").addEventListener("click", qrLogin);
    $("#bilidl-sa-logout").addEventListener("click", logout);
    $("#bilidl-sa-cookiebtn").addEventListener("click", () => {
      const n = applyCookie($("#bilidl-sa-cookie").value);
      if (!n) return toast("没解析到 Cookie");
      toast("已写入 " + n + " 条 Cookie，正在校验…");
      setTimeout(async () => {
        const d = await refreshLogin(false);
        if (d && d.isLogin) toast("登录成功：" + (d.uname || ""));
        else toast("仍未登录：扫码登录更可靠（SESSDATA 若为 HttpOnly 无法用脚本写入）", 4200);
      }, 900);
    });
    $("#bilidl-sa-save").addEventListener("click", () => {
      saveConf({
        quality: Number($("#bilidl-sa-quality").value) || 116,
        subDir: $("#bilidl-sa-subdir").value.trim(),
        videoTpl: $("#bilidl-sa-vtpl").value.trim() || DEFAULTS.videoTpl,
        opusTpl: $("#bilidl-sa-otpl").value.trim() || DEFAULTS.opusTpl,
        readlistTpl: (($("#bilidl-sa-rtpl") || {}).value || "").trim() || DEFAULTS.readlistTpl,
        gmSave: !!($("#bilidl-sa-gmsave") || {}).checked,
        concurrency: Math.max(1, Math.min(4, Number($("#bilidl-sa-conc").value) || 2)),
        interval: Math.max(0, Math.min(20000, Number($("#bilidl-sa-interval").value) || 0)),
        exAudio: $("#bilidl-sa-exaudio").checked,
        exVideoMute: $("#bilidl-sa-exmute").checked,
        exSub: $("#bilidl-sa-exsub").checked,
        exDm: $("#bilidl-sa-exdm").checked,
        exCover: $("#bilidl-sa-excover").checked,
        exNfo: $("#bilidl-sa-exnfo").checked,
      });
      cmtSave($("#bilidl-sa-ctpl").value);
      renderPanel();
      toast("设置已保存（下次打开页面仍然生效）");
    });
    const resetBtn = $("#bilidl-sa-reset");
    if (resetBtn) resetBtn.addEventListener("click", () => {
      if (!confirm("恢复全部设置为默认值？（重命名规则、清晰度、下载目录等）")) return;
      store.reset(Object.keys(DEFAULTS));
      Object.assign(conf, DEFAULTS);
      try { localStorage.removeItem(CMT_KEY); GM_setValue(CMT_KEY, CMT_DEFAULT); } catch (e) {}
      cmtTpl = CMT_DEFAULT;
      renderPanel();
      toast("已恢复默认设置");
    });
    $("#bilidl-sa-selmode").addEventListener("change", (e) => setSelMode(e.target.checked));
    $("#bilidl-sa-selclear").addEventListener("click", clearPicked);
    $("#bilidl-sa-selall").addEventListener("click", () => {
      scanCards().forEach((w, card) => {
        const key = card.dataset.bilidlKey;
        if (!picked.has(key)) {
          picked.set(key, { kind: card.dataset.bilidlKind, ident: card.dataset.bilidlIdent, title: card.dataset.bilidlTitle || "", url: card.dataset.bilidlUrl || "" });
          card.classList.add("bilidl-sel");
        }
      });
      syncSel();
      toast("已选中本页 " + picked.size + " 个作品");
    });
    $("#bilidl-sa-send").addEventListener("click", () => {
      const list = [...picked.values()];
      if (!list.length) return;
      const btn = $("#bilidl-sa-send");
      const restore = () => { btn.textContent = "发送下载"; btn.disabled = picked.size === 0; };
      // 不在这里 await：把作品加入队列是后台动作，界面要立刻恢复，
      // 否则网络一慢按钮就卡在「解析中…」，没法继续挑下一批。
      btn.textContent = "解析中…";
      clearPicked();
      restore();
      Promise.resolve()
        .then(() => addWorks(list.map((i) => (i.kind === "douyin" || i.kind === "xhs")
          ? { kind: i.kind, ident: i.ident, title: i.title, shareUrl: i.url || "", social: true }
          : i)))
        .then((n) => toast("已加入 " + n + " 个下载任务"))
        .catch((e) => toast("加入队列失败：" + (e && e.message ? e.message : e), 4200))
        .finally(restore);
    });
    $("#bilidl-sa-pause").addEventListener("click", (e) => {
      paused = !paused;
      e.target.textContent = paused ? "继续" : "暂停";
      if (!paused) pump();
    });
    $("#bilidl-sa-clearq").addEventListener("click", () => { done.ok = done.fail = done.skip = 0; renderQueue(); });
    $("#bilidl-sa-cancelall").addEventListener("click", () => { cancelAllJobs(); });
    $("#bilidl-sa-retry").addEventListener("click", () => {
      if (!failedJobs.length) { toast("没有失败的任务"); return; }
      const n = failedJobs.length;
      failedJobs.forEach((job) => {
        job.status = "wait";
        job.progress = 0;
        job.error = "";
        queue.push(job);
      });
      failedJobs.length = 0;
      done.fail = 0;
      toast("已重新排队 " + n + " 个失败任务");
      renderQueue();
      pump();
    });
    $("#bilidl-sa-cur").addEventListener("click", async () => {
      const note = $("#bilidl-sa-curnote");
      const href = location.href.split("#")[0];

      // YouTube：视频直接解析；频道 / 播放列表先抓本页视频 id 再逐个解析
      if (isYouTubeUrl(href)) {
        const yt = ytDetect(href);
        if (!yt) { if (note) note.textContent = "这是 YouTube 首页 / 搜索页，请打开具体视频或频道"; return toast("当前页面没有可下载的 YouTube 目标"); }
        try {
          if (yt.kind === "yt_video") {
            toast("正在解析 YouTube 视频…");
            const jobs = await buildYouTubeJobs(href);
            jobs.forEach((j) => enqueue(j));
            if (note) note.textContent = "已加入队列：" + jobs.map((j) => j.name).join("、");
            toast("已加入下载队列（" + jobs.length + " 个文件）");
          } else {
            toast("正在抓取频道 / 播放列表里的视频…");
            const ids = await ytListVideos(href, 30);
            if (!ids.length) throw new Error("本页没有抓到视频（可能需要滚动加载，或链接不对）");
            let n = 0;
            for (const id of ids) {
              const jobs = await buildYouTubeJobs("https://www.youtube.com/watch?v=" + id).catch((e) => { pushLog("warn", "跳过 " + id + "：" + e.message); return []; });
              jobs.forEach((j) => { enqueue(j); n++; });
            }
            if (note) note.textContent = "已从本页加入 " + n + " 个文件（最多 30 个视频）";
            toast(n ? "已加入 " + n + " 个文件" : "没有解析出可下载的视频");
          }
        } catch (e) {
          toast("解析失败：" + (e && e.message ? e.message : e));
          pushLog("warn", "YouTube 解析失败：" + href + " · " + (e && e.message ? e.message : e));
        }
        return;
      }

      const w = classify(href);
      if (!w) { if (note) note.textContent = "当前页面不是视频 / 图文 / 专栏页"; return toast("当前页面没有可下载的作品"); }
      const title = String(document.title || "").replace(/\s*-\s*哔哩哔哩.*$/, "").trim();
      try {
        await addWorks([{ ...w, title }]);
        if (note) note.textContent = "已加入队列：" + (w.kind === "video" ? w.ident : "图文 " + w.ident);
        toast("已加入下载队列");
      } catch (e) { toast("加入队列失败：" + (e && e.message ? e.message : e)); }
    });
    $("#bilidl-sa-linkgo").addEventListener("click", async () => {
      const raw = $("#bilidl-sa-links").value.split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean);
      if (!raw.length) return toast("先粘贴链接");
      const works = [];
      const ytTargets = [];
      for (const u of raw) {
        if (isYouTubeUrl(u)) { ytTargets.push(u); continue; }
        let url = u;
        if (/b23\.tv|bili2233/.test(u) || isSocialShort(u)) url = await resolveShort(u);
        const w = classify(url);
        if (w) works.push({ ...w, title: "" }); else pushLog("warn", "无法识别：" + u);
      }
      if (works.length) await addWorks(works);
      let ytAdded = 0;
      for (const u of ytTargets) {
        const det = ytDetect(u);
        try {
          if (det && det.kind === "yt_video") {
            const jobs = await buildYouTubeJobs(u);
            jobs.forEach((j) => { enqueue(j); ytAdded++; });
          } else if (det) {
            const ids = await ytListVideos(u, 30);
            for (const id of ids) {
              const jobs = await buildYouTubeJobs("https://www.youtube.com/watch?v=" + id).catch((e) => { pushLog("warn", "跳过 " + id + "：" + e.message); return []; });
              jobs.forEach((j) => { enqueue(j); ytAdded++; });
            }
          } else {
            pushLog("warn", "无法识别的 YouTube 链接：" + u);
          }
        } catch (e) { pushLog("warn", "YouTube 解析失败：" + u + " · " + (e && e.message ? e.message : e)); }
      }
      if (!works.length && !ytAdded) return toast("没有识别到可下载的链接");
      if (ytAdded) toast("YouTube：已加入 " + ytAdded + " 个文件");
    });
    $("#bilidl-sa-quality").addEventListener("change", () => {});
    $("#bilidl-sa-selmode").checked = selMode;
    renderPanel();
    refreshLogin(false);
  }

  function renderPanel() {
    const q = $("#bilidl-sa-quality");
    if (q) q.value = String(conf.quality);
    const sd = $("#bilidl-sa-subdir"); if (sd) sd.value = conf.subDir;
    const vt = $("#bilidl-sa-vtpl"); if (vt) vt.value = conf.videoTpl;
    const ot = $("#bilidl-sa-otpl"); if (ot) ot.value = conf.opusTpl;
    const rt = $("#bilidl-sa-rtpl"); if (rt) rt.value = conf.readlistTpl || DEFAULTS.readlistTpl;
    const gs = $("#bilidl-sa-gmsave"); if (gs) gs.checked = !!conf.gmSave;
    const cc = $("#bilidl-sa-conc"); if (cc) cc.value = conf.concurrency;
    const iv = $("#bilidl-sa-interval"); if (iv) iv.value = conf.interval;
    const ct = $("#bilidl-sa-ctpl"); if (ct) ct.value = cmtTpl;
    const map = { "bilidl-sa-exaudio": conf.exAudio, "bilidl-sa-exmute": conf.exVideoMute, "bilidl-sa-exsub": conf.exSub,
      "bilidl-sa-exdm": conf.exDm, "bilidl-sa-excover": conf.exCover, "bilidl-sa-exnfo": conf.exNfo };
    for (const [id, value] of Object.entries(map)) { const el = $("#" + id); if (el) el.checked = !!value; }
    renderQueue();
  }

  function renderQueue() {
    const box = $("#bilidl-sa-queue");
    if (box) {
      const items = [];
      const active = queue.filter((j) => j.status === "run" || j.status === "wait").slice(0, 12);
      for (const j of active) {
        items.push(`<div class="sa-qitem"><span class="sa-qn">${esc(j.name.split("/").pop())}</span>
          <span class="sa-qs ${j.status}">${j.status === "run" ? Math.round((j.progress || 0) * 100) + "%" : "等待"}</span></div>`);
      }
      setHtml(box, items.join("") || '<div class="sa-note">暂无任务</div>');
      const st = $("#bilidl-sa-qstat");
      if (st) st.textContent = `完成 ${done.ok} · 失败 ${done.fail} · 队列 ${queue.length} · 进行中 ${running}`;
    }
    const lb = $("#bilidl-sa-logs");
    if (lb) {
      setHtml(lb, logs.map((l) => `<div class="sa-log ${l.level}"><span>${l.t}</span> ${esc(l.text)}</div>`).join("") || '<div class="sa-note">暂无日志</div>');
    }
  }

  function setSelMode(on, silent) {
    selMode = !!on;
    saveConf({ selMode });
    const cb = $("#bilidl-sa-selmode");
    if (cb) cb.checked = selMode;
    if (selMode) scheduleMount();
    else { clearPicked(); clearOverlays(); }
    syncSel();
    if (!silent) toast(selMode ? "多选模式已开启：点卡片即可选中" : "多选模式已关闭");
  }

  /* ------------------------------------------------ 评论图片下载（共用模块） */

  const isLive = /(^|\.)live\.bilibili\.com$/i.test(location.hostname);
  const liveRoomId = (() => {
    try {
      const m = location.pathname.match(/^\/(\d+)/);
      return m ? m[1] : "";
    } catch (e) { return ""; }
  })();

  const cmtToast = (m) => {
    if (typeof toast === "function") { try { toast(m); return; } catch (e) {} }
    let el = document.querySelector("#bilidl-cmt-toast");
    if (!el) { el = document.createElement("div"); el.id = "bilidl-cmt-toast"; el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:90px;z-index:100001;background:#0e1218;color:#fff;border:1px solid #2b3240;border-radius:8px;padding:8px 14px;font-size:13px"; document.body.appendChild(el); }
    el.textContent = m; el.style.display = "block";
    clearTimeout(el._t); el._t = setTimeout(() => { el.style.display = "none"; }, 2600);
  };

  const CMT_KEY = "cmtTpl";
  const CMT_DEFAULT = "<author>-<video_id>-<comment_id>-<order>.<ext>";
  let cmtTpl = (() => {
    let v;
    try { v = GM_getValue(CMT_KEY, undefined); } catch (e) {}
    if (!v) { try { v = localStorage.getItem(CMT_KEY) || undefined; } catch (e) {} }
    return String(v || CMT_DEFAULT);
  })();

  function cmtSave(tpl) {
    cmtTpl = String(tpl || "").trim() || CMT_DEFAULT;
    try { GM_setValue(CMT_KEY, cmtTpl); } catch (e) {}
    try { localStorage.setItem(CMT_KEY, cmtTpl); } catch (e) {}
  }

  const CMT_ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

  function cmtClean(s) {
    return String(s == null ? "" : s).replace(CMT_ILLEGAL, "_").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 120);
  }

  function cmtRender(vars, ext) {
    let t = String(cmtTpl).replace(/<([a-zA-Z0-9_]+)>/g, (m, k) => (k === "ext" ? ext : (vars[k] == null ? "" : String(vars[k]))));
    const parts = t.split(/[\\/]+/).map(cmtClean).filter((p) => p && p !== "." && p !== "..");
    if (!parts.length) parts.push("comment");
    let last = parts.pop();
    if (!/\.[a-z0-9]{1,5}$/i.test(last)) last += "." + ext;
    return parts.concat(last.slice(0, 170)).join("/");
  }

  const CMT_SEL = 'img[src*="hdslb.com"], source[srcset*="hdslb.com"]';
  // 头像 / 表情 / 装扮 / 等级 / 认证 这类「不是用户投稿的图」的 URL 特征
  const CMT_DENY = /\/bfs\/(face|emote|garb|vip|pendant|static|small_dynamic_cover)\/|noface|\/bfs\/.*(avatar|emote)/i;
  // 用户在评论区真发的图：new_dyn（新版评论图/动态图）与 comment（旧版评论图）
  const CMT_USER_PIC = /\/bfs\/(new_dyn|comment)\//i;

  const CMT_ATTRS = ["src", "data-src", "data-original", "data-fail-src", "srcset", "data-srcset", "href", "poster"];

  function cmtNorm(u) { return cmtNormWith(u, CMT_DENY); }

  function cmtNormWith(u, deny) {
    let v = String(u || "").trim();
    if (!v) return "";
    v = v.replace(/^url\((['"]?)/, "").replace(/(['"]?)\)$/, "").trim();
    // srcset 可能是 "a.jpg 1x, b.jpg 2x"：取最后一项（分辨率最高）
    if (v.indexOf(",") >= 0) {
      const cands = v.split(",").map((x) => x.trim().split(/\s+/)[0]).filter(Boolean);
      v = cands[cands.length - 1] || "";
    } else {
      v = v.split(/\s+/)[0];
    }
    if (!v) return "";
    if (v.startsWith("//")) v = "https:" + v;
    // B站部分图片地址是 http://i0.hdslb.com/...，统一升到 https 再校验
    v = v.replace(/^http:\/\/([\w.-]*hdslb\.com\/bfs\/)/i, "https://$1");
    if (!/^https:\/\/[\w.-]*hdslb\.com\/bfs\//i.test(v)) return "";
    if (deny.test(v) || /\.svg(\?|$)/i.test(v)) return "";
    return v.replace(/@[^/]*$/, "");
  }

  // 一张图可能有多个属性/多种承载方式（懒加载 data-src、srcset、background-image、灯箱 <a href>），全部收一遍
  function cmtPicUrl(el) {
    // DOM 位置排除：表情图、头像、等级牌、挂件、用户名区域
    try {
      if (el.closest('[class*="emote"], [class*="emoji"], [class*="avatar"], [class*="user-name"], [class*="userinfo"], [class*="level-icon"], [class*="badge"], [class*="pendant"], [class*="face"]')) return "";
    } catch (e) {}
    for (const a of CMT_ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const u = cmtNorm(v); if (u) return u; }
    }
    const bg = (el.style && el.style.backgroundImage) || "";
    if (bg) { const u = cmtNorm(bg); if (u) return u; }
    return "";
  }

  function cmtCollect(node) {
    const raw = [];
    const seen = new Set();
    const push = (u) => { if (u && !seen.has(u)) { seen.add(u); raw.push(u); } };
    // 评论被折叠（只显示「展开」）时，图片节点根本不在 DOM 里；
    // lit 组件把原始评论数据挂在 __data 上，content.pictures 是权威图片列表。
    const addDataPics = (d) => {
      try {
        const pics = d && d.content && d.content.pictures;
        if (!Array.isArray(pics)) return;
        pics.forEach((p) => { if (p && p.img_src) push(cmtNorm(p.img_src)); });
      } catch (e) {}
    };
    if (node) {
      for (const k of ["__data", "__data__", "data", "comment"]) {
        try { addDataPics(node[k]); } catch (e) {}
      }
    }
    const grab = (root) => {
      let els = [];
      try { els = root.querySelectorAll("*"); } catch (e) { return; }
      els.forEach((el) => {
        // 背景图元素即使没有 img 标签也算
        const bg = el.style && el.style.backgroundImage;
        if (!el.getAttribute) return;
        const hasPicAttr = CMT_ATTRS.some((a) => el.getAttribute(a));
        if (!hasPicAttr && !bg) return;
        push(cmtPicUrl(el));
      });
    };
    // 递归穿透多层 shadow DOM（评论 renderer → pictures renderer → img）
    const walk = (root, depth) => {
      if (!root || depth > 8) return;
      grab(root);
      if (root.shadowRoot) walk(root.shadowRoot, depth + 1);
      try { root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) walk(el, depth + 1); }); } catch (e) {}
    };
    walk(node, 0);
    // 只要「用户发的图」：优先 new_dyn / comment 目录，实在没有才退回宽松结果
    const strict = raw.filter((u) => CMT_USER_PIC.test(u));
    return strict.length ? strict : raw;
  }


  // 主播动态：每条动态一个按钮，下载该动态相册里的全部图片。
  function dynPics(node) {
    const out = [];
    const seen = new Set();
    const add = (v) => {
      if (!v) return;
      const u = cmtNorm(v);
      if (!u || seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };
    try {
      node.querySelectorAll(".dyn-card-opus__pics img, .bili-album__preview__picture img").forEach((el) => {
        for (const a of ["src", "data-src", "data-original"]) add(el.getAttribute && el.getAttribute(a));
      });
      node.querySelectorAll(".dyn-card-opus__pics source, .bili-album__preview__picture source").forEach((el) => {
        const ss = (el.getAttribute && (el.getAttribute("srcset") || el.getAttribute("data-srcset"))) || "";
        add(ss.split(",")[0].trim().split(/\s+/)[0]);
      });
    } catch (e) {}
    return out;
  }

  function dynMountIn(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.getAttribute("data-bilidl-dyn") === "1") return;
    const pics = dynPics(node);
    if (!pics.length) return;
    const host = node.querySelector(".bili-dyn-item__body") || node;
    const btn = document.createElement("div");
    btn.className = "bilidl-cmt bilidl-dyn";
    btn.setAttribute("role", "button");
    btn.setAttribute("tabindex", "0");
    btn.title = "保存这条动态的图片（" + pics.length + " 张）";
    btn.innerHTML = cmtBtnHTML(pics.length, false);
    const go = (e) => { e.preventDefault(); e.stopPropagation(); cmtDownload(node, btn, dynPics, "动态图片"); };
    btn.addEventListener("click", go);
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") go(e);
    });
    host.appendChild(btn);
    node.setAttribute("data-bilidl-dyn", "1");
  }

  function dynScanAll() {
    let items = [];
    try { items = document.querySelectorAll(".bili-dyn-item"); } catch (e) { return; }
    items.forEach(dynMountIn);
  }

  function cmtBtnHTML(n, done) {
    const icon = done
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v10.5"/><path d="m7.6 10 4.4 4.4 4.4-4.4"/><path d="M4.5 19h15"/></svg>';
    return icon + '<span class="t">' + (done ? "已保存" : "保存图片") + "</span><em>" + n + "</em>";
  }

  try { window.__bilidlCMT = { collect: cmtCollect, picUrl: cmtPicUrl, render: cmtRender, btn: cmtBtnHTML, full: cmtFullPics, dbg: () => ({ id: null, map: Object.keys(cmtPicsByRpid), pics: cmtPicsByRpid }), idOf: cmtIdFrom, load: cmtLoadMap }; } catch (e) {}

  function cmtAuthor(node) {
    if (isLive) {
      const el = node && node.querySelector && (node.querySelector(".bili-dyn-title__text") || node.querySelector(".user-name"));
      return el ? String(el.textContent || "").trim() : "";
    }
    const SEL = "#user-name, .user-name, [class*='user-name'], .bili-comment-user-info-name, .name";
    const pick = (root) => {
      const el = root.querySelector ? root.querySelector(SEL) : null;
      return el ? (el.getAttribute("title") || el.textContent || "").trim() : "";
    };
    const deep = (root, depth) => {
      if (!root || depth > 4) return "";
      let a = pick(root);
      if (a) return a;
      const nodes = root.querySelectorAll ? root.querySelectorAll("*") : [];
      for (const el of nodes) {
        if (el.shadowRoot) { a = deep(el.shadowRoot, depth + 1); if (a) return a; }
      }
      return "";
    };
    let a = deep(node, 0);
    if (!a && node.shadowRoot) a = deep(node.shadowRoot, 0);
    // 楼中楼回复（BILI-COMMENT-REPLY-RENDERER）里常常只有头像、没有昵称节点，
    // 但 lit 组件会把评论数据挂在 __data__ 上，用 member.uname 兜底。
    if (!a) {
      try {
        const d = node && (node.__data || node.__data__ || node.data || node.comment);
        const u = d && d.member && d.member.uname;
        if (u) a = String(u).trim();
      } catch (e) {}
    }
    return a;
  }

  function cmtIdFrom(node) {
    if (isLive) {
      if (node && node.classList && node.classList.contains("bili-dyn-item")) {
        const title = (node.querySelector(".bili-dyn-title__text") || {}).textContent || "";
        const time = (node.querySelector(".bili-dyn-time") || {}).textContent || "";
        const pic = dynPics(node)[0] || "";
        const seed = title.trim() + "|" + time.trim() + "|" + pic;
        let h = 0;
        for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
        return "dyn" + (h >>> 0).toString(36);
      }
      return "";
    }
    let id = "";
    const scan = (root) => {
      root.querySelectorAll("*").forEach((el) => {
        for (const at of el.attributes || []) {
          if (!id && /^(data-)?(rpid|comment-?id|id)$/i.test(at.name) && /^\d{10,}$/.test(at.value)) id = at.value;
        }
        if (!id && el.shadowRoot) scan(el.shadowRoot);
      });
    };
    scan(node);
    if (!id && node.shadowRoot) scan(node.shadowRoot);
    if (!id) {
      try { const d = node.__data || node.__data__ || node.data || node.comment; if (d && d.rpid) id = String(d.rpid); } catch (e) {}
    }
    return id;
  }

  let cmtBvid = isLive ? ("live" + (liveRoomId || "room")) : (location.href.match(/BV[0-9A-Za-z]{10}/) || [""])[0];
  let cmtMap = null;

  const cmtPicsByRpid = {};

  // 九宫格只显示 8 张、第 9 张藏在「+1」里时，DOM 里根本拿不到那张；
  // 评论接口的 content.pictures 是权威列表，用它补全。
  // 返回「DOM ∪ 接口」并保持 DOM 顺序，<order> 与界面上看到的顺序一致。
  async function cmtFullPics(node, domPics) {
    try {
      const rpid = cmtIdFrom(node);
      await cmtLoadMap();
      let key = rpid;
      let api = rpid ? cmtPicsByRpid[rpid] : null;
      if (!api) {
        // rpid 超过 2^53 时 JSON 解析会掉精度，退一步用图片 URL 反查这条评论
        const hit = domPics.map((u) => cmtMap && cmtMap[u]).find(Boolean);
        if (hit) { key = String(hit.rpid); api = cmtPicsByRpid[key]; }
      }
      // 首屏只扫了前 3 页评论：滚动后新加载的评论、楼中楼可能都不在 map 里。
      // 九宫格满 8 张（说明可能有「+N」没显示）时，单独问一次这条评论的评论串。
      if ((!api || api.length < domPics.length) && domPics.length >= 8) {
        const full = await cmtThreadPics(key);
        if (full && full.length > (api ? api.length : 0)) api = full;
      }
      if (api && api.length > domPics.length) {
        const merged = domPics.slice();
        api.forEach((u) => { if (u && merged.indexOf(u) < 0) merged.push(u); });
        return merged;
      }
    } catch (e) {}
    return domPics;
  }

  // 按 rpid 查整条评论串：/x/v2/reply/reply?root=<rpid> 对根评论与楼中楼都有效，
  // 返回串的 root + replies，不受「只扫了前 3 页」的限制。
  const cmtThreadCache = {};
  async function cmtThreadPics(rpid) {
    if (!rpid) return null;
    if (rpid in cmtThreadCache) return cmtThreadCache[rpid];
    cmtThreadCache[rpid] = null;   // 占位，避免并发重复请求
    try {
      const aid = await cmtAid();
      if (!aid) return null;
      const r = await (await fetch(
        `https://api.bilibili.com/x/v2/reply/reply?oid=${aid}&type=1&root=${rpid}&ps=20&pn=1`,
        { credentials: "include" }
      )).json();
      const data = (r && r.data) || {};
      const root = data.root || null;
      const reps = (data.replies || []).filter(Boolean);
      const norm = (c) => (((c || {}).content || {}).pictures || []).map((p) => cmtNorm(p.img_src)).filter(Boolean);
      const hit = [root].concat(reps).find((c) => c && String(c.rpid_str || c.rpid) === String(rpid));
      let list = hit ? norm(hit) : [];
      // 根评论的九宫格会把楼中楼的图一起铺开，补全时也要算上
      if (hit && root && hit === root) reps.forEach((c) => { list = list.concat(norm(c)); });
      list = Array.from(new Set(list));
      cmtThreadCache[rpid] = list.length ? list : null;
      return cmtThreadCache[rpid];
    } catch (e) {
      return null;
    }
  }

  // aid 来源：页面里的 __INITIAL_STATE__（评论区页面可能没有 BV 号）或 view 接口
  async function cmtAid() {
    const st = window.__INITIAL_STATE__ || {};
    let aid = st.aid || (st.videoData && st.videoData.aid) || 0;
    const bv = cmtBvid || (location.pathname.match(/\/video\/(BV[0-9A-Za-z]{10})/) || [])[1] || "";
    if (!aid && bv) {
      const info = await (await fetch("https://api.bilibili.com/x/web-interface/view?bvid=" + bv, { credentials: "include" })).json();
      aid = info && info.data && info.data.aid;
    }
    return aid || 0;
  }

  let cmtMapPromise = null;
  // 并发调用共用同一个请求，避免第二次直接拿到空对象
  async function cmtLoadMap() {
    if (cmtMap) return cmtMap;
    if (!cmtMapPromise) cmtMapPromise = _cmtLoadMap().catch(() => (cmtMap = cmtMap || {}));
    return cmtMapPromise;
  }

  async function _cmtLoadMap() {
    if (cmtMap) return cmtMap;
    cmtMap = {};
    try {
      const aid = await cmtAid();
      if (!aid) return cmtMap;
      for (let pn = 1; pn <= 3; pn++) {
        const r = await (await fetch(`https://api.bilibili.com/x/v2/reply?oid=${aid}&type=1&pn=${pn}&ps=20&sort=2&nohot=1`, { credentials: "include" })).json();
        const list = (r && r.data && r.data.replies) || [];
        if (!list.length) break;
        for (const c of list) {
          const key = String(c.rpid_str || c.rpid);
          const rec = { rpid: key, uname: (c.member && c.member.uname) || "" };
          // 接口给的是 http://i0.hdslb.com/...，DOM 统一升级成 https；
          // 必须用同一套规范化，否则「按图片 URL 反查评论」永远匹配不上。
          const urls = (((c.content || {}).pictures) || []).map((p) => cmtNorm(p.img_src)).filter(Boolean);
          urls.forEach((u) => { cmtMap[u] = rec; });
          if (urls.length) cmtPicsByRpid[key] = urls;
          // 楼中楼：图片挂到「子评论自己的 rpid」，同时并进父评论（父评论的九宫格会一起显示）
          (c.replies || []).forEach((sc) => {
            const su = (((sc.content || {}).pictures) || []).map((p) => cmtNorm(p.img_src)).filter(Boolean);
            if (!su.length) return;
            const subKey = String(sc.rpid_str || sc.rpid);
            cmtPicsByRpid[subKey] = Array.from(new Set((cmtPicsByRpid[subKey] || []).concat(su)));
            if (subKey !== key) cmtPicsByRpid[key] = Array.from(new Set((cmtPicsByRpid[key] || []).concat(su)));
            su.forEach((u) => { cmtMap[u] = { rpid: subKey, uname: rec.uname }; });
          });
        }
        await new Promise((r2) => setTimeout(r2, 700));
      }
    } catch (e) { console.warn("[BiliDL] 评论映射获取失败", e); }
    return cmtMap;
  }

  function cmtButtonLabel(n) { return cmtBtnHTML(n, false); }

  function cmtDownload(node, btn, picsFn, extra) {
    const label = extra || "评论图片";
    const isDyn = !!picsFn;
    let pics = (picsFn || cmtCollect)(node);
    if (!pics.length) return cmtToast("这条" + label.replace(/图片$/, "") + "没有找到图片");
    btn.disabled = true;
    const author = cmtAuthor(node);
    let cid = cmtIdFrom(node);
    const go = async () => {
      // 动态图已经在 DOM 里，直接下；视频评论才需要补 API 原图。
      if (!isDyn) {
        pics = await cmtFullPics(node, pics);
        if (!cid) {
          const map = await cmtLoadMap();
          const hit = pics.map((u) => map && map[u]).find(Boolean);
          if (hit) { cid = hit.rpid; }
        }
      }
      const vars = { author: author || (isDyn ? "主播" : "评论者"), video_id: cmtBvid || "", comment_id: cid || "unknown" };
      let ok = 0;
      for (let i = 0; i < pics.length; i++) {
        const m = String(pics[i]).match(/\.(gif|png|webp|jpe?g|avif)(?:\?|$)/i);
        const ext = m ? m[1].toLowerCase().replace("jpeg", "jpg") : "jpg";
        const mime = ext === "png" ? "image/png" : (ext === "gif" ? "image/gif" : (ext === "webp" ? "image/webp" : (ext === "avif" ? "image/avif" : "image/jpeg")));
        const name = cmtRender({ ...vars, order: i + 1 }, ext);
        try {
          await gmDownload({ url: pics[i], name, kind: "image", mime });
          ok++;
        } catch (e) { console.warn("[BiliDL] " + label + "失败", e); }
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 400));
      }
      btn.innerHTML = cmtBtnHTML(ok + "/" + pics.length, true);
      btn.disabled = false;
      cmtToast(label + "：已提交 " + ok + "/" + pics.length + " 个下载");
    };
    go();
  }

  const cmtMounted = new Set();
  const cmtNoPicAt = new WeakMap();   // 上次确认「这条评论还没图」的时间

  function cmtMountIn(node) {
    if (!node || node.nodeType !== 1) return;
    const isComment = /^BILI-COMMENT-(?:REPLY-)?RENDERER$/i.test(node.tagName) ||
      (typeof node.className === "string" && /(^|\s)(reply-item|comment-item|sub-reply-item|reply-wrap)(\s|$)/.test(node.className));
    if (!isComment) return;                       // 只在「评论卡片」本身挂一次，避免重复按钮
    const nodeId = cmtIdFrom(node) || "";
    const key = "c" + (nodeId || (node.className || "") + "@" + (node.compareDocumentPosition && node.__bilidlSeq || Math.random()));
    if (nodeId && cmtMounted.has(key)) return;    // 同一条评论只挂一个按钮
    // 没有图的评论别每 500ms 都把整棵子树重扫一遍；1.5 秒后允许再试（图片是懒加载的）
    const missAt = cmtNoPicAt.get(node) || 0;
    if (missAt && Date.now() - missAt < 1500) return;
    const pics = cmtCollect(node);
    // 图片是懒加载的，这一刻可能还没 src。不能在此之前就记为 mounted，
    // 否则后续扫描永远跳过这条评论，按钮要等很久（或永远）才出现。
    if (!pics.length) {
      cmtNoPicAt.set(node, Date.now());
      return;
    }
    if (nodeId) cmtMounted.add(key);
    const host = node.shadowRoot || node;
    if (node.shadowRoot) cmtObserve(node.shadowRoot);
    // 同一条评论所在的那棵 shadow 树里只保留一个按钮
    const scope = node.shadowRoot || (node.getRootNode ? node.getRootNode() : null);
    if (scope && scope.querySelector && scope.querySelector(".bilidl-cmt")) return;
    // 按钮在 shadow DOM 里，document 上的样式穿不透，得把这个样式表也送进 shadow root
    if (node.shadowRoot && !node.shadowRoot.querySelector('style[data-bilidl-cmt]')) {
      const css = (document.getElementById("bilidl-cmt-style") || {}).textContent || "";
      const sc = document.createElement("style");
      sc.setAttribute("data-bilidl-cmt", "");
      sc.textContent = css;
      try { node.shadowRoot.appendChild(sc); } catch (e) {}
    }
    const btn = document.createElement("button");
    btn.className = "bilidl-cmt";
    btn.type = "button";
    btn.innerHTML = cmtButtonLabel(pics.length);
    cmtFullPics(node, pics).then((full) => {
      if (full && full.length > pics.length) btn.innerHTML = cmtButtonLabel(full.length);
    }).catch(() => {});
    btn.title = "下载这条评论里的全部图片/动图原图";
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); cmtDownload(node, btn); }, true);
    try { host.appendChild(btn); } catch (e) { node.appendChild(btn); }
  }

  function cmtScanAll() {
    if (isLive) { dynScanAll(); return; }
    const walk = (root) => {
      if (!root) return;
      root.querySelectorAll("bili-comment-renderer, bili-comment-reply-renderer, [class*='reply-item'], [class*='comment-item']").forEach((el) => cmtMountIn(el));
      if (root.querySelectorAll) root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) { cmtObserve(el.shadowRoot); walk(el.shadowRoot); }
      });
    };
    walk(document);
    const host = document.querySelector("bili-comments");
    if (host && host.shadowRoot) {
      cmtObserve(host.shadowRoot);
      host.shadowRoot.querySelectorAll("bili-comment-renderer, bili-comment-reply-renderer").forEach((el) => cmtMountIn(el));
    }
  }

  // 节流而不是防抖：B站 页面 DOM 一直在变，防抖会被无限重置，按钮要等几分钟才出来
  let cmtTimer = 0;
  let cmtLastScan = 0;
  function cmtSchedule() {
    if (cmtTimer) return;
    const wait = Math.max(0, 500 - (Date.now() - cmtLastScan));
    cmtTimer = setTimeout(() => {
      cmtTimer = 0;
      cmtLastScan = Date.now();
      cmtScanAll();
    }, wait);
  }

  // 评论卡片和图片都在 shadow DOM 里，document 上的 MutationObserver 看不到；
  // 给每棵 shadowRoot 单独挂一个，并监听 src/srcset/style，懒加载一写进去就能触发扫描。
  const cmtObserved = new WeakSet();
  const cmtMo = new MutationObserver(() => cmtSchedule());
  function cmtObserve(root) {
    if (!root || cmtObserved.has(root)) return;
    cmtObserved.add(root);
    try {
      cmtMo.observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "data-src", "data-original", "data-fail-src", "srcset", "data-srcset", "style"],
      });
    } catch (e) {}
  }

  function cmtInjectCss() {
    const st = document.createElement("style");
    st.id = "bilidl-cmt-style";
    st.textContent = `
      .bilidl-cmt{display:inline-flex;align-items:center;gap:6px;margin:7px 0 3px;padding:5px 12px;border-radius:99px;
        background:linear-gradient(135deg,#fb7299,#ff9dc0);color:#2a0a14;border:none;font-size:12px;line-height:1.5;
        font-weight:600;font-family:inherit;cursor:pointer;z-index:60;box-shadow:0 2px 10px rgba(251,114,153,.28);
        transition:transform .15s,box-shadow .15s,filter .15s}
      .bilidl-cmt:hover{transform:translateY(-1px);box-shadow:0 6px 18px rgba(251,114,153,.42);filter:brightness(1.05)}
      .bilidl-cmt:active{transform:translateY(0)}
      .bilidl-cmt svg{flex:0 0 auto;display:block}
      .bilidl-cmt .t{letter-spacing:.2px}
      .bilidl-cmt em{font-style:normal;background:rgba(0,0,0,.20);border-radius:99px;padding:0 7px;font-size:11px;
        line-height:17px;min-width:18px;text-align:center;font-variant-numeric:tabular-nums}
      .bilidl-cmt:disabled{opacity:.75;cursor:default;transform:none}
      /* 主播动态：每条动态一个按钮，放在正文下方 */
      .bilidl-dyn{margin:8px 0 0;padding:3px 10px;font-size:11px;box-shadow:none}
      .bilidl-dyn .t{display:inline}`;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ 样式 */

  // YouTube 会强制 Trusted Types：直接写 innerHTML 会抛 TypeError。
  // 页面允许 createPolicy（实测可用），就建一个直通策略把 HTML 包成 TrustedHTML；
  // 策略名带上时间戳，避免重复注入时「同名策略已存在」。
  let ttPolicy = null;
  function htmlOf(html) {
    if (!ttPolicy && typeof trustedTypes !== "undefined" && trustedTypes.createPolicy) {
      try { ttPolicy = trustedTypes.createPolicy("bilidl-" + Date.now(), { createHTML: (s) => s }); } catch (e) { ttPolicy = null; }
    }
    try { return ttPolicy ? ttPolicy.createHTML(html) : html; } catch (e) { return html; }
  }
  function setHtml(el, html) {
    if (!el) return;
    try { el.innerHTML = htmlOf(html); }
    catch (e) { el.textContent = String(html || "").replace(/<[^>]+>/g, ""); }
  }

  function injectCss() {
    const css = `
    #bilidl-sa-opic{position:fixed;right:14px;bottom:68px;z-index:99998;display:none;align-items:center;gap:6px;
      padding:6px 11px;border-radius:99px;background:rgba(23,28,36,.94);color:#fff;font-size:12px;line-height:1;
      border:1px solid #2b3240;box-shadow:0 6px 18px rgba(0,0,0,.35);user-select:none}
    #bilidl-sa-opic svg{color:#fb7299}
    #bilidl-sa-opic .n{font-weight:700;font-size:13px;color:#fb7299;font-variant-numeric:tabular-nums}
    #bilidl-sa-opic .t{color:#b9c3d1}
    #bilidl-sa-fab{position:fixed;right:14px;bottom:16px;width:40px;height:40px;border-radius:50%;background:#fb7299;color:#fff;
      display:flex;align-items:center;justify-content:center;font-size:20px;cursor:pointer;z-index:99999;opacity:.55;
      box-shadow:0 4px 14px rgba(0,0,0,.35);transition:opacity .2s,transform .2s}
    #bilidl-sa-fab:hover{opacity:1;transform:scale(1.06)}
    #bilidl-sa-panel{display:none;position:fixed;right:14px;bottom:64px;width:372px;max-height:76vh;overflow:auto;
      background:#171c24;color:#e6e9ef;border:1px solid #2b3240;border-radius:12px;z-index:99998;padding:12px;
      font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)}
    #bilidl-sa-panel.on{display:block}
    #bilidl-sa-panel .sa-head{display:flex;align-items:center;gap:8px;padding-bottom:8px;border-bottom:1px solid #262d3a;margin-bottom:8px}
    #bilidl-sa-panel .sa-head b{font-size:14px;color:#fff}
    #bilidl-sa-ver{font-size:11px;color:#8b97a8;border:1px solid #2f3846;border-radius:99px;padding:0 6px}
    #bilidl-sa-close{margin-left:auto}
    #bilidl-sa-panel .sa-sec{margin:10px 0 14px}
    #bilidl-sa-panel .sa-h{font-size:12px;color:#9aa6b8;margin-bottom:6px;letter-spacing:.4px}
    #bilidl-sa-panel .sa-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0}
    #bilidl-sa-panel .sa-l{display:flex;flex-direction:column;gap:4px;margin:6px 0;font-size:12px;color:#aab4c4}
    #bilidl-sa-panel .sa-tgl{display:flex;gap:6px;align-items:center;font-size:13px;cursor:pointer}
    #bilidl-sa-panel .sa-note{font-size:11px;color:#7d8798;line-height:1.5}
    #bilidl-sa-panel input[type=text],#bilidl-sa-panel input[type=number],#bilidl-sa-panel select,
    #bilidl-sa-panel textarea{background:#0f141b;border:1px solid #2b3240;color:#e6e9ef;border-radius:7px;padding:6px 8px;
      font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;width:100%;box-sizing:border-box}
    #bilidl-sa-panel button{background:#fb7299;border:none;color:#fff;border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer}
    #bilidl-sa-panel button.ghost{background:#232b38;color:#cfd7e3}
    #bilidl-sa-panel button:disabled{opacity:.45;cursor:default}
    .sa-login{font-size:12px;padding:5px 8px;border-radius:7px;background:#222a36}
    .sa-login.ok{color:#8fe3a1}
    .sa-login.warn{color:#ffcc7a}
    .sa-q{max-height:130px;overflow:auto;font-size:11px;color:#98a4b6}
    .sa-qitem{display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px dashed #232b38}
    .sa-qn{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
    .sa-qs{color:#8fa0b8}
    .sa-qs.run{color:#fb7299}
    .sa-qs.ok{color:#8fe3a1}
    .sa-qs.fail{color:#ff8b8b}
    .sa-log{padding:1px 0}
    .sa-log.error{color:#ff9b9b}
    .sa-log.warn{color:#ffd08a}
    #bilidl-sa-tip{display:none;position:fixed;left:16px;top:76px;z-index:99997;background:#171c24;color:#e6e9ef;
      border:1px solid #2b3240;border-radius:8px;padding:6px 10px;font:12px/1.5 -apple-system,"Microsoft YaHei",sans-serif}
    #bilidl-sa-selbar{display:none;position:fixed;left:50%;transform:translateX(-50%);bottom:18px;z-index:99998;
      background:#171c24;border:1px solid #2b3240;border-radius:99px;padding:7px 10px;gap:8px;align-items:center;
      font:13px/1.4 -apple-system,"Microsoft YaHei",sans-serif;color:#e6e9ef;box-shadow:0 8px 30px rgba(0,0,0,.45)}
    #bilidl-sa-selbar button{background:#fb7299;border:none;color:#fff;border-radius:99px;padding:5px 12px;font-size:12px;cursor:pointer}
    #bilidl-sa-selbar button.ghost{background:#232b38;color:#cfd7e3}
    #bilidl-sa-selbar button:disabled{opacity:.5;cursor:default}
    #bilidl-sa-toast{position:fixed;left:50%;transform:translateX(-50%) translateY(20px);bottom:74px;z-index:100000;
      background:#0e1218;color:#fff;border:1px solid #2b3240;border-radius:8px;padding:8px 14px;font-size:12.5px;
      opacity:0;pointer-events:none;transition:.22s;max-width:70vw}
    #bilidl-sa-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
    .bilidl-hit{position:relative}
    .bilidl-ov{position:absolute;left:8px;top:8px;width:26px;height:26px;border-radius:7px;background:rgba(20,24,32,.55);
      border:2px solid rgba(255,255,255,.85);z-index:95;cursor:pointer;display:block;box-sizing:border-box}
    .bilidl-ov-on{background:#fb7299;border-color:#fff}
    .bilidl-ov-on::after{content:"✓";position:absolute;left:0;right:0;top:-1px;text-align:center;color:#fff;font-size:17px;font-weight:700}
    .bilidl-sel{outline:2.5px solid #fb7299;outline-offset:-2px;border-radius:8px}
    `;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------------------ 启动 */

  /* ================================================================
   *  YouTube（独立版）：直接在页面里解析并下载
   *  - 视频详情来自 watch 页的 ytInitialPlayerResponse（GM_xmlhttpRequest 取原文再抽 JSON）
   *  - 格式地址若带 signatureCipher，就从 player JS 里抽解密函数做签名变换
   *  - 清晰度语义与 B 站一致：<video_quality> 用同一个设置项
   * ================================================================ */

  const YT_VID_RE = /^[0-9A-Za-z_-]{11}$/;
  const YT_HEIGHT = { 127: 4320, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360 };

  function isYouTubeUrl(url) {
    try {
      const h = new URL(url, location.href).hostname.toLowerCase();
      return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
    } catch (e) { return false; }
  }

  function ytDetect(url) {
    let u;
    try { u = new URL(url, location.href); } catch (e) { return null; }
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const vid = u.pathname.replace(/^\/+/, "").split("/")[0];
      return YT_VID_RE.test(vid) ? { kind: "yt_video", ident: vid } : null;
    }
    if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) return null;
    const v = (u.searchParams.get("v") || "").trim();
    if (YT_VID_RE.test(v)) return { kind: "yt_video", ident: v };
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([0-9A-Za-z_-]{11})/);
    if (m) return { kind: "yt_video", ident: m[1] };
    const list = (u.searchParams.get("list") || "").trim();
    if (u.pathname.startsWith("/playlist") && list) return { kind: "yt_playlist", ident: list };
    const h = u.pathname.match(/^\/@([^/?#]+)/);
    if (h) return { kind: "yt_channel", ident: "@" + h[1] };
    const ch = u.pathname.match(/^\/(channel|c|user)\/([^/?#]+)/);
    if (ch) return { kind: "yt_channel", ident: ch[2] };
    return null;
  }

  function ytFetchText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("缺少 GM_xmlhttpRequest"));
      GM_xmlhttpRequest({
        method: "GET", url, timeout: 30000,
        headers: { "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
        onload: (r) => resolve(String((r && r.responseText) || "")),
        onerror: () => reject(new Error("无法访问 YouTube（可能需要代理）")),
        ontimeout: () => reject(new Error("访问 YouTube 超时")),
      });
    });
  }

  function ytPostJson(url, body, headers) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("缺少 GM_xmlhttpRequest"));
      GM_xmlhttpRequest({
        method: "POST", url, timeout: 30000,
        headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
        data: JSON.stringify(body),
        onload: (r) => {
          try { resolve(JSON.parse(String((r && r.responseText) || "{}"))); }
          catch (e) { reject(new Error("YouTube 返回的不是 JSON（HTTP " + ((r && r.status) || 0) + "）")); }
        },
        onerror: () => reject(new Error("请求 YouTube 失败（网络或代理问题）")),
        ontimeout: () => reject(new Error("请求 YouTube 超时")),
      });
    });
  }

  /** 从一段 JS/HTML 里抽 marker 之后的 JSON 对象（按花括号配对，忽略字符串里的括号）。 */
  function ytExtractJson(text, marker) {
    const at = text.indexOf(marker);
    if (at < 0) return null;
    let i = text.indexOf("{", at);
    if (i < 0) return null;
    let depth = 0, inStr = false, quote = "", esc2 = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc2) { esc2 = false; continue; }
        if (c === "\\") { esc2 = true; continue; }
        if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; }
        }
      }
    }
    return null;
  }

  /** 从 player JS 里抽「签名解密函数」，返回 sig => url 那种变换后的字符串（失败返回 null）。 */
  function ytBuildDecipher(js) {
    try {
      const head = js.match(/([A-Za-z0-9_$]+)\s*=\s*function\s*\(\s*([A-Za-z0-9_$]+)\s*\)\s*\{\s*\2\s*=\s*\2\.split\(\s*""\s*\)/);
      if (!head) return null;
      const braceAt = js.indexOf("{", js.indexOf(head[0]));
      let depth = 0, end = -1, inStr = false, quote = "", esc2 = false;
      for (let j = braceAt; j < js.length; j++) {
        const c = js[j];
        if (inStr) {
          if (esc2) { esc2 = false; continue; }
          if (c === "\\") { esc2 = true; continue; }
          if (c === quote) inStr = false;
          continue;
        }
        if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end < 0) return null;
      const body = js.slice(braceAt + 1, end);
      // 找出「辅助对象」的名字：跳过 split/join，取第一个带两个参数的调用（如 Pt.reverse(a,12)）
      const objHit = body.match(/([A-Za-z0-9_$]+)\.(?!split\b|join\b)([A-Za-z0-9_$]+)\([A-Za-z0-9_$]+,\s*\d+\)/)
        || body.match(/([A-Za-z0-9_$]+)\.(?!split\b|join\b)([A-Za-z0-9_$]+)\(/);
      if (!objHit) return null;
      const objName = objHit[1];
      const objAt = js.search(new RegExp("(?:var\\s+)?" + objName + "\\s*=\\s*\\{"));
      if (objAt < 0) return null;
      const objBrace = js.indexOf("{", objAt);
      let od = 0, oEnd = -1;
      inStr = false; esc2 = false;
      for (let j = objBrace; j < js.length; j++) {
        const c = js[j];
        if (inStr) {
          if (esc2) { esc2 = false; continue; }
          if (c === "\\") { esc2 = true; continue; }
          if (c === quote) inStr = false;
          continue;
        }
        if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
        if (c === "{") od++;
        else if (c === "}") { od--; if (od === 0) { oEnd = j; break; } }
      }
      if (oEnd < 0) return null;
      const objText = js.slice(objBrace, oEnd + 1);
      const helper = new Function("return (" + objText + ")")();
      const rewritten = body.replace(new RegExp("\\b" + objName + "\\.", "g"), "H.");
      const fn = new Function("H", "return function(a){" + rewritten + "};")(helper);
      // 自检：真函数至少要能把任意串原样变换回来
      if (typeof fn("0123456789abcdef") !== "string") return null;
      return fn;
    } catch (e) {
      console.warn("[BiliDL] 签名函数解析失败", e);
      return null;
    }
  }

  function ytQueryOf(text) {
    const out = {};
    String(text || "").replace(/^[?&]/, "").split("&").forEach((kv) => {
      if (!kv) return;
      const i = kv.indexOf("=");
      const k = i < 0 ? kv : kv.slice(0, i);
      const v = i < 0 ? "" : kv.slice(i + 1);
      out[decodeURIComponent(k)] = decodeURIComponent(v);
    });
    return out;
  }

  /** 把 player 里的 formats 解析成可直接下载的 url。 */
  function ytFormatUrl(fmt, decipher) {
    if (fmt.url) return fmt.url;
    const cipher = fmt.signatureCipher || fmt.cipher;
    if (!cipher) return "";
    const q = ytQueryOf(cipher);
    if (!q.url) return "";
    if (!q.s) return q.url;
    if (!decipher) return "";
    let sig = null;
    try { sig = decipher(q.s); } catch (e) { sig = null; }
    if (!sig) return "";
    const sp = q.sp || "signature";
    return q.url + (q.url.includes("?") ? "&" : "?") + sp + "=" + encodeURIComponent(sig);
  }

  function ytPickFormats(player, height) {
    const sd = player.streamingData || {};
    const progressive = (sd.formats || []).filter((f) => f.url || f.signatureCipher || f.cipher);
    const adaptive = (sd.adaptiveFormats || []).filter((f) => f.url || f.signatureCipher || f.cipher);
    const byHeight = (list, h) => list
      .filter((f) => {
        const m = String(f.mimeType || "").match(/codecs="([^"]+)"/);
        const codec = m ? m[1] : "";
        const isAvc = codec.startsWith("avc1");
        return (f.height || 0) <= h;
      })
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
    const vs = byHeight(adaptive.filter((f) => String(f.mimeType || "").startsWith("video/")), height);
    const videos = vs.sort((a, b) => {
      const avc = (x) => (String(x.mimeType).includes("avc1") ? 1 : 0);
      return avc(b) - avc(a) || (b.bitrate || 0) - (a.bitrate || 0);
    });
    const audios = adaptive
      .filter((f) => String(f.mimeType || "").startsWith("audio/"))
      .sort((a, b) => {
        const mp4 = (x) => (String(x.mimeType || "").includes("mp4") ? 1 : 0);
        return mp4(b) - mp4(a) || (b.bitrate || 0) - (a.bitrate || 0);
      });
    const muxed = progressive.sort((a, b) => (b.height || 0) - (a.height || 0));
    return { videos, audios, muxed };
  }

  /**
   * 取播放数据：YouTube 现在常把 ytInitialPlayerResponse 里的直链整个删掉，
   * 所以先走 innertube 的 ANDROID_VR（仍直接返回带 url 的流），页面数据只做兜底。
   */
  async function ytLoadPlayer(url) {
    const vid = (ytDetect(url) || {}).ident || "";
    if (!vid) throw new Error("不是单个 YouTube 视频链接");
    const watch = "https://www.youtube.com/watch?v=" + vid;
    const html = await ytFetchText(watch);
    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || "";
    const visitor = (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1] || "";
    const webVer = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || "";
    const pagePlayer = ytExtractJson(html, "ytInitialPlayerResponse");
    const fs = (x) => (x.streamingData && ((x.streamingData.formats || []).length + (x.streamingData.adaptiveFormats || []).length)) || 0;
    const hasUrl = (x) => !!((x.streamingData && ((x.streamingData.formats || []).concat(x.streamingData.adaptiveFormats || []))) || []).find((f) => f.url);
    const errors = [];
    for (const [name, cver, cnum] of [["ANDROID_VR", "1.60.19", "28"], ["WEB", webVer, "1"]]) {
      if (!cver) continue;
      try {
        const client = { clientName: name, clientVersion: cver, hl: "zh-CN", gl: "US" };
        if (visitor) client.visitorData = visitor;
        const headers = { "X-Youtube-Client-Name": cnum, "X-Youtube-Client-Version": cver };
        if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
        const data = await ytPostJson(
          "https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=" + encodeURIComponent(key),
          { context: { client }, videoId: vid, contentCheckOk: true, racyCheckOk: true },
          headers
        );
        const st = (data.playabilityStatus || {}).status;
        if (st && st !== "OK") {
          const reason = (data.playabilityStatus || {}).reason || st;
          errors.push(name + "：" + reason);
          continue;
        }
        if (!fs(data)) { errors.push(name + "：没有可用格式"); continue; }
        const jsUrl = (data.assets && (data.assets.js || data.assets.jsUrl)) || (html.match(/"jsUrl":"([^"]+)"/) || [])[1] || "";
        let decipher = null;
        if (jsUrl && !hasUrl(data)) {
          try {
            const js = await ytFetchText(jsUrl.startsWith("http") ? jsUrl : "https://www.youtube.com" + jsUrl);
            decipher = ytBuildDecipher(js);
          } catch (e) {}
        }
        return { player: data, pagePlayer, watch, html, decipher };
      } catch (e) { errors.push(name + "：" + e.message); }
    }
    if (pagePlayer && fs(pagePlayer)) {
      const jsUrl = (pagePlayer.assets && (pagePlayer.assets.js || pagePlayer.assets.jsUrl)) || (html.match(/"jsUrl":"([^"]+)"/) || [])[1] || "";
      let decipher = null;
      if (jsUrl) {
        try {
          const js = await ytFetchText(jsUrl.startsWith("http") ? jsUrl : "https://www.youtube.com" + jsUrl);
          decipher = ytBuildDecipher(js);
        } catch (e) {}
      }
      if (hasUrl(pagePlayer) || decipher) return { player: pagePlayer, pagePlayer, watch, html, decipher };
    }
    throw new Error("取不到播放数据" + (errors.length ? "（" + errors.join("；") + "）" : "") + "：可先在浏览器里登录 YouTube 再试");
  }

  function ytToSrt(vtt) {
    const lines = String(vtt || "").replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    const fix = (t) => {
      const m = String(t).match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})/);
      if (!m) return t;
      const hh = String(m[1]).padStart(2, "0");
      return hh + ":" + m[2] + ":" + m[3] + "," + m[4];
    };
    for (let k = 0; k < lines.length; k++) {
      if (!/-->/.test(lines[k])) continue;
      const time = fix(lines[k].trim());
      const text = [];
      let j = k + 1;
      while (j < lines.length && lines[j].trim() !== "") { text.push(lines[j].trim()); j++; }
      const body = text.join(" ").replace(/<[^>]+>/g, "").trim();
      if (body) { i++; out.push(`${i}\n${time}\n${body}\n`); }
      k = j;
    }
    return out.join("\n");
  }

  async function ytExtraFiles(info, nameFor) {
    const made = [];
    if (conf.exCover && info.thumb) {
      await blobDownload({ url: info.thumb, name: nameFor("jpg", "") }).catch(() => {});
      made.push("封面");
    }
    if (conf.exNfo) {
      const e = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const nfo = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<movie>\n  <title>${e(info.title)}</title>\n  <uniqueid type="youtube" default="true">${e(info.id)}</uniqueid>\n  <plot>${e(info.desc)}</plot>\n  <premiered>${e(info.date)}</premiered>\n  <studio>${e(info.author)}</studio>\n  <thumb>${e(info.thumb)}</thumb>\n</movie>\n`;
      if (textDownload(nameFor("nfo", ""), nfo, "application/xml")) made.push("NFO");
    }
    if (conf.exSub && info.subs && info.subs.length) {
      const track = info.subs.find((s) => /^(zh|en)/.test(s.lang)) || info.subs[0];
      try {
        const vtt = await ytFetchText(track.url + (track.url.includes("?") ? "&" : "?") + "fmt=vtt");
        const srt = ytToSrt(vtt);
        if (srt && textDownload(nameFor("srt", track.lang), srt)) made.push("字幕SRT");
      } catch (e) { console.warn("[BiliDL] 字幕失败", e); }
    }
    if (conf.exDm) toast("YouTube 视频没有弹幕，已跳过弹幕项");
    if (made.length) toast("附加文件：" + made.join("、"));
  }

  async function buildYouTubeJobs(url) {
    const det = ytDetect(url);
    if (!det || det.kind !== "yt_video") throw new Error("只支持单个 YouTube 视频链接");
    const { player, pagePlayer, watch, decipher } = await ytLoadPlayer(url);
    const vd = player.videoDetails || (pagePlayer && pagePlayer.videoDetails) || {};
    const height = YT_HEIGHT[conf.quality] || 1080;
    const { videos, audios, muxed } = ytPickFormats(player, height);
    const title = vd.title || "";
    const author = vd.author || "";
    const channelId = vd.channelId || "";
    const date = vd.publishDate || "";
    const thumb = ((vd.thumbnail && vd.thumbnail.thumbnails) || []).slice(-1)[0];
    const qualityName = QN_NAME[conf.quality] || String(conf.quality);
    const vars = {
      video_title: title, video_id: vd.videoId || det.ident, video_episode: 1,
      video_page_title: "", video_author: author, video_quality: qualityName.replace(/P.*$/, "P") ,
      video_date: date, video_author_uid: channelId,
      youtube_id: vd.videoId || det.ident, youtube_channel: author, youtube_channel_id: channelId,
    };
    vars.video_quality = qualityName;
    const nameFor = (ext, suffix) => {
      let n = renderPath(conf.videoTpl, vars, ext);
      return suffix ? n.replace(/(\.[^.\/]+)$/, "-" + suffix + "$1") : n;
    };
    const jobs = [];
    const captionSrc = (player.captions || (pagePlayer && pagePlayer.captions) || {});
    const captionTracks = (captionSrc.playerCaptionsTracklistRenderer || {}).captionTracks || [];
    const subs = captionTracks.map((t) => ({
      lang: (t.languageCode || "und") + (t.kind === "asr" ? "-auto" : ""),
      url: t.baseUrl,
    })).filter((s) => s.url);
    const extra = { yt: true, info: { id: vd.videoId || det.ident, title, author, channelId, date, thumb: thumb ? thumb.url : "", desc: vd.shortDescription || "", subs }, nameFor };

    const usable = (f) => {
      const u = ytFormatUrl(f, decipher);
      return u ? { url: u, size: Number(f.contentLength || 0), height: f.height || 0, quality: QN_NAME[conf.quality] || "" } : null;
    };

    if (conf.exAudio) {
      const a = audios.map(usable).filter(Boolean)[0];
      if (!a) throw new Error("取不到纯音频轨（可能需要代理或登录）");
      jobs.push({ kind: "audio", title: title + "（音频轨）", url: a.url, headers: {}, name: nameFor("m4a", ""), status: "wait", size: a.size, quality: qualityName, extra });
    } else if (conf.exVideoMute) {
      const v = videos.map(usable).filter(Boolean)[0];
      if (!v) throw new Error("取不到视频轨（可能需要代理或登录）");
      jobs.push({ kind: "video", title: title + "（无声）", url: v.url, headers: {}, name: nameFor("mp4", "mute"), status: "wait", size: v.size, quality: qualityName, extra });
    } else {
      const mux = muxed.map(usable).filter(Boolean).filter((x) => !height || x.height <= height)[0];
      const wantSplit = (videos.length && audios.length) && (!mux || mux.height < Math.min(height, videos[0].height || 0));
      if (mux && !wantSplit) {
        jobs.push({ kind: "video", title, url: mux.url, headers: {}, name: nameFor("mp4", ""), status: "wait", size: mux.size, quality: qualityName, extra });
      } else {
        const v = videos.map(usable).filter(Boolean)[0];
        if (!v) throw new Error("取不到视频流（可能需要代理或登录）");
        const a = audios.map(usable).filter(Boolean)[0];
        jobs.push({ kind: "video", title: title + "（视频轨）", url: v.url, headers: {}, name: nameFor("mp4", "v"), status: "wait", size: v.size, quality: qualityName, extra });
        if (a) jobs.push({ kind: "audio", title: title + "（音频轨）", url: a.url, headers: {}, name: nameFor("m4a", "a"), status: "wait", size: a.size, quality: qualityName, extra: { ...extra, skipExtras: true } });
        toast("浏览器无法合并音视频：已拆成视频轨 + 音频轨两个文件（用 EXE / Docker / APK 版可直接出单文件）", 6000);
      }
    }
    return jobs;
  }

  /** 频道 / 播放列表页：从页面数据里抓视频 id，逐个建任务（最多 30 个，避免一次刷爆）。 */
  async function ytListVideos(url, limit) {
    const html = await ytFetchText(url);
    const ids = [];
    const seen = new Set();
    const data = ytExtractJson(html, "ytInitialData");
    const walk = (node) => {
      if (!node || ids.length >= limit) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== "object") return;
      if (node.videoId && YT_VID_RE.test(node.videoId) && !seen.has(node.videoId)) {
        seen.add(node.videoId);
        ids.push(node.videoId);
      }
      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(data);
    if (!ids.length) {
      const re = /"videoId":"([0-9A-Za-z_-]{11})"/g;
      let m;
      while ((m = re.exec(html)) && ids.length < limit) {
        if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); }
      }
    }
    return ids;
  }

  /* ---------------------------------------------- YouTube 专用面板（独立版）
     YouTube 页面启用 Trusted Types，B站 那套 innerHTML 面板在这里会直接抛错，
     所以 YouTube 上用纯 DOM API 建一个独立小面板：推送到服务端 + 浏览器直接下载。
  ------------------------------------------------------------------------ */
  const YT_CSS = [
    "#bilidl-yt-fab{position:fixed;right:16px;bottom:24px;z-index:2147483600;display:flex;align-items:center;gap:6px;",
    "padding:9px 14px;border-radius:22px;background:#ff0033;color:#fff;font:600 13px/1 \"PingFang SC\",\"Microsoft YaHei\",sans-serif;",
    "box-shadow:0 6px 20px rgba(255,0,51,.45);cursor:pointer;user-select:none;border:0}",
    "#bilidl-yt-fab:hover{background:#ff1f49}",
    "#bilidl-yt{position:fixed;right:16px;bottom:78px;z-index:2147483600;width:288px;padding:11px 12px;border-radius:12px;",
    "background:rgba(18,20,26,.98);border:1px solid #ff0033;color:#eef2f7;box-shadow:0 12px 34px rgba(0,0,0,.55);",
    "font:12px/1.5 \"PingFang SC\",\"Microsoft YaHei\",sans-serif}",
    "#bilidl-yt .yt-h{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:13px;margin-bottom:6px;color:#ff5c77}",
    "#bilidl-yt .yt-h span{white-space:nowrap}",
    "#bilidl-yt .yt-x{border:0;background:transparent;color:#93a0b0;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}",
    "#bilidl-yt .yt-info{color:#9fb0c3;margin-bottom:8px;word-break:break-all}",
    "#bilidl-yt .yt-row{display:flex;flex-direction:column;gap:6px;margin-bottom:6px}",
    "#bilidl-yt button{border:0;border-radius:7px;padding:8px 9px;font-size:12px;cursor:pointer;width:100%;text-align:center}",
    "#bilidl-yt .yt-main{background:#ff0033;color:#fff;font-weight:600}",
    "#bilidl-yt .yt-alt{background:#2b3240;color:#dbe6f3}",
    "#bilidl-yt .yt-log{margin-top:6px;color:#8ea1b6;min-height:16px;word-break:break-all}",
    "#bilidl-yt .yt-tip{margin-top:6px;color:#6f7d8d;font-size:11px;word-break:break-all}",
    "#bilidl-yt .yt-tip a{color:#7fb3ff}",
    "#bilidl-yt .yt-sel{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;font-size:11px;color:#9fb0c3}",
    "#bilidl-yt .yt-sel-lab{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none}",
    "#bilidl-yt .yt-sel-n b{color:#ff5c77;font-weight:600}",
    "#bilidl-yt .yt-row2{display:flex;gap:6px;margin-top:6px}",
    "#bilidl-yt .yt-row2 button{width:auto;flex:1;padding:7px 2px;font-size:11.5px}",
    "#bilidl-yt .yt-mini{background:#2b3240;color:#dbe6f3}",
    "#bilidl-yt button:disabled{opacity:.45;cursor:not-allowed}",
    "html[data-bilidl-ytsel=\"1\"] .bilidl-ytsel{display:block}",
    ".bilidl-ytsel{position:absolute;left:8px;top:8px;z-index:2147482000;display:none;width:22px;height:22px;border-radius:6px;",
    "border:2px solid rgba(255,255,255,.92);background:rgba(0,0,0,.45);cursor:pointer;padding:0;box-shadow:0 2px 8px rgba(0,0,0,.45)}",
    ".bilidl-ytsel.on{display:block;background:#ff0033;border-color:#ff0033}",
    ".bilidl-ytsel.on::after{content:'\\2713';position:absolute;inset:0;color:#fff;font:700 14px/19px sans-serif;text-align:center}",
  ].join("");

  function ytServer() {
    try { return (localStorage.getItem("bilidl.sa.server") || "http://127.0.0.1:2197").replace(/\/+$/, ""); }
    catch (e) { return "http://127.0.0.1:2197"; }
  }
  function ytSetServer(v) {
    try { localStorage.setItem("bilidl.sa.server", String(v || "").trim().replace(/\/+$/, "")); } catch (e) {}
  }
  // 只探活（不改全局地址）
  function ytProbeBase(base) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest !== "function") return resolve(false);
      try {
        GM_xmlhttpRequest({
          method: "GET",
          url: base.replace(/\/+$/, "") + "/api/status",
          timeout: 4000,
          onload: (r) => resolve(r && r.status >= 200 && r.status < 300),
          onerror: () => resolve(false),
          ontimeout: () => resolve(false),
        });
      } catch (e) {
        resolve(false);
      }
    });
  }

  // 端口写错时自动纠正：同主机依次试 2197 / 2196 / 2917（当前默认 2197）
  async function ytAutoFixServer() {
    const cur = ytServer();
    let host = cur.replace(/^https?:\/\//i, "").split("/")[0];
    host = host.split(":")[0] || "127.0.0.1";
    for (const base of [cur, "http://" + host + ":2197", "http://" + host + ":2196", "http://" + host + ":2917"]) {
      if (await ytProbeBase(base)) {
        const fixed = base.replace(/\/+$/, "");
        if (fixed !== cur) { ytSetServer(fixed); ytLog("服务端地址已自动纠正为 " + fixed); }
        return fixed;
      }
    }
    return "";
  }

  function ytServerRequest(path, body) {
    const url = ytServer() + path;
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== "function") return reject(new Error("缺少 GM_xmlhttpRequest"));
      GM_xmlhttpRequest({
        method: "POST", url, timeout: 30000,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(body || {}),
        onload: (r) => {
          let payload = null;
          try { payload = JSON.parse(r.responseText); } catch (e) { return reject(new Error("服务端返回的不是 JSON（HTTP " + r.status + "）")); }
          if (!payload || !payload.ok) return reject(new Error((payload && payload.error) || "请求失败"));
          resolve(payload.data);
        },
        onerror: () => reject(new Error("连不上服务端：" + url + "（独立版不依赖服务端，可直接用「浏览器直接下载」）")),
        ontimeout: () => reject(new Error("请求服务端超时")),
      });
    });
  }

  function ytEl(tag, cls, id, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (id) el.id = id;
    if (text != null) el.textContent = text;
    return el;
  }

  // ---------------- YouTube 多选批量（与 B站 空间页多选体验一致） ----------------
  const YT_CARD_SEL = "ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-video-item-renderer, yt-lockup-view-model";
  let ytSelMode = false;
  const ytPicked = new Map();

  function ytCards() {
    const out = new Map();
    const links = document.querySelectorAll('a[href*="watch?v="]');
    for (const a of links) {
      const vid = ((a.getAttribute("href") || "").match(/[?&]v=([0-9A-Za-z_-]{11})/) || [])[1];
      if (!vid) continue;
      const card = a.closest(YT_CARD_SEL);
      if (!card) continue;
      if (!out.has(vid)) {
        let title = "";
        const t = card.querySelector("#video-title, a#video-title-link, #video-title-link, h3 a");
        if (t) title = (t.getAttribute("title") || t.textContent || "").trim();
        if (!title) title = (a.getAttribute("title") || a.textContent || "").trim();
        out.set(vid, { id: vid, title: title || vid, url: "https://www.youtube.com/watch?v=" + vid });
      }
      // 勾选框挂在卡片本身（YouTube 新旧两套布局的缩略图容器名不一样，卡片一定存在）
      const host = card;
      const hostEl = host.closest("ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-video-item-renderer, yt-lockup-view-model") || host;
      if (!hostEl.querySelector(":scope > .bilidl-ytsel")) {
        try { if (getComputedStyle(hostEl).position === "static") hostEl.style.position = "relative"; } catch (e) {}
        const box = document.createElement("button");
        box.type = "button";
        box.className = "bilidl-ytsel" + (ytPicked.has(vid) ? " on" : "");
        box.dataset.vid = vid;
        box.title = "选中这个视频（批量推送 / 批量下载）";
        box.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); ytToggleSel(vid); }, true);
        hostEl.appendChild(box);
      }
    }
    return [...out.values()];
  }

  function ytTitleOf(vid) {
    const card = ytCards().find((c) => c.id === vid);
    return card || { id: vid, title: vid, url: "https://www.youtube.com/watch?v=" + vid };
  }

  function ytToggleSel(vid) {
    if (ytPicked.has(vid)) ytPicked.delete(vid);
    else ytPicked.set(vid, ytTitleOf(vid));
    ytSyncSel();
  }

  function ytSyncSel() {
    document.querySelectorAll(".bilidl-ytsel").forEach((b) => b.classList.toggle("on", ytPicked.has(b.dataset.vid)));
    const n = document.getElementById("bilidl-yt-selcount");
    if (n) n.textContent = String(ytPicked.size);
    ["bilidl-yt-bpush", "bilidl-yt-bdl", "bilidl-yt-clear"].forEach((id) => {
      const b = document.getElementById(id);
      if (b) b.disabled = ytPicked.size === 0;
    });
  }

  function ytSetSelMode(on) {
    ytSelMode = !!on;
    try { document.documentElement.dataset.bilidlYtsel = ytSelMode ? "1" : "0"; } catch (e) {}
    if (ytSelMode) { ytCards(); toast("多选模式已开启：点视频封面即选中"); }
    else toast("多选模式已关闭：封面恢复点击播放");
    ytSyncSel();
  }

  function ytSelectPage() {
    const cards = ytCards();
    if (!cards.length) return toast("这个页面里没找到视频卡片");
    let added = 0;
    for (const c of cards) if (!ytPicked.has(c.id)) { ytPicked.set(c.id, c); added++; }
    ytSyncSel();
    toast("本页共 " + cards.length + " 个视频" + (added ? "，新选中 " + added + " 个" : "，已全部选中"));
  }

  function ytClearSel() {
    ytPicked.clear();
    ytSyncSel();
    toast("已清空选择");
  }

  function ytBatchBody() {
    const det = ytDetect(location.href) || {};
    // 只有真正的播放列表页才把列表名当合辑名；频道页/视频页/搜索页一律不带，
    // 否则模板里的 <videolist_title>/ 会按「当前页面标题」建文件夹，把多选的其它视频塞进去。
    const isList = det.kind === "yt_playlist";
    const seasonId = isList ? String(det.ident || "") : "";
    const seasonTitle = isList ? String(document.title || "").replace(/\s*-\s*YouTube\s*$/, "") : "";
    return {
      videos: [...ytPicked.values()].map((it, i) => ({
        bvid: it.id,
        source: "youtube",
        video_title: it.title,
        author: it.author || "",
        web_url: it.url,
        season_id: seasonId,
        season_title: seasonTitle,
        season_order: seasonId ? i + 1 : 0,
      })),
    };
  }

  /** 批量推送到服务端下载。 */
  async function ytBatchPush() {
    const items = [...ytPicked.values()];
    if (!items.length) return toast("先勾选视频（开「多选」后点封面，或点「全选本页」）");
    ytLog("正在推送 " + items.length + " 个视频到 " + ytServer() + " …");
    const body = ytBatchBody();
    try {
      await ytServerRequest("/api/download", body);
      ytLog("已推送 " + items.length + " 个视频到 " + ytServer());
      toast("已推送 " + items.length + " 个视频");
    } catch (e) {
      ytLog("批量推送失败：" + e.message);
      const fixed = await ytAutoFixServer();
      if (fixed) {
        try {
          await ytServerRequest("/api/download", body);
          ytLog("已推送 " + items.length + " 个视频（地址已自动纠正为 " + fixed + "）");
          toast("已推送 " + items.length + " 个视频");
          return;
        } catch (e0) {
          ytLog("自动纠正后仍失败：" + e0.message);
        }
      }
      toast("批量推送失败：" + e.message + "（可直接用「批量下载」）");
    }
  }

  /** 批量浏览器下载：逐个解析 → 进下载队列。 */
  async function ytBatchDownload() {
    const items = [...ytPicked.values()];
    if (!items.length) return toast("先勾选视频（开「多选」后点封面，或点「全选本页」）");
    if (!confirm("浏览器直接下载 " + items.length + " 个视频？\n（1080P 以上会拆成视频轨 + 音频轨两个文件）")) return;
    let done = 0, failed = 0;
    for (let i = 0; i < items.length; i++) {
      try {
        ytLog("（" + (i + 1) + "/" + items.length + "）解析 " + String(items[i].title).slice(0, 32) + "…");
        const jobs = await buildYouTubeJobs(items[i].url);
        for (const job of jobs) {
          ytLog("（" + (i + 1) + "/" + items.length + "）下载 " + String(job.name).split("/").pop());
          enqueue(job);
        }
        done++;
      } catch (e) {
        failed++;
        pushLog("warn", "跳过 " + items[i].url + "：" + e.message);
      }
    }
    ytLog("已加入队列：成功 " + done + " 个" + (failed ? "，失败 " + failed + " 个" : ""));
    toast("浏览器下载：" + done + " 个" + (failed ? "，失败 " + failed : ""));
  }

  /** 多选模式下拦截卡片点击：不再跳转，改成选中。 */
  function ytInstallSelGuards() {
    if (ytInstallSelGuards.done) return;
    ytInstallSelGuards.done = true;
    document.addEventListener("click", (ev) => {
      if (!ytSelMode) return;
      const box = ev.target && ev.target.closest ? ev.target.closest(".bilidl-ytsel") : null;
      if (box) { ev.preventDefault(); ev.stopPropagation(); ytToggleSel(box.dataset.vid); return; }
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href*="watch?v="]') : null;
      if (!a) return;
      const vid = ((a.getAttribute("href") || "").match(/[?&]v=([0-9A-Za-z_-]{11})/) || [])[1];
      if (!vid) return;
      ev.preventDefault();
      ev.stopPropagation();
      ytToggleSel(vid);
    }, true);
  }

  function ytLog(text) {
    const el = document.getElementById("bilidl-yt-log");
    if (el) el.textContent = text;
  }

  function ytRefreshInfo() {
    const el = document.getElementById("bilidl-yt-info");
    if (!el) return;
    const det = ytDetect(location.href);
    const map = { yt_video: "YouTube 视频", yt_channel: "YouTube 频道", yt_playlist: "播放列表" };
    el.textContent = det ? (map[det.kind] || det.kind) + " · " + (det.ident || "") : "打开任意 YouTube 视频/频道页即可使用";
  }

  function ytPushBody(det) {
    if (det.kind === "yt_video") return { links: "https://www.youtube.com/watch?v=" + det.ident };
    // 只有真正的播放列表页才把列表名当合辑名；频道页/搜索页不带，避免按当前页标题建文件夹
    const isList = det.kind === "yt_playlist";
    const seasonId = isList ? String(det.ident || "") : "";
    const seasonTitle = isList ? String(document.title || "").replace(/\s*-\s*YouTube\s*$/, "") : "";
    return ytListVideos(location.href, 20).then((ids) => ids.length
      ? { videos: ids.map((id, i) => ({ bvid: id, source: "youtube", video_title: id, season_id: seasonId, season_title: seasonTitle, season_order: seasonId ? i + 1 : 0 })) }
      : { links: location.href });
  }

  async function ytPushCurrent() {
    const det = ytDetect(location.href);
    if (!det) return toast("当前页面不是 YouTube 视频 / 频道 / 播放列表页");
    ytLog("正在推送到服务端…");
    try {
      await ytServerRequest("/api/download", await ytPushBody(det));
      ytLog("已推送到 " + ytServer());
      toast("已推送到服务端");
    } catch (e) {
      ytLog("推送失败：" + e.message);
      const fixed = await ytAutoFixServer();
      if (fixed) {
        try {
          await ytServerRequest("/api/download", await ytPushBody(det));
          ytLog("已推送到 " + ytServer() + "（地址已自动纠正）");
          toast("已推送到服务端");
          return;
        } catch (e0) {
          ytLog("自动纠正后仍失败：" + e0.message);
        }
      }
      toast("推送失败：" + e.message, "err");
      const pick = window.confirm(
        "连不上服务端：" + ytServer() + "\n\n" +
        "点「确定」= 换一个服务端地址后重试（例如 Docker 装在 NAS 上，填 http://NAS的IP:2197）\n" +
        "点「取消」= 改用「浏览器直接下载」（不需要服务端）"
      );
      if (!pick) return ytDownloadCurrent();
      const addr = window.prompt("BiliDL 服务端地址（http://IP:2197）", ytServer());
      if (!addr) return;
      ytSetServer(addr);
      ytLog("服务端已改为 " + ytServer() + "，重试…");
      try {
        await ytServerRequest("/api/download", await ytPushBody(det));
        ytLog("已推送到 " + ytServer());
        toast("已推送到服务端");
      } catch (e2) {
        ytLog("仍然连不上：" + e2.message);
        toast("推送失败，可改用「浏览器直接下载」", "err");
      }
    }
  }

  async function ytDownloadCurrent() {
    const det = ytDetect(location.href);
    if (!det) return toast("当前页面不是 YouTube 视频 / 频道 / 播放列表页");
    let urls = [];
    if (det.kind === "yt_video") {
      urls = ["https://www.youtube.com/watch?v=" + det.ident];
    } else {
      ytLog("正在读取列表…");
      const ids = await ytListVideos(location.href, 30);
      if (!ids.length) return toast("这个页面里没找到视频链接");
      if (!confirm("找到 " + ids.length + " 个视频，全部下载到浏览器？\n（1080P 以上会拆成视频轨 + 音频轨两个文件，浏览器无法合并）")) return;
      urls = ids.map((id) => "https://www.youtube.com/watch?v=" + id);
    }
    let done = 0, failed = 0;
    for (let i = 0; i < urls.length; i++) {
      try {
        ytLog("（" + (i + 1) + "/" + urls.length + "）解析中…");
        const jobs = await buildYouTubeJobs(urls[i]);
        for (const job of jobs) {
          ytLog("（" + (i + 1) + "/" + urls.length + "）下载 " + String(job.name).split("/").pop());
          enqueue(job);
        }
        done++;
      } catch (e) {
        failed++;
        pushLog("warn", "跳过 " + urls[i] + "：" + e.message);
      }
    }
    ytLog("已加入队列：成功 " + done + " 个" + (failed ? "，失败 " + failed + " 个" : ""));
    toast("浏览器下载：" + done + " 个" + (failed ? "，失败 " + failed : ""));
  }

  function ytInjectCss() {
    if (document.getElementById("bilidl-yt-css")) return;
    const st = document.createElement("style");
    st.id = "bilidl-yt-css";
    st.textContent = YT_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // 面板默认收起：打开网页只显示右下角悬浮按钮，点了才展开（不记忆状态，避免下次自动弹出）
  let ytPanelOpen = false;
  function ytPanelHidden() { return !ytPanelOpen; }

  function ytSetHidden(v) {
    ytPanelOpen = !v;
    const box = document.getElementById("bilidl-yt");
    if (box) box.style.display = ytPanelOpen ? "block" : "none";
    const fab = document.getElementById("bilidl-yt-fab");
    if (fab) fab.title = ytPanelOpen ? "收起下载面板" : "BiliDL 独立版：打开下载面板（浏览器直接下载 / 推送到服务端）";
  }

  function ytMountPanel() {
    if (!isYouTubeUrl(location.href) && !/youtube\.com$|youtu\.be$/i.test(location.hostname)) return;
    if (!document.body) return;
    ytInjectCss();

    if (!document.getElementById("bilidl-yt-fab")) {
      const fab = ytEl("button", null, "bilidl-yt-fab", "⬇ YouTube 下载");
      fab.type = "button";
      fab.title = "BiliDL 独立版：直接在浏览器下载，或推送到服务端下载";
      fab.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const box = document.getElementById("bilidl-yt");
        const hidden = box ? box.style.display === "none" : ytPanelHidden();
        ytSetHidden(!hidden);
      });
      document.body.appendChild(fab);
    }

    if (document.getElementById("bilidl-yt")) return;
    const box = ytEl("div", null, "bilidl-yt");
    const head = ytEl("div", "yt-h");
    head.appendChild(ytEl("span", null, null, "YouTube 下载（独立版）v1.6.2"));
    const close = ytEl("button", "yt-x", "bilidl-yt-close", "×");
    close.type = "button";
    close.title = "收起面板（右下角红色按钮可再次打开）";
    head.appendChild(close);
    const info = ytEl("div", "yt-info", "bilidl-yt-info");
    const row1 = ytEl("div", "yt-row");
    const dl = ytEl("button", "yt-main", "bilidl-yt-dl", "浏览器直接下载（本版本无需服务端）");
    dl.type = "button";
    const push = ytEl("button", "yt-alt", "bilidl-yt-push", "推送到服务端下载");
    push.type = "button";
    row1.appendChild(dl);
    row1.appendChild(push);
    const log = ytEl("div", "yt-log", "bilidl-yt-log");

    // ---- 多选批量区 ----
    const selBar = ytEl("div", "yt-sel");
    const selLab = ytEl("label", "yt-sel-lab");
    const selCb = ytEl("input");
    selCb.type = "checkbox";
    selCb.id = "bilidl-yt-selmode";
    selCb.checked = ytSelMode;
    selLab.appendChild(selCb);
    selLab.appendChild(document.createTextNode(" 多选（点封面即选中）"));
    const selCount = ytEl("span", "yt-sel-n");
    selCount.appendChild(document.createTextNode("已选 "));
    selCount.appendChild(ytEl("b", null, "bilidl-yt-selcount", String(ytPicked.size)));
    selCount.appendChild(document.createTextNode(" 个"));
    selBar.appendChild(selLab);
    selBar.appendChild(selCount);

    const bar2 = ytEl("div", "yt-row2");
    const allBtn = ytEl("button", "yt-mini", "bilidl-yt-all", "全选本页");
    allBtn.type = "button";
    const clearBtn = ytEl("button", "yt-mini", "bilidl-yt-clear", "清空");
    clearBtn.type = "button";
    bar2.appendChild(allBtn);
    bar2.appendChild(clearBtn);

    const bar3 = ytEl("div", "yt-row2");
    const bpush = ytEl("button", "yt-main", "bilidl-yt-bpush", "批量推送");
    bpush.type = "button";
    const bdl = ytEl("button", "yt-alt", "bilidl-yt-bdl", "批量下载");
    bdl.type = "button";
    bar3.appendChild(bpush);
    bar3.appendChild(bdl);

    const tip = ytEl("div", "yt-tip");
    tip.appendChild(document.createTextNode("服务端："));
    tip.appendChild(ytEl("span", null, "bilidl-yt-srv", ytServer()));
    tip.appendChild(document.createTextNode(" · "));
    const setA = ytEl("a", null, "bilidl-yt-set", "修改");
    setA.href = "#";
    tip.appendChild(setA);
    [head, info, row1, selBar, bar2, bar3, log, tip].forEach((n) => box.appendChild(n));
    document.body.appendChild(box);
    box.style.display = ytPanelOpen ? "block" : "none";

    close.addEventListener("click", (e) => { if (e) e.preventDefault(); ytSetHidden(true); });
    push.addEventListener("click", (e) => { e.preventDefault(); ytPushCurrent(); });
    dl.addEventListener("click", (e) => { e.preventDefault(); ytDownloadCurrent().catch((err) => { ytLog("下载失败：" + err.message); toast(err.message); }); });
    selCb.addEventListener("change", () => ytSetSelMode(selCb.checked));
    allBtn.addEventListener("click", (e) => { e.preventDefault(); ytSelectPage(); });
    clearBtn.addEventListener("click", (e) => { e.preventDefault(); ytClearSel(); });
    bpush.addEventListener("click", (e) => { e.preventDefault(); ytBatchPush(); });
    bdl.addEventListener("click", (e) => { e.preventDefault(); ytBatchDownload().catch((err) => { ytLog("批量下载失败：" + err.message); toast(err.message); }); });
    ytSyncSel();
    setA.addEventListener("click", (e) => {
      e.preventDefault();
      const v = prompt("BiliDL 服务端地址（推送用；不填就用浏览器直接下载）", ytServer());
      if (v) {
        ytSetServer(v);
        const srv = document.getElementById("bilidl-yt-srv");
        if (srv) srv.textContent = ytServer();
      }
    });
    ytRefreshInfo();
  }

  function ytBoot() {
    try {
      window.__bilidlSA = window.__bilidlSA || {};
      Object.assign(window.__bilidlSA, { buildYouTubeJobs, ytDetect, ytBuildDecipher, ytExtractJson, ytToSrt, ytListVideos, ytPushCurrent, ytDownloadCurrent, ytCards, ytSelectPage, ytClearSel, ytBatchPush, ytBatchDownload, ytSetSelMode, ytPicked });
    } catch (e) {}
    ytInstallSelGuards();
    ytMountPanel();
    let last = "";
    setInterval(() => {
      ytMountPanel();
      if (ytSelMode) { ytCards(); ytSyncSel(); }
      if (location.href !== last) { last = location.href; ytRefreshInfo(); }
    }, 1200);
    ["yt-navigate-finish", "yt-page-data-updated"].forEach((ev) => {
      window.addEventListener(ev, () => { ytMountPanel(); ytRefreshInfo(); }, true);
    });
  }

  // YouTube 页面：复用 B站 面板，但藏掉账号登录（YouTube 不需要），补一句清晰度换算说明
  function applyYouTubePanel() {
    document.querySelectorAll("#bilidl-sa-panel .sa-sec").forEach((sec) => {
      const h = sec.querySelector(".sa-h");
      if (h && /^账号$/.test((h.textContent || "").trim())) sec.remove();
    });
    const note = $("#bilidl-sa-curnote");
    if (note) note.textContent = "自动识别本页的 YouTube 视频 / 频道 / 播放列表";
    const q = $("#bilidl-sa-quality");
    if (q && !$("#bilidl-sa-ytnote")) {
      const n = document.createElement("div");
      n.className = "sa-note";
      n.id = "bilidl-sa-ytnote";
      n.textContent = "YouTube 清晰度按上面选的档位换算（8K=4320P / 4K=2160P / 1080P60=1080P / 720P=720P / 360P=360P）；浏览器直下 1080P 以上会自动拆成视频轨 + 音频轨两个文件。";
      q.closest("label").insertAdjacentElement("afterend", n);
    }
  }

  function boot() {
    // YouTube：以前挂的是一套精简面板（没有清晰度/命名/附加文件），现在和 B站 共用同一套
    // 下载设置面板与多选条；只把账号登录、评论抓取这些 B站 专有的区块藏掉。
    const onYT = /youtube\.com$|youtu\.be$/i.test(location.hostname);
    injectCss();
    buildPanel();
    if (onYT) applyYouTubePanel();
    cmtInjectCss();
    cmtSchedule();
    // 首屏/懒加载兜底：前几秒多扫几次，不依赖某一次 DOM 变化
    [300, 900, 1800, 3500, 6000].forEach((ms) => setTimeout(cmtSchedule, ms));
    if (isLive) {
      const feed = document.querySelector(".room-feed, .bili-dyn-list");
      if (feed) cmtObserve(feed);
    }
    new MutationObserver(() => cmtSchedule()).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener("scroll", () => cmtSchedule(), { passive: true });
    if (selMode) scheduleMount();
    try {
      if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("打开 BiliDL 设置面板", () => { $("#bilidl-sa-panel").classList.add("on"); renderPanel(); });
      GM_registerMenuCommand("切换多选模式", () => setSelMode(!selMode));
    } catch (err) {
      console.warn("[BiliDL] GM_registerMenuCommand 不可用，跳过菜单项", err && err.message);
    }
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
