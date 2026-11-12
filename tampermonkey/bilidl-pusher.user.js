// ==UserScript==
// @name         BiliDL 推送助手
// @namespace    https://github.com/bilidl
// @version      2.4.1
// @description  把 B站 / 抖音 / 小红书 / YouTube 视频与图文推送到本地 BiliDL 下载；B站 UP 主作品页、抖音主页/推荐/搜索、小红书发现页/用户主页等列表均可勾选多选，批量推送下载；抖音/小红书已知作品 ID 时与 B站 一样毫秒建任务（不等解析）；点推送立刻反馈、服务端后台确认（支持批量、短链、YouTube 视频/频道/播放列表）
// @author       BiliDL
// @match        https://www.bilibili.com/*
// @match        https://b23.tv/*
// @match        https://t.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://m.bilibili.com/*
// @match        https://live.bilibili.com/*
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @match        https://youtu.be/*
// @match        https://www.douyin.com/*
// @match        https://v.douyin.com/*
// @match        https://www.iesdouyin.com/*
// @match        https://www.xiaohongshu.com/*
// @match        https://*.rednote.com/*
// @match        https://xhslink.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      127.0.0.1
// @connect      localhost
// @connect      192.168.*
// @connect      10.*
// @connect      172.*
// @connect      *
// @connect      api.bilibili.com
// @connect      www.bilibili.com
// @connect      youtube.com
// @connect      www.youtube.com
// @connect      m.youtube.com
// @connect      youtu.be
// @connect      douyin.com
// @connect      iesdouyin.com
// @connect      douyinvod.com
// @connect      douyinpic.com
// @connect      xiaohongshu.com
// @connect      rednote.com
// @connect      xhscdn.com
// @connect      xhslink.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // GM_* 可能不可用（脚本被别的管理器注入、或 @grant 被剥离）：
  // 统一包一层，读不到就回落 localStorage，永久避免 "GM_getValue is not supported" 中断初始化。
  function gmGet(key, dft) {
    try { if (typeof GM_getValue === "function") { const v = GM_getValue(key, dft); if (v !== undefined && v !== null) return v; } } catch (e) {}
    try { const raw = localStorage.getItem("bilidl.gm." + key); if (raw !== null) return JSON.parse(raw); } catch (e) {}
    return dft;
  }
  function gmSet(key, val) {
    try { if (typeof GM_setValue === "function") GM_setValue(key, val); } catch (e) {}
    try { localStorage.setItem("bilidl.gm." + key, JSON.stringify(val)); } catch (e) {}
  }

  // 推送助手原来没有本地下载实现（评论图片点击会 ReferenceError），这里补一个：
  // 优先 GM_download（支持子目录），失败再走 GM_xmlhttpRequest + a[download] 平铺保存。
  function gmDownload(opt) {
    return new Promise((resolve, reject) => {
      const name = String(opt.name || "image").split(/[\\/]/).filter(Boolean).pop() || "image";
      const fail = (e) => reject(e instanceof Error ? e : new Error(String(e || "下载失败")));
      const blob = () => {
        if (typeof GM_xmlhttpRequest !== "function") return fail("当前脚本管理器不支持下载");
        GM_xmlhttpRequest({
          method: "GET", url: opt.url, responseType: "arraybuffer", timeout: 120000,
          headers: { Referer: "https://live.bilibili.com/" },
          onload: (r) => {
            const status = (r && r.status) || 0;
            if (status >= 400) return fail("HTTP " + status);
            try {
              const b = new Blob([r.response], { type: opt.mime || "image/png" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(b);
              a.download = name;
              a.style.display = "none";
              document.body.appendChild(a);
              a.click();
              setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 15000);
              resolve(true);
            } catch (e) { fail(e); }
          },
          onerror: () => fail("网络错误（可能被防盗链拦截）"),
          ontimeout: () => fail("下载超时"),
        });
      };
      if (typeof GM_download === "function") {
        try {
          GM_download({
            url: opt.url, name: opt.name, saveAs: false,
            onload: () => resolve(true),
            onerror: () => blob(),
            ontimeout: () => blob(),
          });
          return;
        } catch (e) { /* 继续走 blob 兜底 */ }
      }
      blob();
    });
  }

  const DEFAULT_SERVER = "http://127.0.0.1:2197";
  const getServer = () => (gmGet("server", DEFAULT_SERVER) || DEFAULT_SERVER).replace(/\/+$/, "");
  const setServer = (v) => gmSet("server", (v || DEFAULT_SERVER).replace(/\/+$/, ""));

  /* ---------------------------------------------------------------- 工具 */
  function request(method, path, body) {
    const url = getServer() + path;
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const handler = (res) => {
        let payload;
        try {
          payload = JSON.parse(res.responseText);
        } catch (err) {
          reject(new Error("返回内容不是 JSON：HTTP " + res.status));
          return;
        }
        if (!payload.ok) {
          reject(new Error(payload.error || "请求失败"));
          return;
        }
        resolve(payload.data);
      };
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method,
          url,
          data,
          headers: { "Content-Type": "application/json" },
          timeout: 30000,
          onload: handler,
          onerror: () => reject(new Error("无法连接 BiliDL，请确认程序已启动：" + url)),
          ontimeout: () => reject(new Error("请求 BiliDL 超时")),
        });
      } else {
        // 没有 GM_xmlhttpRequest（例如直接贴脚本测试）时的兜底：
        // https 页面访问 http 本地服务会被浏览器的混合内容策略拦截，此时给明确提示
        const ctrl = typeof AbortController === "function" ? new AbortController() : null;
        const timer = setTimeout(() => ctrl && ctrl.abort(), 20000);
        fetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: data,
          signal: ctrl ? ctrl.signal : undefined,
        })
          .then((r) => r.json().then((p) => ({ status: r.status, payload: p })))
          .then(({ payload }) => {
            clearTimeout(timer);
            if (!payload || !payload.ok) {
              reject(new Error((payload && payload.error) || "请求失败"));
            } else {
              resolve(payload.data);
            }
          })
          .catch((err) => {
            clearTimeout(timer);
            const https = location.protocol === "https:";
            reject(
              new Error(
                "无法连接 BiliDL：" +
                  url +
                  (https && /^http:/i.test(getServer())
                    ? "（当前页面是 https，浏览器会拦截到 http 本地服务的请求；装成 Tampermonkey 脚本后走 GM_xmlhttpRequest 就不会被拦）"
                    : "")
              )
            );
          });
      }
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) =>
    String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ============================================================ YouTube
     推送版对 YouTube 的支持：
       1) 一键推送到服务端（走 /api/download 的 links / videos）
       2) 直接在浏览器里下载（GM_download，高清自动拆视频轨 + 音频轨）
     面板独立于 B站 的悬浮球，带重试挂载：YouTube 是 SPA，脚本可能比 body 早/晚执行。
  ============================================================ */
  /** YouTube 页专用轻提示：B站 的 msg() 定义在后面的 B站 面板代码里，YouTube 页提前 return 走不到那里。 */
  function ytToast(text, kind) {
    try {
      let el = document.getElementById("bilidl-yt-toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "bilidl-yt-toast";
        el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:96px;z-index:2147483601;" +
          "padding:9px 16px;border-radius:8px;font:600 13px/1.4 'PingFang SC','Microsoft YaHei',sans-serif;" +
          "color:#fff;background:rgba(20,22,28,.96);border:1px solid #ff0033;box-shadow:0 8px 24px rgba(0,0,0,.5);" +
          "max-width:70vw;word-break:break-all;pointer-events:none";
        document.body.appendChild(el);
      }
      el.textContent = String(text || "");
      el.style.borderColor = kind === "err" ? "#c0392b" : "#ff0033";
      el.style.opacity = "1";
      clearTimeout(ytToast._t);
      ytToast._t = setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 2600);
    } catch (e) {}
  }

  const YT_HOST_RE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;
  const YT_VID_RE = /^[0-9A-Za-z_-]{11}$/;
  const YT_HEIGHT = { 127: 4320, 126: 2160, 125: 2160, 120: 2160, 116: 1080, 112: 1080, 80: 1080, 74: 720, 64: 720, 32: 480, 16: 360 };
  const YT_QN_NAME = { 127: "8K", 126: "杜比视界", 125: "HDR", 120: "4K", 116: "1080P60", 112: "1080P+", 80: "1080P", 74: "720P60", 64: "720P", 32: "480P", 16: "360P" };
  const YT_TPL_KEY = "bilidl.yt.tpl";
  const YT_SUB_KEY = "bilidl.yt.subdir";
  // 与 B站 的默认命名规则保持同一套变量（清晰的 <video_title>-<video_id>-<video_episode>.<ext>）
  const YT_DEFAULT_TPL = "<video_title>-<video_id>-<video_episode>.<ext>";
  const YT_DEFAULT_SUB = "BiliDL";

  function isYouTubeHost() { return YT_HOST_RE.test(location.hostname); }

  function ytTpl() {
    try { return (localStorage.getItem(YT_TPL_KEY) || "").trim() || YT_DEFAULT_TPL; } catch (e) { return YT_DEFAULT_TPL; }
  }
  function ytSubDir() {
    try { const v = localStorage.getItem(YT_SUB_KEY); return v == null ? YT_DEFAULT_SUB : v.trim(); } catch (e) { return YT_DEFAULT_SUB; }
  }
  function ytSetSubDir(v) {
    try { localStorage.setItem(YT_SUB_KEY, String(v == null ? "" : v).trim()); } catch (e) {}
  }
  /** 子目录（浏览器默认下载目录下）+ 命名模板 → 完整相对路径 */
  function ytNameFor(tpl, vars, ext) {
    const sub = ytSubDir();
    const name = ytRender(tpl, vars, ext);
    return sub ? sub.replace(/^\/+|\/+$/g, "") + "/" + name : name;
  }
  function ytSetTpl(v) {
    const t = String(v || "").trim() || YT_DEFAULT_TPL;
    try { localStorage.setItem(YT_TPL_KEY, t); } catch (e) {}
    return t;
  }
  function ytClean(seg) {
    return String(seg == null ? "" : seg)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  }
  /** 与 py 端 build_relative 同思路：支持 <video_title> 和 ${video_title}，缺变量就整段去掉。 */
  function ytRender(tpl, vars, ext) {
    const all = Object.assign({}, vars, { ext: ext || "" });
    let out = String(tpl || YT_DEFAULT_TPL).replace(/\$\{(\w+)\}|\{(\w+)\}|<(\w+)>/g, (m, a, b, c) => {
      const key = a || b || c;
      return all[key] == null ? "" : String(all[key]);
    });
    out = out.split("/").map(ytClean).filter(Boolean).join("/");
    if (!out) out = ytClean(vars.video_title || vars.video_id || "video") + "." + (ext || "mp4");
    if (ext && !new RegExp("\\." + ext + "$", "i").test(out)) out += "." + ext;
    return out;
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
        onerror: () => reject(new Error("无法访问 YouTube（浏览器需要能打开 youtube.com）")),
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

  /** 从 HTML 里抽 marker 之后的 JSON（花括号配对，跳过字符串）。 */
  function ytExtractJson(text, marker) {
    const at = text.indexOf(marker);
    if (at < 0) return null;
    const i = text.indexOf("{", at);
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
        if (depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch (e) { return null; } }
      }
    }
    return null;
  }

  /** 从 player JS 里抽签名解密函数（失败返回 null）。 */
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
      const helper = new Function("return (" + js.slice(objBrace, oEnd + 1) + ")")();
      const rewritten = body.replace(new RegExp("\\b" + objName + "\\.", "g"), "H.");
      const fn = new Function("H", "return function(a){" + rewritten + "};")(helper);
      return typeof fn("0123456789abcdef") === "string" ? fn : null;
    } catch (e) { return null; }
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
    return q.url + (q.url.includes("?") ? "&" : "?") + (q.sp || "signature") + "=" + encodeURIComponent(sig);
  }

  function ytPickFormats(player, height) {
    const sd = player.streamingData || {};
    const ok = (f) => f && (f.url || f.signatureCipher || f.cipher);
    const progressive = (sd.formats || []).filter(ok);
    const adaptive = (sd.adaptiveFormats || []).filter(ok);
    const videos = adaptive.filter((f) => String(f.mimeType || "").startsWith("video/") && (f.height || 0) <= height)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (String(b.mimeType).includes("avc1") ? 1 : 0) - (String(a.mimeType).includes("avc1") ? 1 : 0));
    const audios = adaptive.filter((f) => String(f.mimeType || "").startsWith("audio/"))
      .sort((a, b) => (String(b.mimeType || "").includes("mp4") ? 1 : 0) - (String(a.mimeType || "").includes("mp4") ? 1 : 0) || (b.bitrate || 0) - (a.bitrate || 0));
    const muxed = progressive.filter((f) => (f.height || 0) <= height).sort((a, b) => (b.height || 0) - (a.height || 0));
    return { videos, audios, muxed };
  }

  /**
   * 取播放数据。YouTube 现在经常在页面里的 ytInitialPlayerResponse 里**去掉直链**
   * （只留 itag/分辨率，url 字段整个消失），所以页面数据只能当兜底；
   * 主路径走 innertube 的 ANDROID_VR 客户端——它仍然直接返回带 url 的 27 个流。
   */
  async function ytInnertube(vid) {
    const html = await ytFetchText("https://www.youtube.com/watch?v=" + vid);
    const key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || "";
    const visitor = (html.match(/"VISITOR_DATA":"([^"]+)"/) || [])[1] || "";
    const webVer = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || "";
    const pagePlayer = ytExtractJson(html, "ytInitialPlayerResponse");
    const fs = (x) => (x.streamingData && ((x.streamingData.formats || []).length + (x.streamingData.adaptiveFormats || []).length)) || 0;
    const hasUrl = (x) => !!((x.streamingData && ((x.streamingData.formats || []).concat(x.streamingData.adaptiveFormats || []))) || []).find((f) => f.url);
    const clients = [["ANDROID_VR", "1.60.19", "28"], ["WEB", webVer, "1"]];
    let lastErr = "";
    for (const [name, cver, cnum] of clients) {
      if (!cver) continue;
      try {
        const client = { clientName: name, clientVersion: cver, hl: "zh-CN", gl: "US" };
        if (visitor) client.visitorData = visitor;
        const headers = { "Content-Type": "application/json", "X-Youtube-Client-Name": cnum, "X-Youtube-Client-Version": cver };
        if (visitor) headers["X-Goog-Visitor-Id"] = visitor;
        const data = await ytPostJson("https://www.youtube.com/youtubei/v1/player?prettyPrint=false&key=" + encodeURIComponent(key), {
          context: { client }, videoId: vid, contentCheckOk: true, racyCheckOk: true,
        }, headers);
        const st = (data.playabilityStatus || {}).status;
        if (st && st !== "OK") { lastErr = (data.playabilityStatus || {}).reason || st; continue; }
        if (!fs(data)) { lastErr = "没有可用格式"; continue; }
        return { player: data, pagePlayer, html, decipher: null };
      } catch (e) { lastErr = e.message; }
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
      if (hasUrl(pagePlayer) || decipher) return { player: pagePlayer, pagePlayer, html, decipher };
    }
    throw new Error("取不到播放数据" + (lastErr ? "：" + lastErr : "") + "（可先在浏览器里登录 YouTube 再试）");
  }

  /** 单个视频 → 下载任务（高清没有合流文件时拆成视频轨 + 音频轨）。 */
  async function ytVideoJobs(url) {
    const det = ytDetect(url);
    const { player, pagePlayer, decipher } = await ytInnertube(det.ident);
    const vd = player.videoDetails || (pagePlayer && pagePlayer.videoDetails) || {};
    const height = YT_HEIGHT[gmGet("bilidl.yt.quality", 116)] || 1080;
    const { videos, audios, muxed } = ytPickFormats(player, height);
    const title = vd.title || det.ident;
    const vars = {
      video_title: title,
      video_id: vd.videoId || det.ident,
      video_episode: 1,
      video_page_title: "",
      video_author: vd.author || "",
      video_quality: YT_QN_NAME[gmGet("bilidl.yt.quality", 116)] || "1080P60",
      video_date: vd.publishDate || "",
      video_author_uid: vd.channelId || "",
      youtube_id: vd.videoId || det.ident,
      youtube_channel: vd.author || "",
      youtube_channel_id: vd.channelId || "",
    };
    const tpl = ytTpl();
    const usable = (f) => {
      const u = ytFormatUrl(f, decipher);
      return u ? { url: u, size: Number(f.contentLength || 0), height: f.height || 0 } : null;
    };
    const jobs = [];
    const mux = muxed.map(usable).filter(Boolean)[0];
    const bestVideo = videos.map(usable).filter(Boolean)[0];
    const bestAudio = audios.map(usable).filter(Boolean)[0];
    if (mux && (!bestVideo || mux.height >= bestVideo.height)) {
      jobs.push({ url: mux.url, name: ytNameFor(tpl, vars, "mp4"), title, size: mux.size });
    } else if (bestVideo) {
      jobs.push({ url: bestVideo.url, name: ytNameFor(tpl, vars, "mp4").replace(/\.mp4$/, "-v.mp4"), title: title + "（视频轨）", size: bestVideo.size });
      if (bestAudio) jobs.push({ url: bestAudio.url, name: ytNameFor(tpl, vars, "m4a").replace(/\.m4a$/, "-a.m4a"), title: title + "（音频轨）", size: bestAudio.size });
    } else if (bestAudio) {
      jobs.push({ url: bestAudio.url, name: ytNameFor(tpl, vars, "m4a"), title: title + "（音频）", size: bestAudio.size });
    } else {
      throw new Error("取不到可下载的流（可能需要登录 Cookie）");
    }
    return jobs;
  }

  /** 频道 / 播放列表 → 抓页面里的 videoId（最多 limit 个）。 */
  async function ytListVideos(url, limit) {
    const html = await ytFetchText(url);
    const ids = [];
    const seen = new Set();
    const data = ytExtractJson(html, "ytInitialData");
    const walk = (node) => {
      if (!node || ids.length >= limit) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (typeof node !== "object") return;
      if (node.videoId && YT_VID_RE.test(node.videoId) && !seen.has(node.videoId)) { seen.add(node.videoId); ids.push(node.videoId); }
      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(data);
    if (!ids.length) {
      const re = /"videoId":"([0-9A-Za-z_-]{11})"/g;
      let m;
      while ((m = re.exec(html)) && ids.length < limit) { if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]); } }
    }
    return ids;
  }

  // ---------------- YouTube 多选批量（与 B站 空间页多选体验一致） ----------------
  const YT_CARD_SEL = "ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-playlist-video-renderer, ytd-playlist-video-item-renderer, yt-lockup-view-model, ytd-reel-item-renderer, ytd-rich-grid-media";
  let ytSelMode = false;
  const ytPicked = new Map();

  function ytCards() {
    const out = new Map();
    const links = document.querySelectorAll('a[href*="watch?v="], a[href*="/shorts/"]');
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const vid = ((href.match(/[?&]v=([0-9A-Za-z_-]{11})/) || href.match(/\/shorts\/([0-9A-Za-z_-]{11})/)) || [])[1];
      if (!vid) continue;
      const card = a.closest(YT_CARD_SEL);
      if (!card) continue;
      if (!out.has(vid)) {
        let title = "";
        const t = card.querySelector("#video-title, a#video-title-link, #video-title-link, h3 a");
        if (t) title = (t.getAttribute("title") || t.textContent || "").trim();
        if (!title) title = (a.getAttribute("title") || a.textContent || "").trim();
        let author = "";
        const ch = card.querySelector("#channel-name a, ytd-channel-name a, #channel-name #text, ytd-channel-name #text, #channel-name, ytd-channel-name, a.yt-simple-endpoint[href^='/@'] a, a.yt-simple-endpoint[href^='/@']");
        if (ch) author = (ch.textContent || "").replace(/\s+/g, " ").trim();
        out.set(vid, { id: vid, title: title || vid, author: author, url: "https://www.youtube.com/watch?v=" + vid });
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
    return card ? card : { id: vid, title: vid, url: "https://www.youtube.com/watch?v=" + vid };
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
    if (ytSelMode) { ytCards(); ytToast("多选模式已开启：点视频封面即选中", "ok"); }
    else ytToast("多选模式已关闭：封面恢复点击播放", "ok");
    ytSyncSel();
  }

  function ytSelectPage() {
    const cards = ytCards();
    if (!cards.length) return ytToast("这个页面里没找到视频卡片", "err");
    let added = 0;
    for (const c of cards) if (!ytPicked.has(c.id)) { ytPicked.set(c.id, c); added++; }
    ytSyncSel();
    ytToast("本页共 " + cards.length + " 个视频" + (added ? "，新选中 " + added + " 个" : "，已全部选中"), "ok");
  }

  function ytClearSel() {
    ytPicked.clear();
    ytSyncSel();
    ytToast("已清空选择", "ok");
  }

  /** 批量推送到服务端：走 /api/download 的 videos 数组（source=youtube）。 */
  async function ytBatchPush() {
    const items = [...ytPicked.values()];
    if (!items.length) return ytToast("先勾选视频（开「多选」后点封面，或点「全选本页」）", "err");
    const det = ytDetect(location.href) || {};
    // 只有真正的播放列表页（/playlist?list=…）才把列表名当合辑；频道页/视频页/搜索页一律不带，
    // 否则模板里的 <videolist_title>/ 会按「当前页面标题」建文件夹，把多选的其它视频塞进去。
    const isList = det.kind === "yt_playlist";
    const seasonId = isList ? String(det.ident || "") : "";
    const seasonTitle = isList ? String(document.title || "").replace(/\s*-\s*YouTube\s*$/, "") : "";
    ytLog("正在推送 " + items.length + " 个视频到 " + getServer() + " …");
    try {
      const res = await request("POST", "/api/download", {
        videos: items.map((it, i) => ({
          bvid: it.id,
          source: "youtube",
          video_title: it.title,
          web_url: it.url,
          author: it.author || "",
          quality: YT_QN_NAME[Number(gmGet("bilidl.yt.quality", 116))] || "1080P60",
          template: (ytSubDir() ? ytSubDir().replace(/^\/+|\/+$/g, "") + "/" : "") + ytTpl(),
          season_id: seasonId,
          season_title: seasonTitle,
          season_order: seasonId ? i + 1 : 0,
        })),
      });
      const n = res && (res.tasks || res.count || res.total);
      ytLog("已推送 " + items.length + " 个视频" + (typeof n === "number" ? "（服务端任务 " + n + " 个）" : ""));
      ytToast("已推送 " + items.length + " 个视频", "ok");
    } catch (e) {
      ytLog("批量推送失败：" + e.message);
      ytToast("批量推送失败：" + e.message, "err");
    }
  }

  /** 批量浏览器下载：逐个解析 → GM_download。 */
  async function ytBatchDownload() {
    const items = [...ytPicked.values()];
    if (!items.length) return ytToast("先勾选视频（开「多选」后点封面，或点「全选本页」）", "err");
    if (!confirm("浏览器直接下载 " + items.length + " 个视频？\n（1080P 以上会拆成视频轨 + 音频轨两个文件）")) return;
    let done = 0, failed = 0;
    for (let i = 0; i < items.length; i++) {
      try {
        ytLog("（" + (i + 1) + "/" + items.length + "）解析 " + String(items[i].title).slice(0, 32) + "…");
        const jobs = await ytVideoJobs(items[i].url);
        for (const job of jobs) {
          ytLog("（" + (i + 1) + "/" + items.length + "）下载 " + String(job.name).split("/").pop());
          await gmDownload({ url: job.url, name: job.name, mime: "video/mp4" });
        }
        done++;
      } catch (e) {
        failed++;
        console.warn("[BiliDL] YouTube 批量下载失败", items[i].url, e);
      }
    }
    ytLog("完成：成功 " + done + " 个" + (failed ? "，失败 " + failed + " 个" : ""));
    ytToast("浏览器下载：" + done + " 个" + (failed ? "，失败 " + failed : ""), failed ? "err" : "ok");
  }

  /** 多选模式下拦截卡片点击：不再跳转，改成选中。 */
  function ytInstallSelGuards() {
    if (ytInstallSelGuards.done) return;
    ytInstallSelGuards.done = true;
    document.addEventListener("click", (ev) => {
      if (!ytSelMode) return;
      const box = ev.target && ev.target.closest ? ev.target.closest(".bilidl-ytsel") : null;
      if (box) { ev.preventDefault(); ev.stopPropagation(); ytToggleSel(box.dataset.vid); return; }
      const a = ev.target && ev.target.closest ? ev.target.closest('a[href*="watch?v="], a[href*="/shorts/"]') : null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      const vid = ((href.match(/[?&]v=([0-9A-Za-z_-]{11})/) || href.match(/\/shorts\/([0-9A-Za-z_-]{11})/)) || [])[1];
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

  async function ytPush() {
    const det = ytDetect(location.href);
    if (!det) return ytToast("当前页面不是 YouTube 视频 / 频道 / 播放列表页");
    ytLog("正在推送到服务端…");
    let body;
    try {
      if (det.kind === "yt_video") {
        body = { links: "https://www.youtube.com/watch?v=" + det.ident };
      } else {
        const ids = await ytListVideos(location.href, 20);
        body = ids.length
          ? { videos: ids.map((id, i) => ({ bvid: id, source: "youtube", video_title: id, season_id: det.ident, season_title: document.title.replace(/\s*-\s*YouTube\s*$/, ""), season_order: i + 1 })) }
          : { links: location.href };
      }
      const res = await request("POST", "/api/download", body);
      const n = (res && (res.tasks || res.count || res.total)) || "?";
      ytLog("已推送：" + (typeof n === "number" ? n + " 个任务" : "成功"));
      ytToast("已推送到服务端");
    } catch (e) {
      ytLog("推送失败：" + e.message);
      ytToast("推送失败：" + e.message, "err");
      const pick = window.confirm(
        "连不上服务端：" + getServer() + "\n\n" +
        "点「确定」= 换一个服务端地址后重试（例如 Docker 装在 NAS 上，填 http://NAS的IP:2197）\n" +
        "点「取消」= 改用「浏览器直接下载」（不需要服务端）"
      );
      if (!pick) return ytDirect();
      const addr = window.prompt("BiliDL Pro 服务端地址（http://IP:2197）", getServer());
      if (!addr) return;
      setServer(addr);
      ytLog("服务端已改为 " + getServer() + "，重试…");
      try {
        const res2 = await request("POST", "/api/download", body);
        ytLog("已推送：" + (res2 && (res2.count || res2.total) || "成功"));
        ytToast("已推送到服务端");
      } catch (e2) {
        ytLog("仍然连不上：" + e2.message);
        ytToast("推送失败，可改用「浏览器直接下载」", "err");
      }
    }
  }

  async function ytDirect() {
    const det = ytDetect(location.href);
    if (!det) return ytToast("当前页面不是 YouTube 视频 / 频道 / 播放列表页");
    let urls = [];
    if (det.kind === "yt_video") {
      urls = ["https://www.youtube.com/watch?v=" + det.ident];
    } else {
      ytLog("正在读取列表…");
      const ids = await ytListVideos(location.href, 30);
      if (!ids.length) return ytToast("这个页面里没找到视频链接", "err");
      if (!confirm("找到 " + ids.length + " 个视频，全部下载到浏览器？\n（每个视频可能拆成视频轨 + 音频轨两个文件）")) return;
      urls = ids.map((id) => "https://www.youtube.com/watch?v=" + id);
    }
    let done = 0, failed = 0;
    for (let i = 0; i < urls.length; i++) {
      try {
        ytLog("（" + (i + 1) + "/" + urls.length + "）解析中…");
        const jobs = await ytVideoJobs(urls[i]);
        for (const job of jobs) {
          ytLog("（" + (i + 1) + "/" + urls.length + "）下载 " + job.name.split("/").pop());
          await gmDownload({ url: job.url, name: job.name, mime: "video/mp4" });
        }
        done++;
      } catch (e) {
        failed++;
        console.warn("[BiliDL] YouTube 下载失败", urls[i], e);
      }
    }
    ytLog("完成：成功 " + done + " 个" + (failed ? "，失败 " + failed + " 个" : ""));
    ytToast("浏览器下载：" + done + " 个" + (failed ? "，失败 " + failed : ""));
  }

  const YT_CSS = [
    "#bilidl-yt-fab{position:fixed;right:16px;bottom:24px;z-index:2147483600;display:flex;align-items:center;gap:6px;",
    "padding:9px 14px;border-radius:22px;background:#ff0033;color:#fff;font:600 13px/1 \"PingFang SC\",\"Microsoft YaHei\",sans-serif;",
    "box-shadow:0 6px 20px rgba(255,0,51,.45);cursor:pointer;user-select:none;border:0}",
    "#bilidl-yt-fab:hover{background:#ff1f49}",
    "#bilidl-yt{position:fixed;right:16px;bottom:78px;z-index:2147483600;width:288px;padding:11px 12px;border-radius:12px;",
    "background:rgba(18,20,26,.98);border:1px solid #ff0033;color:#eef2f7;box-shadow:0 12px 34px rgba(0,0,0,.55);",
    "font:12px/1.5 \"PingFang SC\",\"Microsoft YaHei\",sans-serif}",
    "#bilidl-yt .yt-h{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:13px;margin-bottom:6px;color:#ff5c77}\n    #bilidl-yt .yt-h span{white-space:nowrap}",
    "#bilidl-yt .yt-x{border:0;background:transparent;color:#93a0b0;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}",
    "#bilidl-yt .yt-info{color:#9fb0c3;margin-bottom:8px;word-break:break-all}",
    "#bilidl-yt .yt-row{display:flex;flex-direction:column;gap:6px}",
    "#bilidl-yt button{border:0;border-radius:7px;padding:8px 9px;font-size:12px;cursor:pointer;width:100%;text-align:center}",
    "#bilidl-yt .yt-main{background:#ff0033;color:#fff;font-weight:600}",
    "#bilidl-yt .yt-alt{background:#2b3240;color:#dbe6f3}",
    "#bilidl-yt .yt-log{margin-top:7px;color:#8ea1b6;min-height:16px;word-break:break-all}",
    "#bilidl-yt .yt-tip{margin-top:6px;color:#6f7d8d;font-size:11px;word-break:break-all}",
    "#bilidl-yt .yt-tip a{color:#7fb3ff}",
    "#bilidl-yt .yt-cfg{margin-top:8px;padding-top:8px;border-top:1px dashed #2b3442;display:flex;flex-direction:column;gap:6px}",
    "#bilidl-yt .yt-cfg-h{font-size:12px;color:#cfe0f0;font-weight:600}",
    "#bilidl-yt .yt-cfg-lab{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#9fb0c3}",
    "#bilidl-yt .yt-cfg select,#bilidl-yt .yt-cfg input,#bilidl-yt .yt-cfg textarea{width:100%;box-sizing:border-box;background:#0f1216;color:#e6edf3;border:1px solid #2b3442;border-radius:6px;padding:5px 6px;font-size:12px;font-family:inherit}",
    "#bilidl-yt .yt-sel{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;font-size:11px;color:#9fb0c3}",
    "#bilidl-yt .yt-sel-lab{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none}",
    "#bilidl-yt .yt-sel-n b{color:#ff5c77;font-weight:600}",
    "#bilidl-yt .yt-row2{display:flex;gap:6px;margin-top:6px}",
    "#bilidl-yt .yt-row2 button{width:auto;flex:1;padding:7px 2px;font-size:11.5px}",
    "#bilidl-yt .yt-mini{background:#2b3240;color:#dbe6f3}",
    "#bilidl-yt button:disabled{opacity:.45;cursor:not-allowed}",
    "html[data-bilidl-ytsel=\"1\"] .bilidl-ytsel{display:block}",
    ".bilidl-ytsel{position:absolute;left:8px;top:8px;z-index:2147482000;display:none;width:22px;height:22px;border-radius:6px;",
    "border:2px solid rgba(255,255,255,.92);background:rgba(13,18,24,.66);cursor:pointer;padding:0;box-shadow:0 2px 10px rgba(0,0,0,.6);transition:background .12s,border-color .12s,transform .12s}",
    ".bilidl-ytsel:hover{transform:scale(1.06);border-color:#fb7299}",
    ".bilidl-ytsel.on{display:flex;background:#fb7299;border-color:#fb7299}",
    ".bilidl-ytsel.on::after{content:\"✓\";color:#fff;font-size:16px;font-weight:700;line-height:1}",
    ".bilidl-ytsel.on::after{content:'\\2713';position:absolute;inset:0;color:#fff;font:700 14px/19px sans-serif;text-align:center}",
  ].join("");

  function ytInjectCss() {
    if (document.getElementById("bilidl-yt-css")) return;
    const st = document.createElement("style");
    st.id = "bilidl-yt-css";
    st.textContent = YT_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function ytEl(tag, cls, id, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (id) el.id = id;
    if (text != null) el.textContent = text;
    return el;
  }

  // 面板默认收起：打开网页只显示右下角悬浮按钮，点了才展开（不记忆状态，避免下次自动弹出）
  let ytPanelOpen = false;
  function ytPanelHidden() { return !ytPanelOpen; }

  function ytSetHidden(v) {
    ytPanelOpen = !v;
    const box = document.getElementById("bilidl-yt");
    if (box) box.style.display = ytPanelOpen ? "block" : "none";
    const fab = document.getElementById("bilidl-yt-fab");
    if (fab) fab.title = ytPanelOpen ? "收起下载面板" : "BiliDL：打开下载面板（推送到服务端 / 浏览器直接下载）";
  }

  function ytMountPanel() {
    if (!isYouTubeHost()) return;
    if (!document.body) return;
    ytInjectCss();

    if (!document.getElementById("bilidl-yt-fab")) {
      const fab = ytEl("button", null, "bilidl-yt-fab", "⬇ YouTube 下载");
      fab.type = "button";
      fab.title = "BiliDL：把当前 YouTube 视频推送到服务端，或直接在浏览器下载";
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
    head.appendChild(ytEl("span", null, null, "YouTube 下载 v2.2.0"));
    const close = ytEl("button", "yt-x", "bilidl-yt-close", "×");
    close.type = "button";
    close.title = "收起面板（右下角红色按钮可再次打开）";
    head.appendChild(close);
    const info = ytEl("div", "yt-info", "bilidl-yt-info");
    const row = ytEl("div", "yt-row");
    const push = ytEl("button", "yt-main", "bilidl-yt-push", "推送到服务端下载");
    push.type = "button";
    const dl = ytEl("button", "yt-alt", "bilidl-yt-dl", "浏览器直接下载");
    dl.type = "button";
    row.appendChild(push);
    row.appendChild(dl);
    const log = ytEl("div", "yt-log", "bilidl-yt-log");

    // ---- 下载设置（与 B站 面板同一套字段：清晰度 / 子目录 / 命名模板） ----
    const cfg = ytEl("div", "yt-cfg");
    cfg.appendChild(ytEl("div", "yt-cfg-h", null, "下载设置"));
    const qLab = ytEl("label", "yt-cfg-lab", null, "清晰度");
    const qSel = ytEl("select", null, "bilidl-yt-quality");
    [[127, "8K (4320P)"], [120, "4K (2160P)"], [116, "1080P60"], [112, "1080P+"], [80, "1080P"], [74, "720P60"], [64, "720P"], [32, "480P"], [16, "360P"]].forEach(([v, n]) => {
      const o = document.createElement("option");
      o.value = String(v); o.textContent = n;
      qSel.appendChild(o);
    });
    qSel.value = String(Number(gmGet("bilidl.yt.quality", 116)));
    qLab.appendChild(qSel);
    const subLab = ytEl("label", "yt-cfg-lab", null, "下载子目录");
    const subIn = ytEl("input");
    subIn.type = "text";
    subIn.id = "bilidl-yt-subdir";
    subIn.placeholder = "BiliDL";
    subIn.value = ytSubDir();
    subLab.appendChild(subIn);
    const tplLab = ytEl("label", "yt-cfg-lab", null, "视频重命名规则");
    const tplIn = ytEl("textarea");
    tplIn.id = "bilidl-yt-tpl";
    tplIn.rows = 2;
    tplIn.value = ytTpl();
    tplLab.appendChild(tplIn);
    const tplTip = ytEl("div", "yt-tip", null, "变量与 B站 一致：<video_title> <video_id> <video_episode> <video_page_title> <video_author> <video_author_uid> <video_quality> <video_date> <videolist_title> <ext>；写 / 可建子目录。");
    const saveBtn = ytEl("button", "yt-mini", "bilidl-yt-save", "保存设置");
    saveBtn.type = "button";
    [qLab, subLab, tplLab, tplTip, saveBtn].forEach((n) => cfg.appendChild(n));

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
    tip.appendChild(ytEl("span", null, "bilidl-yt-srv", getServer()));
    tip.appendChild(document.createTextNode(" · "));
    const setA = ytEl("a", null, "bilidl-yt-set", "修改");
    setA.href = "#";
    tip.appendChild(setA);
    [head, info, row, cfg, selBar, bar2, bar3, log, tip].forEach((n) => box.appendChild(n));
    document.body.appendChild(box);
    box.style.display = ytPanelOpen ? "block" : "none";

    close.addEventListener("click", (e) => { e.preventDefault(); ytSetHidden(true); });
    push.addEventListener("click", (e) => { e.preventDefault(); ytPush(); });
    dl.addEventListener("click", (e) => { e.preventDefault(); ytDirect().catch((err) => { ytLog("下载失败：" + err.message); ytToast(err.message, "err"); }); });
    saveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const q = Number(qSel.value) || 116;
      try { localStorage.setItem("bilidl.yt.quality", String(q)); } catch (err) {}
      ytSetSubDir(subIn.value);
      ytSetTpl(tplIn.value);
      subIn.value = ytSubDir();
      tplIn.value = ytTpl();
      ytLog("设置已保存：清晰度 " + (YT_QN_NAME[q] || q) + " · 子目录 " + (ytSubDir() || "（默认下载目录）"));
      ytToast("下载设置已保存", "ok");
    });
    selCb.addEventListener("change", () => ytSetSelMode(selCb.checked));
    allBtn.addEventListener("click", (e) => { e.preventDefault(); ytSelectPage(); });
    clearBtn.addEventListener("click", (e) => { e.preventDefault(); ytClearSel(); });
    bpush.addEventListener("click", (e) => { e.preventDefault(); ytBatchPush(); });
    bdl.addEventListener("click", (e) => { e.preventDefault(); ytBatchDownload().catch((err) => { ytLog("批量下载失败：" + err.message); ytToast(err.message, "err"); }); });
    ytSyncSel();
    setA.addEventListener("click", (e) => {
      e.preventDefault();
      const v = prompt("BiliDL 服务地址", getServer());
      if (v) { setServer(v.trim()); const srv = document.getElementById("bilidl-yt-srv"); if (srv) srv.textContent = getServer(); }
    });
    ytRefreshInfo();
  }

  function ytRefreshInfo() {
    const el = document.getElementById("bilidl-yt-info");
    if (!el) return;
    const det = ytDetect(location.href);
    const map = { yt_video: "YouTube 视频", yt_channel: "YouTube 频道", yt_playlist: "播放列表" };
    el.textContent = det ? (map[det.kind] || det.kind) + " · " + (det.ident || "") : "打开任意 YouTube 视频/频道页即可使用";
  }

  function ytInstall() {
    if (!isYouTubeHost()) return;
    try {
      window.__bilidlYT = window.__bilidlYT || {};
      Object.assign(window.__bilidlYT, { ytDetect, ytVideoJobs, ytListVideos, ytPush, ytDirect, ytCards, ytSelectPage, ytClearSel, ytBatchPush, ytBatchDownload, ytSetSelMode, ytPicked, version: "2.1.2" });
    } catch (err) {}
    ytInstallSelGuards();
    ytMountPanel();
    let last = "";
    setInterval(() => {
      ytMountPanel();
      if (ytSelMode) { ytCards(); ytSyncSel(); }
      if (location.href !== last) { last = location.href; ytRefreshInfo(); }
    }, 1200);
    // YouTube 自己的 SPA 跳转事件，比轮询更及时
    ["yt-navigate-finish", "yt-page-data-updated"].forEach((ev) => {
      window.addEventListener(ev, () => { ytMountPanel(); ytRefreshInfo(); }, true);
    });
  }

  ytInstall();

  // YouTube 强制 Trusted Types：B站 那套 innerHTML 面板在这里会直接抛错，
  // 所以 YouTube 页面只装上面这套纯 DOM API 的小面板，然后立刻结束初始化。
  if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(location.hostname)) {
    try { ytInstall(); } catch (err) { console.warn("[BiliDL] YouTube 面板初始化失败", err); }
    return;
  }

  /* ------------------------------------------------------------ YouTube */
  const YT_VID = /^[0-9A-Za-z_-]{11}$/;

  function isYouTubeUrl(url) {
    try {
      const u = new URL(url, location.href);
      const h = u.hostname.toLowerCase();
      return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com");
    } catch (e) {
      return false;
    }
  }

  // 把 YouTube 链接归一成 { kind: yt_video | yt_channel | yt_playlist | "", ident, text }
  function detectYouTube(url) {
    let u;
    try {
      u = new URL(url, location.href);
    } catch (e) {
      return { kind: "", ident: "", text: "" };
    }
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be" || host.endsWith(".youtu.be")) {
      const vid = u.pathname.replace(/^\/+/, "").split("/")[0];
      if (YT_VID.test(vid)) {
        return { kind: "yt_video", ident: vid, text: "https://www.youtube.com/watch?v=" + vid };
      }
      return { kind: "", ident: "", text: "" };
    }
    if (!(host === "youtube.com" || host.endsWith(".youtube.com"))) {
      return { kind: "", ident: "", text: "" };
    }
    const v = (u.searchParams.get("v") || "").trim();
    if (YT_VID.test(v)) {
      return { kind: "yt_video", ident: v, text: "https://www.youtube.com/watch?v=" + v };
    }
    const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([0-9A-Za-z_-]{11})/);
    if (m) {
      return { kind: "yt_video", ident: m[1], text: "https://www.youtube.com/watch?v=" + m[1] };
    }
    const list = (u.searchParams.get("list") || "").trim();
    if (u.pathname.startsWith("/playlist") && list) {
      return { kind: "yt_playlist", ident: list, text: "https://www.youtube.com/playlist?list=" + list };
    }
    const handle = u.pathname.match(/^\/@([^/?#]+)/);
    if (handle) {
      return { kind: "yt_channel", ident: "@" + handle[1], text: "https://www.youtube.com/@" + handle[1] };
    }
    const ch = u.pathname.match(/^\/(channel|c|user)\/([^/?#]+)/);
    if (ch) {
      const ident = ch[1] === "channel" ? ch[2] : ch[1] + "/" + ch[2];
      return { kind: "yt_channel", ident, text: "https://www.youtube.com/" + (ch[1] === "channel" ? "channel/" : ch[1] + "/") + ch[2] };
    }
    return { kind: "", ident: "", text: "" };
  }

  // 频道 / 播放列表页：从 DOM 里抓本页已经渲染出来的视频
  function collectYouTubeVideos() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/watch?v="]').forEach((a) => {
      const info = detectYouTube(a.getAttribute("href") || a.href || "");
      if (info.kind !== "yt_video" || seen.has(info.ident)) return;
      // 排除侧栏推荐里的小卡片：优先取标题节点在链接内部/附近的
      const title = (a.getAttribute("title") || a.textContent || "").replace(/\s+/g, " ").trim();
      if (!title) return;
      seen.add(info.ident);
      out.push({ ident: info.ident, title });
    });
    return out;
  }

  /* ------------------------------------------------------------ 页面识别 */
  function socialHosts(url) {
    let h = "";
    try { h = new URL(url, location.href).hostname.toLowerCase(); } catch (e) { return ""; }
    if (h === "douyin.com" || h.endsWith(".douyin.com") || h === "iesdouyin.com" || h.endsWith(".iesdouyin.com")) return "douyin";
    if (h === "xiaohongshu.com" || h.endsWith(".xiaohongshu.com") || h === "xiaohongshu.cn" || h.endsWith(".xiaohongshu.cn")
      || h === "rednote.com" || h.endsWith(".rednote.com") || h === "rednote.cn" || h.endsWith(".rednote.cn")
      || h === "xhslink.com" || h.endsWith(".xhslink.com") || h === "xhslink.cn" || h.endsWith(".xhslink.cn")) return "xhs";
    return "";
  }

  function detect() {
    const href = location.href;
    const out = { kind: "", text: href, mid: "" };
    if (isYouTubeUrl(href)) {
      const yt = detectYouTube(href);
      if (!yt.kind) {
        out.kind = "yt_page";
        out.text = "";
        return out;
      }
      out.kind = yt.kind;
      out.ident = yt.ident;
      out.text = yt.text;
      out.youtube = true;
      return out;
    }
    const site = socialHosts(href);
    if (site === "douyin" || site === "xhs") {
      const soc = socialFromUrl(href);
      out.kind = site;
      out.text = href;
      if (soc) out.ident = soc.ident;
      return out;
    }
    let m = href.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/);
    if (m) {
      const p = href.match(/[?&]p=(\d+)/);
      out.kind = "video";
      out.text = "https://www.bilibili.com/video/" + m[1] + (p ? "/?p=" + p[1] : "");
      return out;
    }
    m = href.match(/bilibili\.com\/opus\/(\d{6,})/);
    if (m) {
      out.kind = "opus";
      out.text = "https://www.bilibili.com/opus/" + m[1];
      return out;
    }
    m = href.match(/bilibili\.com\/read\/cv(\d{1,12})/);
    if (m) {
      out.kind = "article";
      out.text = "https://www.bilibili.com/read/cv" + m[1];
      return out;
    }
    m = href.match(/t\.bilibili\.com\/(\d{15,})/);
    if (m) {
      out.kind = "dynamic";
      out.text = "https://t.bilibili.com/" + m[1];
      return out;
    }
    m = href.match(/space\.bilibili\.com\/(\d{1,12})/);
    if (m) {
      out.kind = "space";
      out.mid = m[1];
      out.text = "https://space.bilibili.com/" + m[1];
      return out;
    }
    m = href.match(/(?:b23\.tv|bili2233\.cn)\//);
    if (m) {
      out.kind = "short";
      out.text = href;
    }
    return out;
  }

  /* ------------------------------------------------------------ 面板 UI */
  const css = `
  #bilidl-widget { position: fixed; right: 14px; bottom: 132px; z-index: 99999;
    font: 13px/1.5 "PingFang SC","Microsoft YaHei",sans-serif; color: #e6edf3; }
  #bilidl-fab { width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #2f81f7, #1f6feb); color: #fff;
    border: none; cursor: pointer; font-size: 17px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
    opacity: .55; transition: opacity .15s, transform .15s; }
  #bilidl-fab:hover { opacity: 1; transform: scale(1.06); filter: brightness(1.1); }
  #bilidl-opic { position: fixed; right: 14px; bottom: 184px; z-index: 99998; display: none; align-items: center; gap: 6px;
    padding: 6px 11px; border-radius: 99px; background: rgba(23,28,36,.94); color: #fff; font-size: 12px; line-height: 1;
    border: 1px solid #2b3240; box-shadow: 0 6px 18px rgba(0,0,0,.35); cursor: default; user-select: none; }
  #bilidl-opic svg { color: #4c9bff; }
  #bilidl-opic .n { font-weight: 700; font-size: 13px; color: #4c9bff; font-variant-numeric: tabular-nums; }
  #bilidl-opic .t { color: #b9c3d1; }
  #bilidl-panel { position: absolute; right: 0; bottom: 52px; width: 340px; max-height: 72vh; overflow: auto; background: #171c24;
    border: 1px solid #2b3442; border-radius: 12px; padding: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
    display: none; }
  #bilidl-panel.on { display: block; }
  #bilidl-panel h3 { margin: 0 0 10px; font-size: 14px; }
  #bilidl-panel textarea { width: 100%; box-sizing: border-box; min-height: 70px; resize: vertical;
    background: #0f1216; color: #e6edf3; border: 1px solid #2b3442; border-radius: 8px; padding: 8px;
    font: 12px ui-monospace,Consolas,monospace; }
  #bilidl-panel input[type=text] { width: 100%; box-sizing: border-box; background: #0f1216; color: #e6edf3;
    border: 1px solid #2b3442; border-radius: 8px; padding: 7px 9px; font-size: 12px; }
  #bilidl-panel .row { display: flex; gap: 8px; margin-top: 9px; }
  #bilidl-panel button { flex: 1; padding: 7px 10px; border-radius: 8px; border: 1px solid #2b3442;
    background: #212936; color: #e6edf3; cursor: pointer; font-size: 12px; }
  #bilidl-panel button.primary { background: #fb7299; border-color: #fb7299; color: #fff; font-weight: 600; }
  #bilidl-panel button:hover { filter: brightness(1.15); }
  #bilidl-panel button:disabled { opacity: .45; cursor: not-allowed; }
  #bilidl-msg { margin-top: 9px; font-size: 12px; color: #9aa7b6; min-height: 17px; word-break: break-all; }
  #bilidl-msg.err { color: #f85149; }
  #bilidl-msg.ok { color: #3fb950; }
  #bilidl-kind { display: inline-block; font-size: 11px; color: #58a6ff; border: 1px solid #2b3442;
    border-radius: 5px; padding: 1px 6px; margin-bottom: 8px; }

  /* ---------- 图文多选弹窗 ---------- */
  #bilidl-modal { position: fixed; inset: 0; z-index: 100000; display: none;
    background: rgba(0,0,0,.62); }
  #bilidl-modal.on { display: flex; align-items: center; justify-content: center; }
  #bilidl-dialog { width: min(940px, 94vw); height: min(660px, 88vh); display: flex; flex-direction: column;
    background: #10151c; border: 1px solid #2b3442; border-radius: 14px; overflow: hidden;
    box-shadow: 0 24px 70px rgba(0,0,0,.6); color: #e6edf3;
    font: 13px/1.6 "PingFang SC","Microsoft YaHei",sans-serif; }
  #bilidl-dialog header { display: flex; align-items: center; gap: 10px; padding: 13px 16px;
    border-bottom: 1px solid #202836; background: #151b23; }
  #bilidl-dialog header .title { font-weight: 700; font-size: 14px; }
  #bilidl-dialog header .sub { color: #8b98a8; font-size: 12px; }
  #bilidl-dialog header .spacer { flex: 1; }
  #bilidl-dialog button { padding: 7px 12px; border-radius: 8px; border: 1px solid #2b3442;
    background: #1c242f; color: #e6edf3; cursor: pointer; font-size: 12px; white-space: nowrap; }
  #bilidl-dialog button:hover { border-color: #4a5568; }
  #bilidl-dialog button.primary { background: #fb7299; border-color: #fb7299; color: #fff; font-weight: 700; }
  #bilidl-dialog button:disabled { opacity: .45; cursor: not-allowed; }
  #bilidl-dialog .bar { display: flex; align-items: center; gap: 8px; padding: 9px 16px;
    border-bottom: 1px solid #202836; background: #131a22; }
  #bilidl-dialog .bar .count { color: #fb7299; font-weight: 700; }
  #bilidl-dialog .bar input { width: 180px; padding: 6px 10px; border-radius: 8px; border: 1px solid #2b3442;
    background: #0d1218; color: #e6edf3; font-size: 12px; outline: none; }
  #bilidl-dialog .bar input:focus { border-color: #fb7299; }
  #bilidl-dialog .bar .hint { color: #8b98a8; font-size: 12px; margin-left: auto; }
  #bilidl-grid { flex: 1; overflow-y: auto; padding: 12px 16px 16px;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(152px, 1fr));
    grid-auto-rows: 272px; gap: 11px; align-content: start; }
  #bilidl-grid::-webkit-scrollbar { width: 9px; }
  #bilidl-grid::-webkit-scrollbar-thumb { background: #2b3442; border-radius: 5px; }
  .bilidl-card { position: relative; height: 272px; box-sizing: border-box; border: 1px solid #232c3a;
    border-radius: 10px; overflow: hidden; background: #161d26; cursor: pointer;
    transition: border-color .12s, transform .12s; }
  .bilidl-card:hover { border-color: #fb7299; }
  .bilidl-card.sel { border-color: #fb7299; box-shadow: 0 0 0 2px rgba(251,114,153,.35) inset; }
  .bilidl-card .cover { width: 100%; height: 196px; object-fit: cover; display: block; background: #0d1218; }
  .bilidl-card .meta { padding: 7px 8px 8px; }
  .bilidl-card .t { font-size: 12px; line-height: 1.45; height: 2.9em; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .bilidl-card .id { color: #77828f; font-size: 11px; margin-top: 3px; font-family: ui-monospace,Consolas,monospace; }
  .bilidl-card .tick { position: absolute; left: 7px; top: 7px; width: 20px; height: 20px; border-radius: 6px;
    background: rgba(0,0,0,.62); border: 1px solid #4a5568; display: flex; align-items: center;
    justify-content: center; font-size: 13px; color: transparent; }
  .bilidl-card.sel .tick { background: #fb7299; border-color: #fb7299; color: #fff; }
  #bilidl-empty { grid-column: 1 / -1; color: #8b98a8; text-align: center; padding: 40px 0; }

  /* ---------- 页面卡片上的选择框（视频 + 图文通用） ---------- */
  .bilidl-ov { position: absolute; left: 8px; top: 8px; z-index: 95; width: 28px; height: 28px;
    margin: 0; cursor: pointer; border-radius: 8px; -webkit-appearance: none; appearance: none;
    border: 2px solid rgba(255,255,255,.92); background: rgba(13,18,24,.66);
    box-shadow: 0 2px 10px rgba(0,0,0,.6); transition: background .12s, border-color .12s, transform .12s; }
  .bilidl-ov:hover { transform: scale(1.06); border-color: #fb7299; }
  .bilidl-ov:checked { background: #fb7299; border-color: #fb7299; }
  .bilidl-ov:checked::after { content: "✓"; position: absolute; inset: 0; display: flex;
    align-items: center; justify-content: center; color: #fff; font-size: 16px; font-weight: 700; line-height: 1; }
  .bilidl-card-hit { cursor: pointer !important; }
  .bilidl-picked-ring { outline: 3px solid #fb7299 !important; outline-offset: -3px; border-radius: 8px; }
  .bilidl-picked-ring::after { content: ""; position: absolute; inset: 0; background: rgba(251,114,153,.16);
    pointer-events: none; border-radius: 8px; }
  #bilidl-selbar .kinds { color: #9aa7b6; font-size: 12px; }
  #bilidl-selbar #bilidl-mode { border-color: #fb7299; color: #fb7299; }
  #bilidl-selbar #bilidl-mode.off { border-color: #2b3442; color: #8b98a8; }
  #bilidl-selbar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 22px; z-index: 99998;
    display: none; align-items: center; gap: 10px; padding: 9px 14px; border-radius: 999px;
    background: #171c24; border: 1px solid #2b3442; box-shadow: 0 10px 30px rgba(0,0,0,.5);
    color: #e6edf3; font: 13px/1.4 "PingFang SC","Microsoft YaHei",sans-serif; }
  #bilidl-selbar.on { display: flex; }
  #bilidl-selbar .n { color: #fb7299; font-weight: 700; }
  #bilidl-selbar button { padding: 6px 12px; border-radius: 999px; border: 1px solid #2b3442;
    background: #1f2733; color: #e6edf3; cursor: pointer; font-size: 12px; }
  #bilidl-selbar button.primary { background: #fb7299; border-color: #fb7299; color: #fff; font-weight: 700; }
  #bilidl-tip { position: fixed; left: 16px; top: 76px; z-index: 99997;
    display: none; align-items: center; gap: 10px; padding: 8px 14px; border-radius: 999px;
    background: rgba(23,28,36,.96); border: 1px solid #fb7299; color: #e6edf3;
    font: 13px/1.4 "PingFang SC","Microsoft YaHei",sans-serif; box-shadow: 0 8px 26px rgba(0,0,0,.45); }
  #bilidl-tip.on { display: flex; }
  #bilidl-tip b { color: #fb7299; }
  #bilidl-tip button { border: 0; background: transparent; color: #8b98a8; cursor: pointer; font-size: 15px; }
  `;

  const style = document.createElement("style");
  style.textContent = css;
  document.documentElement.appendChild(style);

  const widget = document.createElement("div");
  widget.id = "bilidl-widget";
  widget.innerHTML = `
    <div id="bilidl-panel">
      <h3 style="display:flex;align-items:center">推送到 BiliDL <span id="bilidl-ver">v2.4.1</span><button id="bilidl-close" title="关闭"
        style="margin-left:auto;flex:0 0 26px;width:26px;height:26px;padding:0;border-radius:8px">×</button></h3>
      <div id="bilidl-kind">正在识别页面…</div>
      <div class="row"><button class="primary" id="bilidl-cur" style="flex:1"
        title="直接把当前页面的视频 / 图文 / 专栏 / 抖音 / 小红书作品推送到 BiliDL 下载">下载本页作品</button></div>
      <textarea id="bilidl-links" placeholder="每行一个链接，可一次推送多条（支持 b23.tv 短链、抖音分享链接、小红书分享链接、YouTube 视频/频道/播放列表）"></textarea>
      <div class="row">
        <button class="primary" id="bilidl-parse">在 WebUI 中选择</button>
        <button id="bilidl-direct">立即下载</button>
      </div>
      <div class="row">
        <button id="bilidl-open">打开 WebUI</button>
        <button id="bilidl-space">检索此 UP 主</button>
      </div>
      <div class="row">
        <input type="text" id="bilidl-mid" placeholder="UP 主 ID（留空则用当前页面）">
        <button class="primary" id="bilidl-picker" style="flex:0 0 132px"
          title="列出此 UP 主的全部图文作品，自由多选后批量下载">多选图文</button>
      </div>
      <div class="row">
        <label style="display:flex;align-items:center;gap:7px;font-size:13px;color:#c9d4e3;flex:1">
          <input type="checkbox" id="bilidl-selmode" style="width:16px;height:16px;accent-color:#fb7299">
          开启多选模式（点缩略图即选中）
        </label>
        <button id="bilidl-selmode-clear" style="flex:0 0 96px">清空已选</button>
      </div>
      <div class="row">
        <input type="text" id="bilidl-server" placeholder="服务地址，默认 http://127.0.0.1:2197">
        <button id="bilidl-save" style="flex:0 0 64px">保存</button>
      </div>
      <div id="bilidl-srv" class="muted" style="margin-top:6px;font-size:12px"></div>
      <div id="bilidl-msg"></div>
    </div>
    <button id="bilidl-fab" title="推送到 BiliDL">⬇</button>
  `;
  document.body.appendChild(widget);
  const verEl = widget.querySelector("#bilidl-ver");
  if (verEl) verEl.textContent = "v" + ((typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "2.4.1");

  const msg = (text, kind) => {
    const node = widget.querySelector("#bilidl-msg");
    node.textContent = text;
    node.className = kind || "";
  };

  let current = { kind: "", text: "", mid: "" };
  let lastHref = "";

  // 优先用手动填写的 UP 主 ID，其次用当前页面地址里的 ID
  function currentMid() {
    const typed = (widget.querySelector("#bilidl-mid").value || "").trim();
    if (/^\d{1,12}$/.test(typed)) return typed;
    return current.mid || "";
  }

  function refresh() {
    current = detect();
    const labels = {
      video: "视频",
      opus: "图文 / 动态",
      article: "专栏",
      dynamic: "旧版动态",
      space: "UP 主空间",
      short: "短链",
      douyin: "抖音作品",
      xhs: "小红书笔记",
      yt_video: "YouTube 视频",
      yt_channel: "YouTube 频道",
      yt_playlist: "YouTube 播放列表",
      yt_page: "YouTube 页面（请打开具体视频/频道）",
      "": "未知页面",
    };
    widget.querySelector("#bilidl-kind").textContent = labels[current.kind] || current.kind;
    const links = widget.querySelector("#bilidl-links");
    if (current.text && !links.value.includes(current.text)) {
      links.value = current.text + (links.value.trim() ? "\n" + links.value.trim() : "");
    }
    widget.querySelector("#bilidl-space").disabled = current.kind !== "space";
    const midInput = widget.querySelector("#bilidl-mid");
    if (current.mid && !midInput.value) midInput.value = current.mid;
    widget.querySelector("#bilidl-picker").disabled = !currentMid();
    widget.querySelector("#bilidl-server").value = getServer();
  }

  // B站 某些页面会拦 style-src / 或给固定层设了更高 z-index，
  // 所以面板的关键样式同时写在元素上，保证「点了就有反应」。
  const fabEl = widget.querySelector("#bilidl-fab");
  const panelEl = widget.querySelector("#bilidl-panel");
  Object.assign(widget.style, { position: "fixed", right: "14px", bottom: "132px", zIndex: "2147483000" });
  Object.assign(fabEl.style, { width: "40px", height: "40px", borderRadius: "50%",
    background: "linear-gradient(135deg, #2f81f7, #1f6feb)",
    color: "#fff", border: "0", cursor: "pointer", fontSize: "18px", lineHeight: "40px", textAlign: "center",
    opacity: ".85", boxShadow: "0 4px 14px rgba(0,0,0,.35)", padding: "0" });
  Object.assign(panelEl.style, { position: "fixed", right: "14px", bottom: "184px", width: "340px", maxWidth: "92vw",
    maxHeight: "72vh", overflow: "auto", background: "#171c24", color: "#e6edf3", border: "1px solid #2b3442",
    borderRadius: "14px", padding: "14px", display: "none", zIndex: "2147483001",
    boxShadow: "0 18px 50px rgba(0,0,0,.5)", fontSize: "13px", lineHeight: "1.6", boxSizing: "border-box" });

  let panelWanted = false;
  // 服务端是否登录直接决定能下多高：未登录服务端最多 720P（浏览器里登录不共享）
  // 只探活，不改全局地址（给端口自动纠错用）
  function probeBase(base) {
    return new Promise((resolve) => {
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

  // 端口写错时自动纠正：同主机依次试 2197 / 2196 / 2917（当前默认 2197；旧版 Docker 2917、旧便携包 2196）
  async function autoFixServer() {
    const cur = getServer();
    let host = cur.replace(/^https?:\/\//i, "").split("/")[0];
    host = host.split(":")[0] || "127.0.0.1";
    const candidates = [cur, "http://" + host + ":2197", "http://" + host + ":2196", "http://" + host + ":2917"];
    for (const base of candidates) {
      if (await probeBase(base)) {
        const fixed = base.replace(/\/+$/, "");
        if (fixed !== cur) {
          setServer(fixed);
          msg("服务地址已自动纠正为 " + fixed, "ok");
        }
        return fixed;
      }
    }
    return "";
  }

  async function probeServer() {
    const el = widget.querySelector("#bilidl-srv");
    if (!el) return;
    try {
      const r = await request("GET", "/api/status");
      const d = (r && (r.data || r)) || {};
      const name = d.uname || d.name || "";
      const on = !!(d.logged_in || d.is_login || (d.user && d.user.uname) || name);
      const q = (d.settings && d.settings.quality) || d.quality;
      el.innerHTML = on
        ? `服务端：已登录${name ? "（" + name + "）" : ""}${q ? " · " + q : ""}`
        : `服务端：<b>未登录</b> —— 服务端只能下 720P，要 1080P60 请在 WebUI「账号登录」里扫码或用 Cookie 登录`;
      el.style.color = on ? "#3fb950" : "#f0b429";
    } catch (e) {
      const fixed = await autoFixServer();
      if (fixed) {
        el.innerHTML = "服务端：已连接到 " + fixed + "（原地址 " + getServer() + " 不对，已自动纠正）";
        el.style.color = "#3fb950";
        return;
      }
      el.innerHTML = "服务端：连不上（" + (e && e.message ? e.message : "网络错误") + "）<br>" +
        "<span style=\"color:#8b98a9\">排查：① 地址写全 http://IP:2197（不要 https）；② 手机/电脑与 NAS 同一网段，先在浏览器打开该地址看能否访问；③ Docker 端口映射 2197:2197；④ 本脚本 @connect 已放行 192.168.* / 10.* / 172.*</span>";
      el.style.color = "#f85149";
    }
  }

  function setPanel(open) {
    const want = typeof open === "boolean" ? open : !panelEl.classList.contains("on");
    panelWanted = want;
    panelEl.classList.toggle("on", want);
    panelEl.style.display = want ? "block" : "none";
    if (want) {
      const cb = q("#bilidl-selmode");
      if (cb) cb.checked = selMode;
      try { refresh(); } catch (e) { console.warn("[BiliDL] refresh 失败", e); }
      probeServer();
    }
  }

  // mousedown 兜底与 click 会各触发一次 toggle，必须去抖，否则「打开后立刻关闭」
  let lastFabAt = 0;
  function togglePanel() {
    const now = Date.now();
    if (now - lastFabAt < 400) return;
    lastFabAt = now;
    setPanel();
  }
  fabEl.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); });
  fabEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") setPanel(); });
  // B站 页面自己的 capture 阶段监听可能吞掉 click，这里再加一层捕获兜底
  ["mousedown", "pointerdown"].forEach((ev) => {
    document.addEventListener(ev, (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#bilidl-fab")) {
        try { e.stopPropagation(); } catch (err) {}
        if (ev === "mousedown") togglePanel();
      }
    }, true);
  });
  // 控制台手测入口：Console 里执行 __bilidlOpenPanel()
  try {
    window.__bilidl = {
      version: "1.7.7",
      openPanel: () => setPanel(true),
      closePanel: () => setPanel(false),
      state: () => ({ cls: panelEl.className, display: panelEl.style.display,
        rect: panelEl.getBoundingClientRect(), errors: window.__bilidlErrors || [] }),
    };
    window.__bilidlOpenPanel = () => setPanel(true);
    window.__bilidlErrors = window.__bilidlErrors || [];
    window.addEventListener("error", (e) => { window.__bilidlErrors.push(String(e.message)); }, true);
    window.addEventListener("unhandledrejection", (e) => { window.__bilidlErrors.push("promise: " + String(e.reason)); }, true);
  } catch (err) {}
  // 面板自愈：页面脚本/SPA 重渲染把面板关掉时自动恢复（用户主动关才不恢复）
  setInterval(() => {
    if (!panelWanted) return;
    try {
      if (!widget.isConnected) (document.body || document.documentElement).appendChild(widget);
      if (panelEl.style.display !== "block") { panelEl.style.display = "block"; panelEl.classList.add("on"); }
    } catch (e) {}
  }, 700);

  panelEl.addEventListener("click", (e) => e.stopPropagation());

  const closeBtn = widget.querySelector("#bilidl-close");
  if (closeBtn) closeBtn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setPanel(false); });

  widget.querySelector("#bilidl-save").addEventListener("click", () => {
    setServer(widget.querySelector("#bilidl-server").value.trim());
    msg("服务地址已保存：" + getServer(), "ok");
  });

  widget.querySelector("#bilidl-parse").addEventListener("click", () => {
    const text = widget.querySelector("#bilidl-links").value.trim();
    if (!text) {
      msg("请先输入链接", "err");
      return;
    }
    window.open(getServer() + "/?links=" + encodeURIComponent(text), "_blank");
    msg("已在 BiliDL 中打开，可自行勾选分集 / 合集 / 图文后下载", "ok");
  });

  widget.querySelector("#bilidl-open").addEventListener("click", () => {
    window.open(getServer() + "/", "_blank");
  });

  widget.querySelector("#bilidl-space").addEventListener("click", async () => {
    if (!current.mid) {
      msg("当前页面不是 UP 主空间", "err");
      return;
    }
    window.open(getServer() + "/?scan=" + encodeURIComponent(current.mid), "_blank");
    msg("已打开 BiliDL，检索任务会在后台运行", "ok");
  });

  widget.querySelector("#bilidl-cur").addEventListener("click", async () => {
    const href = location.href.split("#")[0];
    const title = String(document.title || "")
      .replace(/\s*-\s*哔哩哔哩.*$/, "")
      .replace(/\s*-\s*YouTube$/, "")
      .replace(/\s*-\s*抖音$/, "")
      .trim();

    if (isYouTubeUrl(href)) {
      const yt = detectYouTube(href);
      if (!yt.kind) {
        msg("请打开具体的 YouTube 视频 / 频道 / 播放列表页", "err");
        return;
      }
      // 视频：直接把这一条交给服务端（服务端用 yt-dlp 解析真实标题/时长/封面）
      if (yt.kind === "yt_video") {
        msg("正在推送 YouTube 视频…");
        try {
          const res = await request("POST", "/api/download", { links: yt.text });
          msg(`已创建 ${res.count} 个任务${res.failed && res.failed.length ? `，失败 ${res.failed.length} 个` : ""}，可在 WebUI 的任务队列查看`, "ok");
        } catch (err) {
          msg(err.message, "err");
        }
        return;
      }
      // 频道 / 播放列表：优先推送本页已经渲染出来的视频（快，且尊重当前排序）
      const vids = collectYouTubeVideos();
      const listId = yt.kind === "yt_playlist" ? yt.ident : "";
      if (vids.length) {
        msg(`正在推送本页 ${vids.length} 个 YouTube 视频…`);
        const videos = vids.map((v, i) => ({
          bvid: v.ident,
          source: "youtube",
          video_title: v.title,
          season_id: listId,
          season_title: listId ? title : "",
          season_order: listId ? i + 1 : 0,
        }));
        try {
          const res = await request("POST", "/api/download", { videos });
          msg(`已创建 ${res.count} 个任务${res.failed && res.failed.length ? `，失败 ${res.failed.length} 个` : ""}，可在 WebUI 的任务队列查看`, "ok");
        } catch (err) {
          msg(err.message, "err");
        }
        return;
      }
      // 页面上没抓到视频（懒加载 / 空频道）：整条链接交给服务端解析
      msg("本页没有可直接抓取的视频，交给服务端解析…");
      try {
        const res = await request("POST", "/api/download", { links: yt.text });
        msg(`已创建 ${res.count} 个任务（服务端只取最新 60 个，追更请用订阅）`, "ok");
      } catch (err) {
        msg(err.message, "err");
      }
      return;
    }

    const socialSite = socialHosts(href);
    if (socialSite) {
      const soc = socialFromUrl(href);
      msg(socialSite === "douyin" ? "正在推送抖音作品…" : "正在推送小红书笔记…");
      try {
        // 能拆到作品 ID 就直接建任务（毫秒级，和 B站 一样快）；
        // 只有短链这种拆不出 ID 的才交给服务端解析。
        const body = soc
          ? { social: [{ source: soc.kind, ident: soc.ident, web_url: href, xsec_token: xhsTokenFromUrl(href), title }] }
          : { links: href };
        let res;
        try {
          res = await request("POST", "/api/download", body);
        } catch (err) {
          if (body.social && /没有选择任何下载内容|没有识别到可下载/.test(err.message || "")) {
            res = await request("POST", "/api/download", { links: href });
          } else {
            throw err;
          }
        }
        msg(`已创建 ${res.count} 个任务${res.failed && res.failed.length ? `，失败 ${res.failed.length} 个` : ""}，可在 WebUI 的任务队列查看`, "ok");
      } catch (err) {
        msg(err.message, "err");
      }
      return;
    }
    const item = detectFromUrl(href);
    if (!item.ident) {
      msg("当前页面不是视频 / 图文 / 专栏页", "err");
      return;
    }
    const body = item.kind === "video"
      ? { video_idents: [item.ident], opus: [] }
      : { video_idents: [], opus: [{ oid: item.ident, sub_kind: item.kind, title }] };
    msg("正在创建下载任务…");
    try {
      const res = await request("POST", "/api/download", body);
      msg(`已创建 ${res.count} 个任务${res.failed && res.failed.length ? `，失败 ${res.failed.length} 个` : ""}，可在 WebUI 的任务队列查看`, "ok");
    } catch (err) {
      msg(err.message, "err");
    }
  });

  widget.querySelector("#bilidl-direct").addEventListener("click", async () => {
    const raw = widget.querySelector("#bilidl-links").value.trim();
    if (!raw) {
      msg("请先输入链接", "err");
      return;
    }
    const links = raw.split(/[\s,，;；]+/).filter((x) => x);
    const videos = [];
    const opus = [];
    const leftovers = [];
    const ytLinks = [];
    const socialLinks = [];
    const socialTargets = [];
    links.forEach((link) => {
      if (isYouTubeUrl(link)) {
        ytLinks.push(link);
        return;
      }
      if (socialHosts(link)) {
        const soc = socialFromUrl(link);
        if (soc) socialTargets.push({ source: soc.kind, ident: soc.ident, web_url: link, xsec_token: xhsTokenFromUrl(link), title: "" });
        else socialLinks.push(link);
        return;
      }
      const item = detectFromUrl(link);
      if (item.kind === "video") videos.push(item.ident);
      else if (item.kind === "opus" || item.kind === "dynamic" || item.kind === "article")
        opus.push({ oid: item.ident, sub_kind: item.kind, title: "" });
      else leftovers.push(link);
    });
    if (!videos.length && !opus.length && !ytLinks.length && !socialLinks.length) {
      msg("这些链接需要先在 WebUI 里解析（短链/空间页），请点「在 WebUI 中选择」", "err");
      return;
    }
    msg("正在创建下载任务…");
    let count = 0;
    const failed = [];
    try {
      if (videos.length || opus.length) {
        const res = await request("POST", "/api/download", { video_idents: videos, opus });
        count += res.count || 0;
        if (res.failed) failed.push(...res.failed);
      }
      if (socialTargets.length) {
        const res = await request("POST", "/api/download", { social: socialTargets });
        count += res.count || 0;
        if (res.failed) failed.push(...res.failed);
      }
      if (ytLinks.length || socialLinks.length) {
        // YouTube 与拆不出 ID 的抖音 / 小红书短链交给服务端解析
        const res = await request("POST", "/api/download", { links: ytLinks.concat(socialLinks).join("\n") });
        count += res.count || 0;
        if (res.failed) failed.push(...res.failed);
      }
      msg(`已创建 ${count} 个任务${failed.length ? `，失败 ${failed.length} 个` : ""}，可在 WebUI 的任务队列查看`, "ok");
    } catch (err) {
      msg(err.message, "err");
    }
  });

  // 从抖音 / 小红书地址里拆作品 ID：拆得到就直推 social（服务端毫秒建任务），
  // 拆不到（短链 / 分享口令）再退回 links 让服务端解析。
  function xhsTokenFromUrl(href) {
    try {
      return new URL(href, location.href).searchParams.get("xsec_token") || "";
    } catch (e) {
      return "";
    }
  }

  function socialFromUrl(href) {
    const site = socialHosts(href);
    if (!site) return null;
    let m = null;
    if (site === "douyin") {
      m = href.match(/(?:share\/)?(?:video|note|slides)\/(\d{8,})/) || href.match(/[?&](?:modal_id|aweme_id|vid)=(\d{8,})/);
    } else {
      m = href.match(/\/(?:explore|discovery\/item|user\/profile\/[0-9a-fA-F]+)\/([0-9a-fA-F]{20,32})/)
        || href.match(/[?&](?:note_id|noteId)=([0-9a-fA-F]{20,32})/);
    }
    return m ? { kind: site, ident: m[1], url: href } : null;
  }

  function detectFromUrl(href) {
    if (isYouTubeUrl(href)) {
      const yt = detectYouTube(href);
      if (yt.kind) return { kind: yt.kind, ident: yt.ident, url: yt.text, youtube: true };
      return { kind: "", ident: "" };
    }
    let m = href.match(/video\/(BV[0-9A-Za-z]{10})/);
    if (m) return { kind: "video", ident: m[1] };
    m = href.match(/opus\/(\d{6,})/);
    if (m) return { kind: "opus", ident: m[1] };
    m = href.match(/read\/cv(\d{1,12})/);
    if (m) return { kind: "article", ident: m[1] };
    m = href.match(/t\.bilibili\.com\/(\d{15,})/);
    if (m) return { kind: "dynamic", ident: m[1] };
    const soc = socialFromUrl(href);
    if (soc) return soc;
    return { kind: "", ident: "" };
  }

  /* ================================================================
   *  图文作品多选下载
   *  1) 弹窗：从 BiliDL 服务端检索该 UP 主全部图文（服务端自带 1.6s/页 延迟），
   *     以封面网格列出，点选/全选后一次性发送下载。
   *  2) 页面卡片：对当前页面上已经渲染出来的图文卡片注入勾选框（尽力而为），
   *     勾选后底部出现「已选 N 个 · 发送下载」。
   * ================================================================ */

  // 选中的作品：key = "video:BVxxxx" 或 "opus:123456" -> { kind, ident, title }
  const picked = new Map();
  // 多选模式：默认关闭（用户要求默认不主动开启），记忆上次选择
  let selMode = false;
  let opicSeq = 0;                     // 图文图片计数用的请求序号（必须在任何调用之前声明）
  try {
    // 不恢复上次的开关：每次打开页面都默认关闭多选，避免一进页面就满屏勾选框
    gmGet("selMode", false);
  } catch (e) {
    selMode = false;
  }
  const keyOf = (kind, ident) => kind + ":" + ident;
  const isPicked = (kind, ident) => picked.has(keyOf(kind, ident));

  function togglePick(kind, ident, title, url) {
    const key = keyOf(kind, ident);
    if (picked.has(key)) picked.delete(key);
    else picked.set(key, { kind, ident, title: title || "", url: url || "" });
    syncCount();
  }

  const modal = document.createElement("div");
  modal.id = "bilidl-modal";
  modal.innerHTML = `
    <div id="bilidl-dialog">
      <header>
        <span class="title">多选图文作品</span>
        <span class="sub" id="bilidl-opus-sub">未检索</span>
        <span class="spacer"></span>
        <button id="bilidl-opus-close">关闭</button>
      </header>
      <div class="bar">
        <button id="bilidl-opus-refresh">检索此 UP 主全部图文</button>
        <button id="bilidl-opus-all">全选</button>
        <button id="bilidl-opus-none">清空</button>
        <input id="bilidl-filter" placeholder="按标题搜索…" />
        <span>已选 <span class="count" id="bilidl-opus-count">0</span> 个</span>
        <span class="hint" id="bilidl-opus-hint">先检索，再点封面多选</span>
        <button class="primary" id="bilidl-opus-send" disabled>发送下载</button>
      </div>
      <div id="bilidl-grid"><div id="bilidl-empty">点上面的「检索此 UP 主全部图文」开始</div></div>
    </div>
  `;
  document.body.appendChild(modal);

  const selbar = document.createElement("div");
  selbar.id = "bilidl-selbar";
  selbar.innerHTML = `
    <span>已选 <span class="n" id="bilidl-selbar-n">0</span> 个</span>
    <span class="kinds" id="bilidl-selbar-kinds"></span>
    <button id="bilidl-mode" title="开着时点封面就是选中，不会跳转">选择模式：开</button>
    <button id="bilidl-selbar-all">全选本页</button>
    <button id="bilidl-selbar-clear">清空</button>
    <button class="primary" id="bilidl-selbar-send">发送下载</button>
  `;
  document.body.appendChild(selbar);

  // 空间页常驻提示：告诉用户「点缩略图就能选」
  const tip = document.createElement("div");
  tip.id = "bilidl-tip";
  tip.innerHTML = `<span>点卡片/缩略图即可<b>多选</b>，选好点底部「发送下载」</span><button title="知道了">×</button>`;
  document.body.appendChild(tip);
  let tipClosed = false;
  tip.querySelector("button").addEventListener("click", () => {
    tipClosed = true;
    tip.classList.remove("on");
  });
  function updateTip(hasCards) {
    const host = location.hostname;
    const isListPage =
      host === "space.bilibili.com" ||
      /(^|\.)douyin\.com$/.test(host) ||
      /(^|\.)(xiaohongshu|rednote)\.(com|cn)$/.test(host);
    tip.classList.toggle("on", selMode && isListPage && hasCards && !tipClosed);
  }

  const q = (sel, root) => (root || document).querySelector(sel);
  let opusWorks = [];
  let filterQ = "";

  function matchQ(title) {
    const text = String(title || "").toLowerCase();
    const toks = String(filterQ || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    return toks.every((t) => text.includes(t));
  }

  function visibleWorks() {
    return filterQ ? opusWorks.filter((w) => matchQ(w.title)) : opusWorks;
  }
  let scanning = false;

  function syncCount() {
    const items = [...picked.values()];
    const vids = items.filter((i) => i.kind === "video").length;
    const dy = items.filter((i) => i.kind === "douyin").length;
    const xhs = items.filter((i) => i.kind === "xhs").length;
    const opus = items.length - vids - dy - xhs;
    const n = items.length;
    const kinds = [];
    if (vids) kinds.push("视频 " + vids);
    if (opus) kinds.push("图文 " + opus);
    if (dy) kinds.push("抖音 " + dy);
    if (xhs) kinds.push("小红书 " + xhs);
    q("#bilidl-opus-count").textContent = String([...picked.keys()].filter((k) => k.startsWith("opus:")).length);
    q("#bilidl-opus-send").disabled = n === 0;
    const barSend = q("#bilidl-selbar-send");
    if (barSend) barSend.disabled = n === 0;
    q("#bilidl-selbar-n").textContent = String(n);
    q("#bilidl-selbar-kinds").textContent = n ? `（${kinds.join(" / ")}）` : "";
    const hasCards = !!document.querySelector("[data-bilidl-key]");
    selbar.classList.toggle("on", n > 0 || hasCards);
    updateTip(hasCards);
    q("#bilidl-opus-send").textContent = n ? `发送下载（${n}）` : "发送下载";
    q("#bilidl-selbar-send").textContent = n ? `发送下载（${n}）` : "发送下载";
    document.querySelectorAll(".bilidl-card").forEach((card) => {
      const on = isPicked("opus", card.dataset.oid);
      card.classList.toggle("sel", on);
      const tick = card.querySelector(".tick");
      if (tick) tick.textContent = on ? "✓" : "";
    });
    document.querySelectorAll("[data-bilidl-key]").forEach((el) => {
      const on = picked.has(el.dataset.bilidlKey);
      const box = el.querySelector(".bilidl-ov");
      if (box) box.checked = on;
      el.classList.toggle("bilidl-picked-ring", on);
    });
  }

  function renderGrid() {
    const grid = q("#bilidl-grid");
    if (!opusWorks.length) {
      grid.innerHTML = `<div id="bilidl-empty">没有检索到图文作品</div>`;
      return;
    }
    const list = visibleWorks();
    if (!list.length) {
      grid.innerHTML = `<div id="bilidl-empty">没有标题匹配的作品（共 ${opusWorks.length} 个）</div>`;
      return;
    }
    grid.innerHTML = list
      .map(
        (w) => `
      <div class="bilidl-card${isPicked("opus", w.ident) ? " sel" : ""}" data-oid="${esc(w.ident)}" title="${esc(w.title)}">
        <div class="tick">${isPicked("opus", w.ident) ? "✓" : ""}</div>
        <img class="cover" loading="lazy" referrerpolicy="no-referrer" src="${esc(w.cover || "")}" alt="">
        <div class="meta">
          <div class="t">${esc(w.title || "（无标题）")}</div>
          <div class="id">${esc(w.ident)}</div>
        </div>
      </div>`
      )
      .join("");
    grid.querySelectorAll(".bilidl-card").forEach((card) => {
      card.addEventListener("click", () => {
        const oid = card.dataset.oid;
        togglePick("opus", oid, card.querySelector(".t").textContent);
      });
    });
  }

  async function scanOpus(mid) {
    if (scanning) return;
    if (!mid) {
      q("#bilidl-opus-hint").textContent = "当前页面不是 UP 主空间，无法检索";
      return;
    }
    scanning = true;
    q("#bilidl-opus-refresh").disabled = true;
    q("#bilidl-opus-sub").textContent = "UP " + mid;
    q("#bilidl-opus-hint").textContent = "正在检索…";
    q("#bilidl-grid").innerHTML = `<div id="bilidl-empty">正在检索该 UP 主的图文作品，请稍候…</div>`;
    try {
      const { job } = await request("POST", "/api/space/scan", { mid: String(mid), tabs: ["opus"] });
      let data = null;
      let fails = 0;
      const startedAt = Date.now();
      for (let i = 0; i < 400; i += 1) {
        await sleep(1500);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (elapsed > 300) throw new Error("检索超过 5 分钟仍未完成，请到 WebUI 里看任务日志");
        try {
          data = await request("GET", "/api/space/scan/" + encodeURIComponent(job));
          fails = 0;
        } catch (err) {
          fails += 1;
          if (fails >= 3) throw err;
          q("#bilidl-opus-hint").textContent = `检索中…（${elapsed}s，与 BiliDL 的连接不稳定，重试 ${fails}/3）`;
          continue;
        }
        q("#bilidl-opus-hint").textContent = (data.message || "检索中…") + `（${elapsed}s）`;
        if (data.status === "done" || data.status === "error" || data.status === "canceled") break;
      }
      if (!data || data.status !== "done") {
        throw new Error((data && data.message) || "检索失败");
      }
      opusWorks = (data.opus || []).filter((w) => w && w.ident);
      q("#bilidl-opus-sub").textContent = `${(data.user && data.user.name) || "UP " + mid} · 图文 ${opusWorks.length} 个`;
      q("#bilidl-opus-hint").textContent = opusWorks.length
        ? "点封面多选，选好后点「发送下载」"
        : "该 UP 主没有检索到图文作品";
      renderGrid();
      syncCount();
    } catch (err) {
      q("#bilidl-opus-hint").textContent = "检索失败：" + err.message;
      q("#bilidl-grid").innerHTML = `<div id="bilidl-empty">检索失败：${esc(err.message)}</div>`;
    } finally {
      scanning = false;
      q("#bilidl-opus-refresh").disabled = false;
    }
  }

  async function sendPicked() {
    const items = [...picked.values()];
    if (!items.length) return;
    const videoItems = items.filter((i) => i.kind === "video");
    const socialItems = items.filter((i) => i.kind === "douyin" || i.kind === "xhs");
    const rlMatch = location.pathname.match(/\/read\/readlist\/(rl\d+)/i);
    const rlTitle = String(document.title || "").replace(/\s*-\s*哔哩哔哩.*$/, "").trim();
    let rlOrder = 0;
    const opusTargets = items
      .filter((i) => i.kind === "opus" || i.kind === "article")
      .map((i) => {
        const target = { oid: i.ident, sub_kind: i.kind === "article" ? "article" : "opus", title: i.title };
        // 在文集页多选时，带上文集信息，服务端就会用「文集重命名规则」
        if (rlMatch) {
          rlOrder += 1;
          target.readlist = { id: rlMatch[1], title: rlTitle, order: rlOrder };
        }
        return target;
      });
    const body = {};
    // 视频带标题一起推：服务端建任务时不用为了拿标题去查接口（20 个视频要 20×1.2s），
    // cid 等服务端 worker 真正开始下载前再补，任务因此是「点一下立刻出现」。
    if (videoItems.length) {
      body.videos = videoItems.map((i) => ({
        bvid: i.ident,
        video_title: i.title || "",
        all_pages: true,
      }));
    }
    if (opusTargets.length) body.opus = opusTargets;
    // 抖音 / 小红书：多选时已经知道作品 ID，直接建任务（和 B站 一样毫秒级返回），
    // 真实标题 / 流地址由 worker 在下载前补；地址与 xsec_token 一起带上供 worker 解析。
    if (socialItems.length) {
      body.social = socialItems.map((i) => ({
        source: i.kind,
        ident: i.ident,
        web_url: i.url || "",
        xsec_token: xhsTokenFromUrl(i.url || ""),
        title: i.title || "",
      }));
    }
    const parts = [];
    if (videoItems.length) parts.push(`视频 ${videoItems.length} 个`);
    if (opusTargets.length) parts.push(`图文 ${opusTargets.length} 个`);
    if (socialItems.length) parts.push(`抖音/小红书 ${socialItems.length} 个`);

    const modalBtn = q("#bilidl-opus-send");
    // 立刻给成功反馈并清空选择：建任务在服务端只是把 id 写进队列（毫秒级），
    // 但网络抖动 / 旧版服务端可能慢，UI 不能一直卡在「发送中…」。
    picked.clear();
    syncCount();
    q("#bilidl-opus-hint").textContent = `已推送${parts.join("、")}，服务端正在创建任务…`;
    msg(`已推送${parts.join("、")}，正在确认…`, "ok");
    const guard = setTimeout(() => {
      // 服务端迟迟不回：保持「已推送」状态，把按钮恢复可点，别让人以为没点上
      q("#bilidl-opus-hint").textContent = `已推送${parts.join("、")}，服务端仍在处理；可到 WebUI 任务队列确认`;
      if (modalBtn) modalBtn.disabled = false;
      syncCount();
    }, 8000);
    try {
      let res;
      try {
        res = await request("POST", "/api/download", body);
      } catch (err) {
        // 兼容旧版服务端（不认识 social 数组）：退回 links 让它自己解析一次
        if (body.social && /没有选择任何下载内容|没有识别到可下载/.test(err.message || "")) {
          const fallback = socialItems.map((i) => i.url || i.ident).filter(Boolean).join("\n");
          res = await request("POST", "/api/download", { links: fallback });
        } else {
          throw err;
        }
      }
      const bad = res.failed && res.failed.length;
      q("#bilidl-opus-hint").textContent = `已创建 ${res.count} 个任务${bad ? `，${bad} 个失败` : ""}；进度见 WebUI 任务队列`;
      msg(`已创建 ${res.count} 个下载任务`, "ok");
    } catch (err) {
      // 失败就把刚清掉的选择放回去，直接再点一次即可重试
      items.forEach((i) => picked.set(keyOf(i.kind, i.ident), i));
      syncCount();
      q("#bilidl-opus-hint").textContent = "推送失败：" + err.message + "（已恢复选择，可重试）";
      msg("推送失败：" + err.message + "（已恢复选择，可重试）", "err");
    } finally {
      clearTimeout(guard);
      if (modalBtn) modalBtn.disabled = false;
      syncCount();
    }
  }

  function openPicker() {
    modal.classList.add("on");
    q("#bilidl-opus-sub").textContent = currentMid() ? "UP " + currentMid() : "未检索";
    if (!opusWorks.length) scanOpus(currentMid());
  }

  widget.querySelector("#bilidl-mid").addEventListener("input", () => {
    widget.querySelector("#bilidl-picker").disabled = !currentMid();
  });
  widget.querySelector("#bilidl-picker").addEventListener("click", openPicker);
  q("#bilidl-opus-close").addEventListener("click", () => modal.classList.remove("on"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("on");
  });
  q("#bilidl-opus-refresh").addEventListener("click", () => {
    picked.clear();
    opusWorks = [];
    syncCount();
    scanOpus(currentMid());
  });
  q("#bilidl-opus-all").addEventListener("click", () => {
    visibleWorks().forEach((w) => picked.set(keyOf("opus", w.ident), { kind: "opus", ident: w.ident, title: w.title }));
    syncCount();
    document.querySelectorAll(".bilidl-ov").forEach((box) => {
      box.checked = true;
    });
  });
  q("#bilidl-opus-none").addEventListener("click", () => {
    picked.clear();
    document.querySelectorAll(".bilidl-ov").forEach((box) => {
      box.checked = false;
    });
    syncCount();
  });
  q("#bilidl-filter").addEventListener("input", () => {
    filterQ = q("#bilidl-filter").value.trim();
    renderGrid();
  });
  q("#bilidl-opus-send").addEventListener("click", sendPicked);
  q("#bilidl-selbar-send").addEventListener("click", sendPicked);
  q("#bilidl-selbar-clear").addEventListener("click", () => {
    picked.clear();
    syncCount();
  });
  q("#bilidl-selbar-all").addEventListener("click", () => {
    let n = 0;
    scanCards().forEach((c) => {
      const key = keyOf(c.kind, c.ident);
      if (!picked.has(key)) {
        picked.set(key, { kind: c.kind, ident: c.ident, title: c.title, url: c.url || "" });
        n += 1;
      }
    });
    syncCount();
    msg(`已选中本页 ${n} 个作品`, "ok");
  });
  q("#bilidl-mode").addEventListener("click", () => setSelMode(!selMode));
  const selCb = q("#bilidl-selmode");
  if (selCb) {
    selCb.checked = selMode;
    selCb.addEventListener("change", () => setSelMode(selCb.checked));
  }
  const selClear = q("#bilidl-selmode-clear");
  if (selClear) selClear.addEventListener("click", () => {
    picked.clear();
    syncCount();
    msg("已清空已选", "ok");
  });

  /* --------- 页面卡片多选：视频 + 图文（点击缩略图或勾选框） --------- */

  function clearOverlays() {
    document.querySelectorAll(".bilidl-ov").forEach((el) => el.remove());
    document.querySelectorAll(".bilidl-picked-ring").forEach((el) => el.classList.remove("bilidl-picked-ring"));
    const bar = q("#bilidl-selbar");
    if (bar) bar.classList.remove("on");
    const tipEl = q("#bilidl-tip");
    if (tipEl) tipEl.classList.remove("on");
  }

  function setSelMode(on, silent) {
    selMode = !!on;
    try {
      gmSet("selMode", selMode);
    } catch (e) {}
    const cb = q("#bilidl-selmode");
    if (cb) cb.checked = selMode;
    renderMode();
    if (selMode) {
      scheduleMount();
    } else {
      picked.clear();
      syncCount();
      clearOverlays();
    }
    if (!silent) msg(selMode ? "多选模式已开启：点缩略图即选中" : "多选模式已关闭：点缩略图恢复正常跳转", "ok");
  }

  function renderMode() {
    const btn = q("#bilidl-mode");
    if (btn) {
      btn.textContent = "选择模式：" + (selMode ? "开" : "关");
      btn.classList.toggle("off", !selMode);
    }
  }

  // 从 <a href> 或动态卡的 data-url 反推出「这是哪一个作品」
  // （空间「作品搜索」页的「动态」结果不是 <a>，作品链接写在 data-url 上）
  function workOf(el) {
    const raw = el.getAttribute("href") || el.getAttribute("data-url") || "";
    let href = raw;
    try { href = new URL(raw, location.href).href; } catch (e) { href = raw.startsWith("//") ? "https:" + raw : raw; }
    let m = href.match(/\/video\/(BV[0-9A-Za-z]{10})/);
    if (m) return { kind: "video", ident: m[1] };
    m = href.match(/\/opus\/(\d{6,})/);
    if (m) return { kind: "opus", ident: m[1] };
    m = href.match(/\/read\/cv(\d{1,12})/);
    if (m) return { kind: "article", ident: m[1] };
    // 抖音 / 小红书：作品地址带 host，按绝对地址判断（小红书还要保留 xsec_token）
    if (/\/\/(?:www|m|v|jx)\.(?:douyin|iesdouyin)\.com\//.test(href)) {
      m = href.match(/\/(?:share\/)?(?:video|note|slides)\/(\d{8,})/);
      if (!m) m = href.match(/[?&](?:modal_id|aweme_id|vid)=(\d{8,})/);
      if (m) return { kind: "douyin", ident: m[1], url: href };
    }
    if (/\/\/(?:www\.)?(?:xiaohongshu\.(?:com|cn)|xhslink\.(?:com|cn)|rednote\.(?:com|cn))\//.test(href)) {
      m = href.match(/\/(?:explore|discovery\/item|user\/profile\/[0-9a-f]{20,32})\/([0-9a-f]{20,32})/);
      if (!m) m = href.match(/[?&](?:note_id|noteId)=([0-9a-f]{20,32})/);
      if (m) return { kind: "xhs", ident: m[1], url: href };
    }
    return null;
  }

  // 卡片容器：优先用 B站 自己的类名，认不出来再按尺寸/唯一链接兜底
  const CARD_LINK_SEL = "a.bili-cover-card[href], a[href*='/opus/'], a[href*='/video/BV'], a[href*='/read/cv'], a[href*='/video/'], a[href*='/note/'], a[href*='/explore/'], a[href*='/discovery/item/']";

  function distinctKeysIn(el) {
    const set = new Set();
    el.querySelectorAll(CARD_LINK_SEL).forEach((x) => {
      const w = workOf(x);
      if (w) set.add(keyOf(w.kind, w.ident));
    });
    return set;
  }

  function cardRootOf(anchor) {
    const known = anchor.closest(".opus-card, .bili-video-card, .bili-dyn-card-opus, section.note-item, li.note-item");
    if (known) return known;
    let node = anchor.parentElement;
    const vw = window.innerWidth || 1440;
    for (let i = 0; i < 9 && node && node !== document.body; i += 1) {
      if (node.tagName !== "A") {
        const r = node.getBoundingClientRect();
        // 一张卡里「封面链接 + 标题链接」可能指向同一作品，按不同 key 数判断才不会被误判成列表
        if (r.width > 90 && r.height > 80 && r.width < vw * 0.92 && distinctKeysIn(node).size === 1) return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function cardTitleOf(root, work) {
    const el =
      root.querySelector(".dyn-card-opus__title") ||
      root.querySelector(".bili-dyn-card-video__title") ||
      root.querySelector(".opus-card__title") ||
      root.querySelector(".bili-video-card__title") ||
      root.querySelector(".bili-video-card__info--tit") ||
      root.querySelector("h3[title]");
    let text = el ? (el.getAttribute("title") || el.textContent || "").trim() : "";
    if (!text) {
      // 搜索页的动态卡：标题为空时用正文首行（“X@xxx 翻译…”），别拿 UP 主昵称当标题
      const sum = root.querySelector(".dyn-card-opus__summary");
      if (sum) text = (sum.innerText || sum.textContent || "").trim().split("\n").map((s) => s.trim()).find(Boolean) || "";
    }
    if (!text) text = (root.innerText || "").trim().split("\n")[0] || "";
    return text.replace(/\s+/g, " ").slice(0, 120);
  }

  // 空间「作品搜索」页：动态结果卡没有 <a>，只能从 data-url 找外层卡片
  function dataCardRootOf(el) {
    return el.closest(
      ".dyn-card-opus, .bili-dyn-card-opus, .bili-dyn-content__orig__major, .dynamic-list__item, .bili-dyn-list__item, .bili-dyn-item"
    );
  }

  // 动态卡里挑一个「封面」容器挂勾选框：优先相册/封面，找不到就用作品卡本身
  function dataThumbOf(root) {
    return (
      root.querySelector(".bili-album__preview") ||
      root.querySelector(".bili-cover-card") ||
      root.querySelector(".dyn-card-opus__pics") ||
      root.querySelector(".dyn-card-opus") ||
      root
    );
  }

  // 扫描当前页面上所有「作品卡片」
  // 作品缩略图容器：勾选框只挂在这里，保证落在缩略图左上角、不压标题
  function thumbOf(anchor, root) {
    if (/douyin\.com|xiaohongshu\.com|rednote\.com/.test(location.hostname) || (root && root.closest && root.closest("section.note-item, li.note-item"))) {
      // 小红书卡片里第一个 <a> 可能是标题链接，封面要从整张卡里找
      const imgs = root && root.querySelector("img");
      return (
        (anchor.querySelector("img") && anchor) ||
        anchor.closest("a.cover, a.mask") ||
        (root && (root.querySelector("a.cover, a.mask") || (imgs && imgs.parentElement))) ||
        root ||
        anchor
      );
    }
    const a = anchor.closest("a.bili-cover-card, a.opus-card__cover") || anchor;
    const ar = a.getBoundingClientRect();
    const covers = (el) => !!el && (el === a || el.contains(a)) && el !== root;
    let t = a.parentElement;
    // 只接受「包住封面、又不等于整张卡」的祖先；找不到就退回封面链接自身
    if (!covers(t) || t.getBoundingClientRect().height > Math.max(ar.height * 1.8, 120)) {
      t = a.getBoundingClientRect().width > 60 ? a : null;
    }
    if (t && t.getBoundingClientRect().width < 60) t = null;
    return t;
  }

  // 小红书：整页「笔记 ID → 带 token 的链接」索引。列表页里同一张卡可能同时有
  // 封面链接（带 token）和标题链接（不带），先命中的不一定是带 token 的那个。
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

  function bestXhsUrl(root, ident, fallback) {
    if (/[?&]xsec_token=/.test(fallback || "")) return fallback;
    const local = root.querySelector('a[href*="xsec_token="]');
    if (local) {
      const href = local.getAttribute("href") || "";
      if (href.includes(ident)) {
        const m = href.match(/[?&]xsec_token=([^&]+)/);
        if (m) return "https://www.xiaohongshu.com/explore/" + ident + "?xsec_token=" + m[1] + "&xsec_source=pc_feed";
      }
    }
    const hit = xhsTokenHrefMap().get(ident);
    if (hit) {
      try {
        const u = new URL(hit.href, location.href);
        if (!/[?&]xsec_token=/.test(u.search)) u.searchParams.set("xsec_token", hit.token);
        if (!u.searchParams.get("xsec_source")) u.searchParams.set("xsec_source", "pc_feed");
        return u.href;
      } catch (e) {}
    }
    return fallback || ("https://www.xiaohongshu.com/explore/" + ident);
  }

  function scanCards() {
    const out = [];
    const seenKey = new Set();
    const linkSel = CARD_LINK_SEL;
    const dataSel = "[data-url*='/opus/'], [data-url*='/video/BV'], [data-url*='/read/cv']";
    // 动态（空间搜索页的「动态」结果、动态 tab）用 data-url，视频/图文卡片用 <a href>，两者都要扫
    document.querySelectorAll(linkSel + ", " + dataSel).forEach((a) => {
      const work = workOf(a);
      if (!work) return;
      const isLink = a.tagName === "A";
      let root = isLink ? cardRootOf(a) : dataCardRootOf(a);
      if (!root || !root.isConnected) return;
      let thumb = null;
      if (isLink) {
        // 列表页（文集/列表）里多篇文章共用一个容器时，以链接自身为卡片，避免共用一个勾选框；
        // 普通视频卡里「封面链接 + 标题链接」指向同一个作品，不能因此退化成链接本身（否则标题会变成播放量）
        const innerKeys = new Set();
        root.querySelectorAll(linkSel).forEach((x) => {
          const w2 = workOf(x);
          if (w2) innerKeys.add(keyOf(w2.kind, w2.ident));
        });
        if (innerKeys.size > 1) {
          root = a.closest("a") || a;
          // 这种「一个链接就是一张卡」的列表页，勾选框挂在它自己的封面上
          const img = root.querySelector("img");
          root._bilidlThumb = img ? img.parentElement : root;
        }
        // 优先用封面链接算缩略图（先命中的可能是标题链接，算出来会落在标题上）
        const coverA = root.querySelector("a.bili-cover-card, a.opus-card__cover") || a;
        thumb = root._bilidlThumb || thumbOf(coverA, root);
      } else {
        thumb = dataThumbOf(root);
      }
      const key = keyOf(work.kind, work.ident);
      let url = work.url || "";
      if (work.kind === "xhs") url = bestXhsUrl(root, work.ident, url);
      // 一部作品只保留一张卡（同一作品常有封面链接 + 标题链接两个 a）
      if (seenKey.has(key)) {
        if (work.kind === "xhs" && /[?&]xsec_token=/.test(url)) {
          const hit = out.find((x) => x.key === key);
          if (hit && !/[?&]xsec_token=/.test(hit.url || "")) hit.url = url;
        }
        return;
      }
      seenKey.add(key);
      out.push({ root, thumb, kind: work.kind, ident: work.ident, title: cardTitleOf(root, work), key, url });
    });
    // 小红书用户主页/话题页：封面链接指向 /user/profile/<id>/，笔记 id 在 data-note-id
    // 或隐藏的 /explore/ 链接里（滚动懒加载后才填），这里按卡片补扫一遍
    const tokenMap = xhsTokenMap();
    document.querySelectorAll("section.note-item, .note-item, [data-note-id]").forEach((card) => {
      const id = xhsNoteIdOf(card);
      if (!id) return;
      const key = keyOf("xhs", id);
      const token = xhsTokenOf(card, tokenMap);
      const url = bestXhsUrl(card, id, "https://www.xiaohongshu.com/explore/" + id +
        (token ? "?xsec_token=" + encodeURIComponent(token) + "&xsec_source=pc_user" : ""));
      if (seenKey.has(key)) {
        const hit = out.find((x) => x.key === key);
        if (hit && /[?&]xsec_token=/.test(url)) hit.url = url;
        return;
      }
      seenKey.add(key);
      out.push({
        root: card,
        thumb: card.querySelector("a.cover, a.mask, a[href*='xsec_token=']") || card,
        kind: "xhs",
        ident: id,
        title: cardTitleOf(card, { kind: "xhs", ident: id }),
        key,
        url,
      });
    });
    return out;
  }

  // 小红书：从页面 __INITIAL_STATE__ 收集 noteId -> xsecToken（用户主页卡片常常没有可见的笔记链接）
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
    try {
      const st = window.__INITIAL_STATE__;
      if (st) walk(JSON.parse(JSON.stringify(st)), 0);
    } catch (e) {}
    _xhsTokenCache = { at: Date.now(), map };
    return map;
  }

  function xhsNoteIdOf(card) {
    const direct = card.getAttribute("data-note-id") || "";
    if (/^[0-9a-f]{20,32}$/i.test(direct)) return direct;
    const a = card.querySelector("a[href*='/explore/'], a[href*='/discovery/item/']");
    const m = a && (a.getAttribute("href") || "").match(/\/(?:explore|discovery\/item)\/([0-9a-f]{20,32})/i);
    return m ? m[1] : "";
  }

  function xhsTokenOf(card, map) {
    const a = card.querySelector("a[href*='xsec_token=']");
    if (a) {
      const m = (a.getAttribute("href") || "").match(/[?&]xsec_token=([^&]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    return map.get(xhsNoteIdOf(card)) || "";
  }

  function mountOverlayBoxes() {
    if (!selMode) return;
    // 两个脚本同时装时，只让先跑的那个挂勾选框，避免一个作品出现两个框
    if (window.__bilidlOvOwner && window.__bilidlOvOwner !== "pusher") return;
    if (!window.__bilidlOvOwner) {
      window.__bilidlOvOwner = "pusher";
      document.querySelectorAll(".bilidl-ov").forEach((b) => b.remove());
    }
    scanCards().forEach((card) => {
      card.root.dataset.bilidlKey = card.key;
      card.root.dataset.bilidlKind = card.kind;
      card.root.dataset.bilidlIdent = card.ident;
      card.root.dataset.bilidlTitle = card.title;
      card.root.dataset.bilidlUrl = card.url || "";

      const host = card.thumb;
      if (!host) return; // 认不出缩略图就不画框，绝不压到标题
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      // 同一个缩略图里只允许一个勾选框
      host.querySelectorAll(":scope > .bilidl-ov").forEach((b) => b.remove());

      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "bilidl-ov";
      box.dataset.oid = card.ident;
      box.dataset.key = card.key;
      box.title = "勾选后点底部「发送下载」（选择模式下点封面也能选）";
      box.checked = picked.has(card.key);
      box.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pickFromCard(card.root);
      });
      host.appendChild(box);
    });
    // 清掉历史遗留 / 重复的勾选框（不属于任何当前作品的、或同一作品多出来的）
    const keys = new Set(scanCards().map((c) => c.key));
    const keptKeys = new Set();
    document.querySelectorAll(".bilidl-ov").forEach((b) => {
      const k = b.dataset.key || (b.parentElement && b.parentElement.dataset.bilidlKey) || "";
      if (!k || !keys.has(k) || keptKeys.has(k) || !b.isConnected) { b.remove(); return; }
      keptKeys.add(k);
    });
    syncCount();
  }

  // 全局唯一的选择监听：只绑一次。旧版给每张卡各绑一个 capture 监听，
  // 页面重渲染/重复 mount 会叠加监听 → 一次点击切换两次 → 已选数在 0 和 1 之间跳。
  function pickFromCard(card) {
    if (!card) return;
    const kind = card.dataset.bilidlKind;
    const ident = card.dataset.bilidlIdent;
    togglePick(kind, ident, card.dataset.bilidlTitle || "", card.dataset.bilidlUrl || "");
  }

  document.addEventListener(
    "click",
    (e) => {
      if (!selMode) return;
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#bilidl-tip, #bilidl-selbar, #bilidl-modal, #bilidl-panel")) return;
      if (t.classList && t.classList.contains("bilidl-ov")) {
        // 勾选框本身：只挡住外层 <a> 的跳转，别 stopPropagation，否则 box 自己的 click 收不到
        e.preventDefault();
        return;
      }
      const card = t.closest("[data-bilidl-key]");
      if (!card) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button || 0) !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      pickFromCard(card);
    },
    true
  );

  let mountTimer = 0;
  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = 0;
      mountOverlayBoxes();
    }, 600);
  }

  const obs = new MutationObserver(scheduleMount);
  obs.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("scroll", scheduleMount, { passive: true });
  window.addEventListener("load", scheduleMount);
  scheduleMount();
  refreshOpusCount();
  setTimeout(refreshOpusCount, 2500);

  // ---- 当前图文 / 专栏的图片总数 ----
  function opicHost() {
    let el = document.getElementById("bilidl-opic");
    if (el) return el;
    el = document.createElement("div");
    el.id = "bilidl-opic";
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
    // 两个脚本同时装时只留一个计数气泡（谁先跑谁占位），避免叠在一起
    if (window.__bilidlOpicOwner && window.__bilidlOpicOwner !== "pusher") {
      const mine = document.getElementById("bilidl-opic"); if (mine) mine.style.display = "none";
      return;
    }
    window.__bilidlOpicOwner = "pusher";
    const mOpus = location.pathname.match(/\/opus\/(\d{6,})/);
    const mCv = location.pathname.match(/\/read\/cv(\d{1,12})/);
    const box = document.getElementById("bilidl-opic");
    if (!mOpus && !mCv) { if (box) box.style.display = "none"; return; }
    const seq = ++opicSeq;
    let n = opicCountFromDom(!!mCv);
    if (!n && mOpus) {
      try {
        const r = await fetch("https://api.bilibili.com/x/polymer/web-dynamic/v1/opus/detail?id=" + mOpus[1], { credentials: "include" });
        const j = await r.json();
        const mods = (j && j.data && j.data.item && j.data.item.modules) || [];
        n = opicCountFromModules(mods);
      } catch (e) {}
    }
    if (seq !== opicSeq) return;
    const el = opicHost();
    el.style.display = n > 0 ? "inline-flex" : "none";
    el.querySelector(".n").textContent = String(n);
  }

  // SPA 页面切换时重新识别
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      opusWorks = [];
      renderGrid();
      syncCount();
      const panel = widget.querySelector("#bilidl-panel");
      if (panel.classList.contains("on")) refresh();
      else current = detect();
      scheduleMount();
      refreshOpusCount();
      // 抖音 / 小红书是 SPA：从别处切到作者主页时也要上报一次
      const author = socialAuthorOf(location.href);
      if (author) {
        reportAt[author.source + ":" + author.target] = 0;
        setTimeout(scheduleReport, 2000);
      }
    }
  }, 1200);

  GM_registerMenuCommand("打开设置面板", () => setPanel(true));
  GM_registerMenuCommand("打开 BiliDL WebUI", () => window.open(getServer() + "/", "_blank"));
  GM_registerMenuCommand("设置 BiliDL 服务地址", () => {
    const value = prompt("BiliDL 服务地址（默认 http://127.0.0.1:2197）", getServer());
    if (value) {
      setServer(value.trim());
      widget.querySelector("#bilidl-server").value = getServer();
    }
  });

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
  let cmtTpl = (() => { try { return gmGet(CMT_KEY, CMT_DEFAULT) || CMT_DEFAULT; } catch (e) { return CMT_DEFAULT; } })();

  function cmtSave(tpl) {
    cmtTpl = String(tpl || "").trim() || CMT_DEFAULT;
    try { gmSet(CMT_KEY, cmtTpl); } catch (e) {}
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

  try { window.__bilidlCMT = { collect: cmtCollect, picUrl: cmtPicUrl, render: cmtRender, btn: cmtBtnHTML, full: cmtFullPics }; } catch (e) {}

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

  /* 评论图片：注入设置项 + 启动扫描 */
  (function initCmt() {
    const panel = widget.querySelector("#bilidl-panel");
    if (panel) {
      const box = document.createElement("div");
      box.className = "bilidl-cmt-box";
      box.innerHTML = '<div class="bilidl-h">评论/动态图片重命名规则</div>' +
        '<input id="bilidl-cmt-tpl" type="text" value="' + cmtTpl.replace(/"/g, "&quot;") + '">' +
        '<div class="bilidl-note">变量：&lt;author&gt; 评论者/主播昵称 · &lt;video_id&gt; 视频BV号 · &lt;comment_id&gt; 评论id · &lt;order&gt; 图片序号 · &lt;ext&gt; 扩展名<br>默认 &lt;author&gt;-&lt;video_id&gt;-&lt;comment_id&gt;-&lt;order&gt;.&lt;ext&gt;</div>' +
        '<div class="bilidl-row"><button id="bilidl-cmt-save" type="button">保存</button></div>';
      panel.appendChild(box);
      const btn = box.querySelector("#bilidl-cmt-save");
      if (btn) btn.addEventListener("click", (e) => { e.preventDefault(); cmtSave(box.querySelector("#bilidl-cmt-tpl").value); cmtToast("已保存评论/动态图片命名规则"); });
    }
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
  })();


  /* ------------------------------------------------ 追更上报：抖音 / 小红书作者主页
     这两个平台的「作者作品列表」接口需要平台签名和浏览器指纹，服务端拿不到。
     脚本在作者主页把当页作品（含分享地址、小红书 xsec_token）上报给服务端：
     首次上报只建基线，之后新作品由服务端自动建下载任务。 */
  function socialAuthorOf(href) {
    try {
      const u = new URL(href, location.href);
      const h = u.hostname.replace(/^www\./, "");
      if (/(^|\.)(douyin|iesdouyin)\.com$/.test(h)) {
        const m = u.pathname.match(/\/user\/([A-Za-z0-9_\-]{20,})/);
        if (m) return { source: "douyin", target: m[1] };
      }
      if (/(^|\.)(xiaohongshu|rednote)\.(com|cn)$/.test(h)) {
        const m = u.pathname.match(/\/user\/profile\/([0-9a-fA-F]{20,32})/);
        if (m) return { source: "xhs", target: m[1] };
      }
    } catch (e) {}
    return null;
  }

  function socialWorkType(card, kind, url) {
    if (kind === "douyin") return /\/note\/|\/slides\//.test(url || "") ? "opus" : "video";
    const root = card && card.root;
    if (root && (root.querySelector("video") || root.querySelector("[class*='play'], .play-icon"))) return "video";
    return "opus";
  }

  let reportTimer = 0;
  const reportAt = {};

  function reportAuthorWorks(force) {
    const author = socialAuthorOf(location.href);
    if (!author) return;
    const stamp = author.source + ":" + author.target;
    if (!force && Date.now() - (reportAt[stamp] || 0) < 10 * 60 * 1000) return;
    const cards = scanCards().filter((c) => c.kind === author.source);
    // 懒加载没铺开时先等一等，别用半页作品把基线建歪
    if (!cards.length) {
      if (force) {
        msg(
          "当前页没有扫到可上报的作品" +
            (author.source === "xhs"
              ? "（未登录时小红书作者主页只返回 token、不返回笔记 ID，登录后再试；也可以去发现页多选）"
              : ""),
          "err"
        );
      }
      return;
    }
    if (!force && cards.length < 3) return;
    reportAt[stamp] = Date.now();
    const works = cards.map((c) => ({
      ident: c.ident,
      title: c.title || "",
      cover: ((c.root && c.root.querySelector("img[src]")) || {}).src || "",
      url: c.url || "",
      kind: socialWorkType(c, c.kind, c.url),
    }));
    request("POST", "/api/subs/report", { source: author.source, target: author.target, works })
      .then((data) => {
        const text = (data && data.message) || "已上报";
        msg("追更上报：" + text, "ok");
      })
      .catch((err) => msg("追更上报失败：" + (err && err.message ? err.message : err), "err"));
  }

  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = 0;
      reportAuthorWorks(false);
    }, 2500);
  }

  (function initReport() {
    const panel = widget.querySelector("#bilidl-panel");
    if (panel) {
      const box = document.createElement("div");
      box.className = "bilidl-report";
      box.innerHTML = '<div class="bilidl-note">抖音 / 小红书追更：打开作者主页时自动上报作品；首次只建基线，之后新作品自动下载。</div>' +
        '<div class="bilidl-row"><button id="bilidl-report-now" type="button">上报本页作者作品</button></div>';
      panel.appendChild(box);
      const btn = box.querySelector("#bilidl-report-now");
      if (btn) btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!socialAuthorOf(location.href)) {
          msg("当前页面不是抖音 / 小红书作者主页", "err");
          return;
        }
        reportAuthorWorks(true);
      });
    }
    if (socialAuthorOf(location.href)) {
      [1500, 4000, 8000, 14000].forEach((ms) => setTimeout(scheduleReport, ms));
      window.addEventListener("scroll", scheduleReport, { passive: true });
    }
  })();

  refresh();
  setSelMode(selMode, true);
  lastHref = location.href;
})();
