/* BiliDL-PRO WebUI —— 原生 JS，无框架依赖 */
(() => {
  "use strict";

  const state = {
    miniHidden: false,
    spaceQ: "",
    status: null,
    settings: {},
    vars: { video: [], opus: [] },
    parsed: [],
    scan: null,
    scanJob: null,
    scanTimer: null,
    tasks: { tasks: [], stats: {} },
    taskTimer: null,
    qrKey: null,
    qrTimer: null,
    selectedVideos: new Set(),
    selectedTasks: new Set(),
    selectedOpus: new Set(),
    _pausedNote: "",
    page: "download",
    subs: null,
    subPick: null,
    subFilter: "all",
    subSel: new Set(),
  };

  const $ = (id) => document.getElementById(id);
  const el = (sel) => document.querySelector(sel);

  /* ------------------------------------------------ 工具 */
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = "toast " + kind;
    node.textContent = message;
    $("toast").appendChild(node);
    setTimeout(() => node.remove(), kind === "err" ? 6500 : 3600);
  }

  async function api(path, options = {}) {
    const init = { method: options.method || "GET", headers: {} };
    if (init.method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body || {});
    }
    let resp;
    try {
      resp = await fetch(path, init);
    } catch (err) {
      throw new Error("无法连接本地服务：" + err.message);
    }
    let payload = null;
    try {
      payload = await resp.json();
    } catch (err) {
      throw new Error("服务返回了非 JSON 数据（HTTP " + resp.status + "）");
    }
    if (!payload.ok) throw new Error(payload.error || "请求失败");
    return payload.data;
  }

  function fmtBytes(n) {
    n = Number(n || 0);
    if (n < 1024) return n + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return n.toFixed(n >= 100 ? 0 : 1) + " " + units[i];
  }

  function fmtSpeed(n) {
    if (!n) return "";
    return fmtBytes(n) + "/s";
  }

  function fmtDur(sec) {
    sec = Math.round(Number(sec || 0));
    if (!sec) return "";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const p = (v) => String(v).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }

  function cover(url, alt) {
    if (!url) return '<div class="cover"></div>';
    return `<div class="cover"><img loading="lazy" src="${esc(url)}" alt="${esc(alt)}" referrerpolicy="no-referrer"></div>`;
  }

  /* ------------------------------------------------ 导航 */
  function switchPage(name) {
    state.page = name;
    document.querySelectorAll("#nav button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === name);
    });
    document.querySelectorAll(".view").forEach((view) => {
      view.classList.toggle("active", view.id === "view-" + name);
    });
    if (name === "tasks") pollTasks();
    if (name === "subs") loadSubs();
    sessionStorage.setItem("bilidl.page", name);
  }

  $("nav").addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-view]");
    if (btn) switchPage(btn.dataset.view);
  });

  /* ------------------------------------------------ 网络自检 */
  const diagBtn = $("diagBtn");
  if (diagBtn) {
    diagBtn.addEventListener("click", async () => {
      const out = $("diagOut");
      out.textContent = "正在检测…";
      try {
        const d = await api("/api/diagnose");
        const lines = [`版本 ${d.version} · ${d.logged_in ? "已登录" : "未登录"}`];
        (d.checks || []).forEach((c) => {
          lines.push(`${c.ok ? "✅" : "❌"} ${c.name}：${c.ok ? "正常" : "失败"} ${c.status ? "HTTP " + c.status : ""} ${c.ms}ms${c.error ? " " + c.error : ""}`);
        });
        Object.entries(d.dirs || {}).forEach(([k, v]) => lines.push(`${v.writable ? "✅" : "❌"} ${k}：${v.path}${v.writable ? "（可写）" : "（不可写 " + (v.error || "") + "）"}`));
        if ((d.checks || []).every((c) => !c.ok)) lines.push("\n全部失败 → 容器可能没有外网 / DNS；请在 NAS 上确认 Docker 网络能出网。");
        out.textContent = lines.join("\n");
      } catch (err) {
        out.textContent = "诊断失败：" + err.message;
      }
    });
  }

  /* ------------------------------------------------ 状态 */
  async function loadStatus() {
    const data = await api("/api/status");
    state.status = data;
    state.settings = data.settings || {};
    $("sideVersion").textContent = data.version || "1.0.0";
    const logged = !!data.logged_in;
    $("sideLogin").textContent = logged ? (data.user && (data.user.name || data.user.mid)) || "已登录" : "未登录";
    $("sideLoginDot").className = "dot " + (logged ? "on" : "off");
    $("userChip").textContent = logged ? "已登录" : "未登录";
    $("userChip").className = "chip " + (logged ? "ok" : "warn");

    const chips = [];
    chips.push(`<span class="chip ${logged ? "ok" : "warn"}">${logged ? "已登录" : "未登录（仅能下载 720P 以内）"}</span>`);
    chips.push(`<span class="chip ${data.ffmpeg ? "ok" : "warn"}">${data.ffmpeg ? "ffmpeg 就绪" : "无 ffmpeg（用 mp4 直链）"}</span>`);
    chips.push(`<span class="chip">清晰度 ${esc(state.settings.quality || "1080P60")}</span>`);
    $("headChips").innerHTML = chips.join("");
    $("ffmpegHint").textContent = data.ffmpeg
      ? "已检测到 ffmpeg，可合并 DASH 高清音视频流"
      : "未检测到 ffmpeg：高清流无法合并，将自动使用 mp4 直链（≤720P）";

    if (data.user && data.user.logged_in) {
      $("userCard").style.display = "";
      $("userAvatar").src = data.user.avatar || "";
      $("userName").textContent = data.user.name || data.user.mid || "";
      $("userMeta").textContent = `UID ${data.user.mid} · Lv${data.user.level || 1}${data.user.vip ? " · 大会员" : ""}`;
    } else {
      $("userCard").style.display = "none";
    }

    fillQualitySelects(data.quality_choices || []);
    applySettingsToForm(state.settings);
    return data;
  }

  function fillQualitySelects(choices) {
    const options = choices
      .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
      .join("");
    $("qualitySelect").innerHTML = options;
    $("qualitySetting").innerHTML = options;
    $("qualitySelect").value = state.settings.quality || "1080P60";
    $("qualitySetting").value = state.settings.quality || "1080P60";
  }

  $("qualitySelect").addEventListener("change", async (event) => {
    try {
      state.settings.quality = event.target.value;
      await saveSettings({ quality: event.target.value });
      $("qualitySetting").value = event.target.value;
      toast("清晰度已切换为 " + event.target.value, "ok");
      loadStatus();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  /* ------------------------------------------------ 设置 */
  function applySettingsToForm(s) {
    if (!$("videoDir")) return;
    $("videoDir").value = s.video_dir || "";
    $("opusDir").value = s.opus_dir || "";
    $("videoTemplate").value = s.video_template || "";
    $("opusTemplate").value = s.opus_template || "";
    $("readlistTemplate").value = s.readlist_template || "";
    $("defaultAllPages").checked = !!s.default_all_pages;
    $("defaultSeasonAll").checked = !!s.default_season_all;
    $("skipExisting").checked = !!s.skip_existing;
    const ex = s.extras || {};
    const fmtSel = $("audioFormat");
    if (fmtSel) fmtSel.value = s.audio_format === "mp3" ? "mp3" : "m4a";
    $("exAudioOnly").checked = !!ex.audio_only;
    $("exVideoOnly").checked = !!ex.video_only;
    $("exSubtitle").checked = !!ex.subtitle;
    $("exDanmaku").checked = !!ex.danmaku;
    $("exCover").checked = !!ex.cover;
    $("exNfo").checked = !!ex.nfo;
    $("apiInterval").value = s.api_interval;
    $("scanInterval").value = s.scan_interval;
    $("fileInterval").value = s.file_interval;
    $("concurrency").value = s.concurrency;
    $("maxPages").value = s.max_pages;
    $("proxy").value = s.proxy || "";
    if ($("proxyYoutube")) $("proxyYoutube").value = s.proxy_youtube || "";
    if ($("useProxyBili")) $("useProxyBili").checked = s.use_proxy_bili !== false;
    if ($("useProxyYoutube")) $("useProxyYoutube").checked = s.use_proxy_youtube !== false;
    if ($("youtubeCookies")) $("youtubeCookies").value = s.youtube_cookies || "";
    if (s.quality) {
      $("qualitySetting").value = s.quality;
      $("qualitySelect").value = s.quality;
    }
  }

  async function saveSettings(patch) {
    const data = await api("/api/settings", { method: "POST", body: { settings: patch } });
    state.settings = data.settings;
    return data.settings;
  }

  $("saveSettingsBtn").addEventListener("click", async () => {
    const btn = $("saveSettingsBtn");
    btn.disabled = true;
    try {
      const patch = {
        video_dir: $("videoDir").value.trim(),
        opus_dir: $("opusDir").value.trim(),
        quality: $("qualitySetting").value,
        video_template: $("videoTemplate").value,
        opus_template: $("opusTemplate").value,
        readlist_template: $("readlistTemplate").value,
        default_all_pages: $("defaultAllPages").checked,
        default_season_all: $("defaultSeasonAll").checked,
        skip_existing: $("skipExisting").checked,
        audio_format: $("audioFormat") ? $("audioFormat").value : "m4a",
        extras: {
          audio_only: $("exAudioOnly").checked,
          video_only: $("exVideoOnly").checked,
          subtitle: $("exSubtitle").checked,
          danmaku: $("exDanmaku").checked,
          cover: $("exCover").checked,
          nfo: $("exNfo").checked,
        },
        api_interval: Number($("apiInterval").value),
        scan_interval: Number($("scanInterval").value),
        file_interval: Number($("fileInterval").value),
        concurrency: Number($("concurrency").value),
        max_pages: Number($("maxPages").value),
        proxy: $("proxy").value.trim(),
        proxy_youtube: $("proxyYoutube") ? $("proxyYoutube").value.trim() : "",
        use_proxy_bili: $("useProxyBili") ? $("useProxyBili").checked : true,
        use_proxy_youtube: $("useProxyYoutube") ? $("useProxyYoutube").checked : true,
        youtube_cookies: $("youtubeCookies") ? $("youtubeCookies").value : "",
      };
      await saveSettings(patch);
      toast("设置已保存", "ok");
      loadStatus();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
    }
  });

  function renderVars() {
    const build = (list, target, textarea) => {
      target.innerHTML = list
        .map((v) => `<span class="var" data-var="${esc(v.var)}" data-target="${textarea}">${esc(v.var)}<em>${esc(v.desc)}</em></span>`)
        .join("");
    };
    build(state.vars.video || [], $("videoVars"), "videoTemplate");
    build(state.vars.opus || [], $("opusVars"), "opusTemplate");
    build(state.vars.readlist || [], $("readlistVars"), "readlistTemplate");
    if ($("subsVideoVars")) build(state.vars.video || [], $("subsVideoVars"), "subsVideoTpl");
    if ($("subsOpusVars")) build([...(state.vars.readlist || []), ...(state.vars.opus || [])], $("subsOpusVars"), "subsOpusTpl");
  }

  document.addEventListener("click", (event) => {
    const node = event.target.closest(".var");
    if (!node) return;
    const textarea = $(node.dataset.target);
    const text = node.dataset.var;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });

  /* ------------------------------------------------ 链接解析 */
  $("parseBtn").addEventListener("click", async () => {
    const text = $("linksInput").value.trim();
    if (!text) {
      toast("请先粘贴 B站 链接", "err");
      return;
    }
    const btn = $("parseBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 解析中…';
    try {
      const data = await api("/api/parse", { method: "POST", body: { text } });
      state.parsed = data.items.map((item) => decorate(item));
      renderParseResults();
      const bad = state.parsed.filter((it) => !it.ok).length;
      toast(`解析完成：成功 ${state.parsed.length - bad} 条${bad ? `，失败 ${bad} 条` : ""}`, bad ? "err" : "ok");
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "解析链接";
    }
  });

  $("clearLinksBtn").addEventListener("click", () => {
    $("linksInput").value = "";
    state.parsed = [];
    renderParseResults();
  });

  function decorate(item) {
    item._pages = new Set();
    item._eps = new Set();
    item._picked = false;
    item._dir = "";
    item._tpl = "";
    if (!item.ok) return item;
    if (item.kind === "video" && Array.isArray(item.pages)) {
      const all = !!state.settings.default_all_pages;
      item.pages.forEach((page) => {
        if (all || (item.page_hint && page.index === item.page_hint) || (!all && !item.page_hint && page.index === 1)) {
          item._pages.add(page.index);
        }
      });
      if (state.settings.default_season_all && item.season && Array.isArray(item.season.episodes)) {
        item.season.episodes.forEach((ep) => item._eps.add(ep.index));
      }
    } else if (item.kind === "opus") {
      item._picked = true;
    } else if (item.kind === "readlist") {
      item._arts = new Set((item.articles || []).map((a) => a.order));
    } else if (item.kind === "videolist") {
      // 合集可能几百个视频，默认不勾，避免一键全下触发风控
      item._works = new Set();
    }
    return item;
  }

  // 每个解析结果下的「临时下载设置」：留空=走全局默认，只影响本次任务
  function tempSettings(item, index, kind) {
    const isReadlist = kind === "readlist";
    const isVideo = kind === "video" || kind === "videolist";
    const vars = isReadlist
      ? [...(state.vars.readlist || []), ...(state.vars.opus || [])]
      : isVideo
        ? (item.source === "youtube" ? state.vars.youtube || state.vars.video || [] : state.vars.video || [])
        : state.vars.opus || [];
    const phTpl = isReadlist
      ? state.settings.readlist_template || ""
      : isVideo
        ? state.settings.video_template || ""
        : state.settings.opus_template || "";
    const phDir = isVideo ? state.settings.video_dir || "" : state.settings.opus_dir || "";
    const tplId = `ptpl-${index}`;
    const custom = !!(item._dir || item._tpl);
    return `<details class="temp-set"${custom ? " open" : ""}>
      <summary>临时下载设置${custom ? "（已自定义，只对本次任务生效）" : "（不填则使用全局默认）"}</summary>
      <div class="temp-grid">
        <div class="field">
          <label>下载目录<span class="muted">（留空=全局视频/图文目录）</span></label>
          <input type="text" id="pdir-${index}" data-tmp="dir" data-i="${index}" value="${esc(item._dir || "")}" placeholder="${esc(phDir)}">
        </div>
        <div class="field">
          <label>重命名规则<span class="muted">（留空=全局规则）</span></label>
          <textarea id="${tplId}" rows="2" data-tmp="tpl" data-i="${index}" placeholder="${esc(phTpl)}">${esc(item._tpl || "")}</textarea>
          <div class="var-list">${subVarChips(vars, tplId)}</div>
        </div>
      </div>
    </details>`;
  }

  function renderParseResults() {
    const box = $("parseResults");
    if (!state.parsed.length) {
      box.innerHTML = "";
      $("downloadBar").style.display = "none";
      return;
    }
    box.innerHTML = state.parsed.map((item, index) => renderItem(item, index)).join("");
    $("downloadBar").style.display = "";
    updatePickSummary();
  }

  function renderItem(item, index) {
    if (!item.ok) {
      return `<div class="card" style="margin-bottom:12px">
        <div class="rowline">
          <div><b>无法解析</b><div class="err" style="color:var(--red);font-size:12.5px">${esc(item.error || "未知错误")}</div>
          <div class="muted mono">${esc(item.raw || item.link || "")}</div></div>
        </div></div>`;
    }
    if (item.kind === "video") return renderVideoItem(item, index);
    if (item.kind === "opus") return renderOpusItem(item, index);
    if (item.kind === "readlist") return renderReadlistItem(item, index);
    if (item.kind === "videolist") return renderVideolistItem(item, index);
    if (item.kind === "space") {
      return `<div class="card" style="margin-bottom:12px">
        <div class="rowline">
          <div><b>UP主空间：${esc((item.user && item.user.name) || item.mid)}</b>
          <div class="muted">UID ${esc(item.mid)}${item.tab ? " · 默认标签 " + esc(item.tab) : ""}</div></div>
          <button class="btn sm primary" data-gospace="${esc(item.mid)}">去检索该 UP 主全部作品</button>
        </div></div>`;
    }
    return `<div class="card" style="margin-bottom:12px"><b>${esc(item.kind)}</b> ${esc(item.error || "")}</div>`;
  }

  function renderReadlistItem(item, index) {
    const arts = item.articles || [];
    const pills = arts
      .map((a) => `<span class="pill ${item._arts.has(a.order) ? "on" : ""}" data-i="${index}" data-type="art" data-key="${a.order}">
          ${a.cover ? `<img class="epk" loading="lazy" src="${esc(a.cover)}" onerror="this.style.display='none'" referrerpolicy="no-referrer" alt="">` : ""}
          <span class="ep">${a.order}</span><span class="txt">${esc(a.title)}</span></span>`)
      .join("");
    return `<div class="card" style="margin-bottom:12px">
      <div class="rowline">
        <div><div class="title">${esc(item.title)}</div>
        <div class="meta">文集 · ${arts.length} 篇文章 · ${esc(item.id)}</div>
        ${tempSettings(item, index, "readlist")}</div>
        <button class="btn sm primary" data-i="${index}" data-act="download-readlist">下载选中文集文章</button>
      </div>
      <div class="sect">
        <div class="sect-head">
          <span class="t">选择文章（默认全选）</span>
          <button class="btn sm ghost" data-i="${index}" data-act="art-all">全选</button>
          <button class="btn sm ghost" data-i="${index}" data-act="art-none">清空</button>
          <span class="muted">文章列表匿名可读；下载单篇若需要登录会提示</span>
        </div>
        <div class="pills">${pills || '<span class="muted">这个文集里没有解析到文章</span>'}</div>
      </div>
    </div>`;
  }

  function renderVideolistItem(item, index) {
    const works = item.works || [];
    const pills = works
      .map((w) => `<span class="mini ${item._works.has(w.ident) ? "on" : ""}" data-i="${index}" data-type="work" data-key="${esc(w.ident)}">
          ${w.cover
            ? `<img class="mk" loading="lazy" src="${esc(w.cover)}" onerror="this.style.visibility='hidden'" referrerpolicy="no-referrer" alt="">`
            : `<span class="mk noimg"></span>`}
          <span class="chk" title="点击选中/取消"></span>
          <span class="txt">${esc(w.title)}</span></span>`)
      .join("");
    return `<div class="card" style="margin-bottom:12px">
      <div class="rowline">
        <div><div class="title">${esc(item.title)}</div>
        <div class="meta">合集 · ${works.length} 个视频 · ${esc(item.id)}</div>
        ${tempSettings(item, index, "videolist")}</div>
        <button class="btn sm primary" data-i="${index}" data-act="download-videolist">下载选中视频</button>
      </div>
      <div class="sect">
        <div class="sect-head">
          <span class="t">选择视频（默认不选，可全选）</span>
          <button class="btn sm ghost" data-i="${index}" data-act="work-all">全选</button>
          <button class="btn sm ghost" data-i="${index}" data-act="work-none">清空</button>
        </div>
        <div class="minis">${pills || '<span class="muted">这个合集里没有解析到视频</span>'}</div>
      </div>
    </div>`;
  }

  function renderVideoItem(item, index) {
    const pages = Array.isArray(item.pages) ? item.pages : [];
    const pills = pages
      .map(
        (page) => `<span class="pill ${item._pages.has(page.index) ? "on" : ""}" data-i="${index}" data-type="page" data-key="${page.index}">
          ${page.cover ? `<img class="epk" loading="lazy" src="${esc(page.cover)}" data-fb="${esc(item.cover || "")}" onerror="this.onerror=null;this.src=this.dataset.fb||'';" referrerpolicy="no-referrer" alt="">` : ""}
          <span class="ep">P${page.index}</span><span class="txt">${esc(page.title || "分集 " + page.index)}</span></span>`
      )
      .join("");

    let season = "";
    if (item.season && Array.isArray(item.season.episodes) && item.season.episodes.length) {
      const eps = item.season.episodes;
      season = `<div class="sect">
        <div class="sect-head">
          <span class="t">合集「${esc(item.season.title || item.season.id)}」共 ${eps.length} 集</span>
          <button class="btn sm ghost" data-i="${index}" data-act="season-all">全选合集</button>
          <button class="btn sm ghost" data-i="${index}" data-act="season-none">清空合集</button>
          <span class="muted">默认不勾选合集内其它视频</span>
        </div>
        <div class="pills">${eps
          .map(
            (ep) => `<span class="pill ${item._eps.has(ep.index) ? "on" : ""}" data-i="${index}" data-type="ep" data-key="${ep.index}">
              ${ep.cover ? `<img class="epk" loading="lazy" src="${esc(ep.cover)}" data-fb="${esc(item.cover || "")}" onerror="this.onerror=null;this.src=this.dataset.fb||'';" referrerpolicy="no-referrer" alt="">` : ""}
              <span class="ep">${ep.index}</span><span class="txt">${esc(ep.title)}</span></span>`
          )
          .join("")}</div>
      </div>`;
    }

    const sourceLabel = item.source === "douyin" ? "抖音" : item.source === "xhs" ? "小红书" : "";
    const meta = [
      esc(sourceLabel),
      esc(item.author || "未知UP主"),
      pages.length > 1 ? `${pages.length} 个分集` : sourceLabel ? "单作品" : "单分集",
      fmtDur(item.duration) ? "时长 " + fmtDur(item.duration) : "",
      esc(item.bvid),
    ]
      .filter(Boolean)
      .join(" · ");

    return `<div class="card" style="margin-bottom:12px">
      <div class="result" style="border:none;background:transparent;padding:0;margin:0">
        ${cover(item.cover, item.title)}
        <div class="body">
          <div class="title">${esc(item.title)}</div>
          <div class="meta">${meta}</div>
          ${tempSettings(item, index, "video")}
          <div class="sect" style="border-top:none;padding-top:0">
            <div class="sect-head">
              <span class="t">选择分集（默认全选）</span>
              <button class="btn sm ghost" data-i="${index}" data-act="pages-all">全选</button>
              <button class="btn sm ghost" data-i="${index}" data-act="pages-none">全不选</button>
              <span class="grow"></span>
              <span class="muted">已选 ${item._pages.size}/${pages.length}</span>
            </div>
            <div class="pills">${pills || '<span class="muted">该视频没有分集信息</span>'}</div>
          </div>
          ${season}
        </div>
      </div>
    </div>`;
  }

  function renderOpusItem(item, index) {
    const count = item.image_count || 0;
    const sourceLabel = item.source === "douyin" ? "抖音" : item.source === "xhs" ? "小红书" : "";
    const meta = [esc(sourceLabel), esc(item.author || ""), count ? `${count} 张图片` : "无图片", esc(item.sub_kind || "opus"), esc(item.oid)]
      .filter(Boolean)
      .join(" · ");
    return `<div class="card" style="margin-bottom:12px">
      <div class="result" style="border:none;background:transparent;padding:0;margin:0">
        ${cover(item.cover, item.title)}
        <div class="body">
          <div class="title">${esc(item.title)}</div>
          <div class="meta">${meta}</div>
          ${tempSettings(item, index, "opus")}
          <div class="row" style="margin-top:6px">
            <span class="pill ${item._picked ? "on" : ""}" data-i="${index}" data-type="opus" data-key="1">
              <span class="txt">${item._picked ? "已选择下载" : "点击选择下载"}</span>
              <span class="ep">共 ${count} 张</span>
            </span>
          </div>
        </div>
      </div>
    </div>`;
  }

  $("parseResults").addEventListener("input", (event) => {
    const el = event.target.closest("[data-tmp]");
    if (!el) return;
    const item = state.parsed[Number(el.dataset.i)];
    if (!item) return;
    if (el.dataset.tmp === "dir") item._dir = el.value.trim();
    else item._tpl = el.value;
    const box = el.closest(".temp-set");
    if (box) {
      const summary = box.querySelector("summary");
      const custom = !!(item._dir || item._tpl);
      if (summary) {
        summary.textContent = `临时下载设置${custom ? "（已自定义，只对本次任务生效）" : "（不填则使用全局默认）"}`;
      }
    }
    updatePickSummary();
  });

  $("parseResults").addEventListener("click", (event) => {
    const gone = event.target.closest("[data-gospace]");
    if (gone) {
      switchPage("space");
      $("spaceInput").value = gone.dataset.gospace;
      return;
    }
    const act = event.target.closest("[data-act]");
    if (act) {
      const item = state.parsed[Number(act.dataset.i)];
      const action = act.dataset.act;
      if (action === "pages-all") item.pages.forEach((p) => item._pages.add(p.index));
      if (action === "pages-none") item._pages.clear();
      if (action === "season-all" && item.season) item.season.episodes.forEach((ep) => item._eps.add(ep.index));
      if (action === "season-none") item._eps.clear();
      if (action === "art-all") (item.articles || []).forEach((a) => item._arts.add(a.order));
      if (action === "art-none") item._arts.clear();
      if (action === "work-all") (item.works || []).forEach((w) => item._works.add(w.ident));
      if (action === "work-none") item._works.clear();
      if (action === "download-readlist" || action === "download-videolist") {
        const onlyItem = [item];
        const saved = state.parsed;
        state.parsed = onlyItem;
        const { videos, opus } = collectDownloads();
        state.parsed = saved;
        if (!videos.length && !opus.length) { toast("还没有选中任何文章/视频", "err"); return; }
        api("/api/download", { method: "POST", body: { videos, opus } })
          .then((data) => { toast(`已创建 ${data.count} 个下载任务`, "ok"); switchPage("tasks"); pollTasks(); })
          .catch((err) => toast(err.message, "err"));
        return;
      }
      renderParseResults();
      return;
    }
    const pill = event.target.closest(".pill, .mini");
    if (!pill) return;
    const item = state.parsed[Number(pill.dataset.i)];
    const type = pill.dataset.type;
    const key = Number(pill.dataset.key);
    if (type === "art") {
      const k = Number(pill.dataset.key);
      if (item._arts.has(k)) item._arts.delete(k); else item._arts.add(k);
      pill.classList.toggle("on", item._arts.has(k));
      updatePickSummary();
      return;
    }
    if (type === "work") {
      const k = pill.dataset.key;
      if (item._works.has(k)) item._works.delete(k); else item._works.add(k);
      pill.classList.toggle("on", item._works.has(k));
      updatePickSummary();
      return;
    }
    if (type === "page") {
      if (item._pages.has(key)) item._pages.delete(key);
      else item._pages.add(key);
    } else if (type === "ep") {
      if (item._eps.has(key)) item._eps.delete(key);
      else item._eps.add(key);
    } else if (type === "opus") {
      item._picked = !item._picked;
    }
    pill.classList.toggle("on", type === "opus" ? item._picked : type === "page" ? item._pages.has(key) : item._eps.has(key));
    if (type !== "opus") {
      const hint = pill.closest(".sect")?.querySelector(".muted");
      if (hint && hint.textContent.includes("已选")) hint.textContent = `已选 ${item._pages.size}/${item.pages.length}`;
    }
    updatePickSummary();
  });

  function collectDownloads() {
    const videos = [];
    const opus = [];
    const seen = new Set();
    state.parsed.forEach((item) => {
      if (!item.ok) return;
      if (item.kind === "video") {
        // videoTitle：只有「合集里的其它视频」需要单独传——合集内每一集都是独立视频，
        // 文件名里的 video_title 必须是这一集自己的标题，不能沿用解析入口那个视频的标题，
        // 否则整季 N 个文件全叫同一个名字。
        const push = (bvid, cid, pageIndex, pageTitle, extra, videoTitle, pageObj) => {
          const ex = extra || {};
          const key = bvid + ":" + cid;
          if (seen.has(key)) return;
          seen.add(key);
          videos.push({
            bvid,
            cid,
            page_index: pageIndex,
            page_title: pageTitle,
            video_title: videoTitle || item.title,
            author: item.author,
            pubdate: item.pubdate,
            season_id: ex.season_id || item.season_id || "",
            season_title: ex.season_title || item.season_title || "",
            season_order: ex.season_order || 0,
            author_uid: ex.author_uid || item.mid || "",
            source: item.source || "",
            cover: (pageObj && pageObj.cover) || item.cover || "",
            desc: item.desc || "",
            web_url: item.web_url || item.link || "",
            duration: (pageObj && pageObj.duration) || item.duration || 0,
            dir: item._dir || "",
            template: item._tpl || "",
          });
        };
        item.pages.forEach((page) => {
          if (item._pages.has(page.index)) push(item.bvid, page.cid, page.index, page.title, page, undefined, page);
        });
        if (item.season && item.season.episodes) {
          item.season.episodes.forEach((ep) => {
            if (item._eps.has(ep.index)) {
              push(ep.bvid, ep.cid, ep.index, ep.title, {
                season_id: item.season.id || item.season_id || "",
                season_title: item.season.title || "",
                season_order: ep.index,
                author_uid: item.mid || "",
              }, ep.title || ep.bvid);
            }
          });
        }
      } else if (item.kind === "opus" && item._picked) {
        opus.push({
          oid: item.oid,
          sub_kind: item.sub_kind || "opus",
          title: item.title,
          source: item.source || "",
          author: item.author || "",
          pubdate: item.pubdate || 0,
          cover: item.cover || "",
          web_url: item.web_url || item.url || item.link || "",
          xsec_token: item.xsec_token || "",
          dir: item._dir || "",
          template: item._tpl || "",
        });
      } else if (item.kind === "readlist") {
        (item.articles || []).forEach((a) => {
          if (!item._arts || !item._arts.has(a.order)) return;
          opus.push({
            oid: a.oid || a.cvid,
            sub_kind: "opus",
            title: a.title,
            readlist: { id: item.id, title: item.title, order: a.order },
            dir: item._dir || "",
            template: item._tpl || "",
          });
        });
      } else if (item.kind === "videolist") {
        (item.works || []).forEach((w, idx) => {
          if (!item._works || !item._works.has(w.ident)) return;
          const key = w.ident + ":auto";
          if (seen.has(key)) return;
          seen.add(key);
          const isYt = item.source === "youtube";
          // YouTube 频道页不是播放列表：不把频道名当合集名，避免整批下载落进「以频道页命名的文件夹」
          const keepSeason = !isYt || item.list_kind === "playlist";
          videos.push({
            bvid: w.ident,
            video_title: w.title,
            author: item.uploader || item.author || "",
            author_uid: item.mid,
            season_id: keepSeason ? item.id : "",
            season_title: keepSeason ? item.title : "",
            // YouTube 播放列表按列表顺序编号；B 站合集保持原来的行为（不填序号）
            season_order: keepSeason && isYt ? idx + 1 : 0,
            source: item.source || "",
            cover: w.cover || "",
            duration: w.duration || 0,
            web_url: isYt ? `https://www.youtube.com/watch?v=${w.ident}` : "",
            dir: item._dir || "",
            template: item._tpl || "",
          });
        });
      }
    });
    return { videos, opus };
  }

  function updatePickSummary() {
    const { videos, opus } = collectDownloads();
    const total = videos.length + opus.length;
    $("pickSummary").textContent = `已选择 ${total} 项（视频 ${videos.length} 个分集 / 图文 ${opus.length} 个作品）`;
    $("startDownloadBtn").disabled = total === 0;
  }

  $("pickAllBtn").addEventListener("click", () => {
    state.parsed.forEach((item) => {
      if (!item.ok) return;
      if (item.kind === "video") {
        item.pages.forEach((p) => item._pages.add(p.index));
        if (item.season) item.season.episodes.forEach((ep) => item._eps.add(ep.index));
      } else if (item.kind === "opus") item._picked = true;
      else if (item.kind === "readlist") (item.articles || []).forEach((a) => item._arts.add(a.order));
      else if (item.kind === "videolist") (item.works || []).forEach((w) => item._works.add(w.ident));
    });
    renderParseResults();
  });

  $("pickNoneBtn").addEventListener("click", () => {
    state.parsed.forEach((item) => {
      if (!item.ok) return;
      if (item.kind === "video") {
        item._pages.clear();
        item._eps.clear();
      } else if (item.kind === "opus") item._picked = false;
      else if (item.kind === "readlist") item._arts.clear();
      else if (item.kind === "videolist") item._works.clear();
    });
    renderParseResults();
  });

  $("startDownloadBtn").addEventListener("click", async () => {
    const { videos, opus } = collectDownloads();
    if (!videos.length && !opus.length) {
      toast("还没有选择任何内容", "err");
      return;
    }
    const btn = $("startDownloadBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 创建任务…';
    try {
      const data = await api("/api/download", { method: "POST", body: { videos, opus } });
      toast(`已创建 ${data.count} 个下载任务`, "ok");
      switchPage("tasks");
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "开始下载";
    }
  });

  /* ------------------------------------------------ UP 主批量 */
  function parseMid(text) {
    text = (text || "").trim();
    const m = text.match(/(\d{1,12})/);
    return m ? m[1] : "";
  }

  $("spaceQ").addEventListener("input", () => {
    state.spaceQ = $("spaceQ").value.trim();
    refreshSpaceGrids();
  });

  $("spaceQAll").addEventListener("click", () => {
    ["video", "opus"].forEach((type) => {
      const set = type === "video" ? state.selectedVideos : state.selectedOpus;
      filteredWorks(type).forEach((w) => set.add(w.ident));
    });
    refreshSpaceGrids();
    toast(`已选中匹配作品：视频 ${state.selectedVideos.size} 个 / 图文 ${state.selectedOpus.size} 个`, "ok");
  });

  $("spaceQClear").addEventListener("click", () => {
    $("spaceQ").value = "";
    state.spaceQ = "";
    refreshSpaceGrids();
  });

  $("scanBtn").addEventListener("click", async () => {
    const mid = parseMid($("spaceInput").value);
    if (!mid) {
      toast("请输入 UP 主 UID 或空间链接", "err");
      return;
    }
    const tabs = [];
    if ($("scanVideo").checked) tabs.push("video");
    if ($("scanOpus").checked) tabs.push("opus");
    if (!tabs.length) {
      toast("请至少勾选视频或图文", "err");
      return;
    }
    const btn = $("scanBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 检索中…';
    state.selectedVideos.clear();
    state.selectedOpus.clear();
    $("videoPanel").style.display = "none";
    $("opusPanel").style.display = "none";
    try {
      const data = await api("/api/space/scan", { method: "POST", body: { mid, tabs } });
      state.scanJob = data.job;
      $("scanStatus").innerHTML = `<div class="card"><b>开始检索 UID ${esc(mid)}…</b><div class="muted" id="scanMsg">准备中</div></div>`;
      startScanPolling();
    } catch (err) {
      toast(err.message, "err");
      btn.disabled = false;
      btn.textContent = "检索全部作品";
    }
  });

  function startScanPolling() {
    clearInterval(state.scanTimer);
    state.scanTimer = setInterval(async () => {
      if (!state.scanJob) return;
      try {
        const job = await api("/api/space/scan/" + state.scanJob);
        state.scan = job;
        const msg = $("scanMsg");
        if (msg) {
          msg.innerHTML = `${esc(job.message)}${job.note ? `<div style="color:var(--amber);margin-top:6px">${esc(job.note)}</div>` : ""}`;
        }
        if (job.status !== "running") {
          clearInterval(state.scanTimer);
          const btn = $("scanBtn");
          btn.disabled = false;
          btn.textContent = "检索全部作品";
          renderScanResults(job);
        }
      } catch (err) {
        clearInterval(state.scanTimer);
        toast(err.message, "err");
      }
    }, 1500);
  }

  function renderScanResults(job) {
    if (job.status === "error") {
      $("scanStatus").innerHTML = `<div class="card"><b style="color:var(--red)">检索失败</b><div class="muted">${esc(job.message)}</div></div>`;
      return;
    }
    const user = job.user || {};
    $("scanStatus").innerHTML = `<div class="card">
      <b>${esc(user.name || "UID " + job.mid)}</b>
      <div class="muted">视频 ${job.video_count} 个 · 图文 ${job.opus_count} 个${job.note ? " · " + esc(job.note) : ""}</div>
    </div>`;
    $("videoPanel").style.display = job.video_count ? "" : "none";
    $("opusPanel").style.display = job.opus_count ? "" : "none";
    refreshSpaceGrids();
  }

  // 标题关键词匹配：空格分隔多个词，要求全部命中（不区分大小写）
  function matchTitle(title, q) {
    const text = String(title || "").toLowerCase();
    const tokens = String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every((t) => text.includes(t));
  }

  function filteredWorks(type) {
    const works = (state.scan && (type === "video" ? state.scan.video : state.scan.opus)) || [];
    const q = state.spaceQ || "";
    return q ? works.filter((w) => matchTitle(w.title, q)) : works;
  }

  function refreshSpaceGrids() {
    if (!state.scan) return;
    ["video", "opus"].forEach((type) => {
      const grid = $(type === "video" ? "videoGrid" : "opusGrid");
      const list = filteredWorks(type);
      grid.innerHTML = list.length
        ? list.map((work) => workCard(work, type)).join("")
        : `<div class="muted" style="padding:16px">没有标题匹配的作品</div>`;
      // 恢复已选态
      const set = type === "video" ? state.selectedVideos : state.selectedOpus;
      grid.querySelectorAll(".work").forEach((node) => node.classList.toggle("on", set.has(node.dataset.ident)));
    });
    const q = state.spaceQ || "";
    $("spaceQInfo").textContent = q
      ? `匹配：视频 ${filteredWorks("video").length} 个 / 图文 ${filteredWorks("opus").length} 个`
      : "";
    updateSpaceCounts();
  }

  function workCard(work, type) {
    const img = work.cover
      ? `<img class="thumb" loading="lazy" src="${esc(work.cover)}" referrerpolicy="no-referrer" alt="">`
      : '<div class="thumb"></div>';
    const meta = [fmtDur(work.duration), work.pubdate ? new Date(work.pubdate * 1000).toLocaleDateString() : ""]
      .filter(Boolean)
      .join(" · ");
    return `<div class="work" data-type="${type}" data-ident="${esc(work.ident)}" title="${esc(work.title)}">
      ${img}<span class="tick">✓</span>
      <div class="t">${esc(work.title)}<div class="muted" style="font-size:11px">${esc(meta)}</div></div>
    </div>`;
  }

  document.addEventListener("click", (event) => {
    const work = event.target.closest(".work");
    if (!work) return;
    const type = work.dataset.type;
    const set = type === "video" ? state.selectedVideos : state.selectedOpus;
    const ident = work.dataset.ident;
    if (set.has(ident)) set.delete(ident);
    else set.add(ident);
    work.classList.toggle("on", set.has(ident));
    updateSpaceCounts();
  });

  function updateSpaceCounts() {
    if (!state.scan) return;
    const q = state.spaceQ || "";
    const vAll = state.scan.video_count || 0;
    const oAll = state.scan.opus_count || 0;
    const vShow = filteredWorks("video").length;
    const oShow = filteredWorks("opus").length;
    $("videoCount").textContent = q
      ? `共 ${vAll} 个，匹配 ${vShow} 个，已选 ${state.selectedVideos.size} 个`
      : `共 ${vAll} 个，已选 ${state.selectedVideos.size} 个`;
    $("opusCount").textContent = q
      ? `共 ${oAll} 个，匹配 ${oShow} 个，已选 ${state.selectedOpus.size} 个`
      : `共 ${oAll} 个，已选 ${state.selectedOpus.size} 个`;
  }

  document.querySelectorAll("[data-selall], [data-selnone]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.selall || btn.dataset.selnone;
      const all = !!btn.dataset.selall;
      const set = type === "video" ? state.selectedVideos : state.selectedOpus;
      set.clear();
      if (all) {
        filteredWorks(type).forEach((w) => set.add(w.ident));
      }
      document.querySelectorAll(`.work[data-type="${type}"]`).forEach((node) => {
        node.classList.toggle("on", set.has(node.dataset.ident));
      });
      updateSpaceCounts();
    });
  });

  document.querySelectorAll("[data-download]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const type = btn.dataset.download;
      if (type === "video") {
        const idents = Array.from(state.selectedVideos);
        if (!idents.length) {
          toast("请先勾选要下载的视频", "err");
          return;
        }
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> 建立任务…';
        try {
          const data = await api("/api/download", { method: "POST", body: { video_idents: idents, all_pages: true } });
          toast(`已创建 ${data.count} 个视频分集任务${data.failed.length ? `，失败 ${data.failed.length} 个` : ""}`, data.failed.length ? "err" : "ok");
          switchPage("tasks");
          pollTasks();
        } catch (err) {
          toast(err.message, "err");
        } finally {
          btn.disabled = false;
          btn.textContent = "下载选中视频";
        }
      } else {
        const works = (state.scan && state.scan.opus) || [];
        const opus = works
          .filter((w) => state.selectedOpus.has(w.ident))
          .map((w) => ({ oid: w.ident, sub_kind: "opus", title: w.title }));
        if (!opus.length) {
          toast("请先勾选要下载的图文作品", "err");
          return;
        }
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> 建立任务…';
        try {
          const data = await api("/api/download", { method: "POST", body: { opus } });
          toast(`已创建 ${data.count} 个图文任务`, "ok");
          switchPage("tasks");
          pollTasks();
        } catch (err) {
          toast(err.message, "err");
        } finally {
          btn.disabled = false;
          btn.textContent = "下载选中图文";
        }
      }
    });
  });

  /* ------------------------------------------------ 任务 */
  async function pollTasks() {
    try {
      state.tasks = await api("/api/tasks");
      renderTasks();
      renderMiniTasks();
    } catch (err) {
      /* 忽略轮询错误 */
    }
  }

  // 顶部悬浮的全局进度：页面刷新后服务端任务还在，这里会立刻重新显示
  function renderMiniTasks() {
    const box = $("miniTasks");
    if (!box) return;
    const data = state.tasks || {};
    const tasks = data.tasks || [];
    const stats = data.stats || {};
    const active = tasks.filter((t) => t.status === "running" || t.status === "pending");
    if (!active.length || state.miniHidden) { box.classList.remove("on"); box.style.display = "none"; return; }
    const running = tasks.filter((t) => t.status === "running").length;
    const pending = stats.pending || 0;
    const totalBytes = active.reduce((a, t) => a + (t.total_bytes || 0), 0);
    const doneBytes = active.reduce((a, t) => a + (t.done_bytes || 0), 0);
    const pct = totalBytes > 0 ? Math.min(100, Math.round((doneBytes * 100) / totalBytes)) : Math.round(((active[0].progress || 0) * 100));
    $("mtText").textContent = `${running ? "正在下载 " + running + " 个" : "等待中 " + pending + " 个"}${pending && running ? " · 排队 " + pending : ""} · ${pct}%`;
    $("mtBar").style.width = pct + "%";
    box.classList.add("on");
    box.style.display = "flex";
  }

  function renderTasks() {
    const data = state.tasks || { tasks: [], stats: {} };
    const stats = data.stats || {};
    const order = [
      ["running", "进行中"],
      ["pending", "等待中"],
      ["paused", "已暂停"],
      ["done", "已完成"],
      ["skipped", "已跳过"],
      ["error", "失败"],
      ["canceled", "已取消"],
    ];
    $("statRow").innerHTML = order
      .map(([key, label]) => `<div class="stat"><b>${stats[key] || 0}</b><span>${label}</span></div>`)
      .join("");

    if (data.cooldown > 1) {
      $("cooldownChip").style.display = "";
      $("cooldownChip").className = "chip warn";
      $("cooldownChip").textContent = `风控冷却中 ${Math.ceil(data.cooldown)}s`;
    } else {
      $("cooldownChip").style.display = "none";
    }
    if (data.paused_note && data.paused_note !== state._pausedNote) {
      state._pausedNote = data.paused_note;
      toast(data.paused_note, "err");
    }
    if (!data.paused_note) state._pausedNote = "";

    const tasks = data.tasks || [];
    if (!tasks.length) {
      state.selectedTasks.clear();
      $("taskList").innerHTML = '<div class="empty">还没有下载任务</div>';
      renderTaskTools();
      return;
    }
    $("taskList").innerHTML = tasks
      .slice()
      .reverse()
      .map((task) => {
        const pct = Math.round((task.progress || 0) * 100);
        const cls = task.status === "done" ? "done" : task.status === "error" ? "error" : task.status === "skipped" ? "skip" : "";
        const sub = task.error
          ? `<span class="err">${esc(task.error)}</span>`
          : `${esc(task.subtitle)}${task.quality ? " · " + esc(task.quality) : ""}${task.path ? " · " + esc(task.path) : ""}`;
        const statusText = {
          pending: "排队中",
          running: `${pct}%${task.speed ? " · " + fmtSpeed(task.speed) : ""}`,
          paused: "已暂停",
          done: `${fmtBytes(task.done_bytes)}`,
          skipped: "已存在",
          error: "失败",
          canceled: "已取消",
        }[task.status] || task.status;
        const active = task.status === "pending" || task.status === "running";
        const picked = state.selectedTasks.has(task.id);
        return `<div class="task ${task.status === "paused" ? "paused" : ""} ${picked ? "sel" : ""}">
          <label class="tick" title="选中这个任务">
            <input type="checkbox" data-select="${task.id}" ${picked ? "checked" : ""} />
          </label>
          <div class="kind">${task.kind === "video" ? "视频" : task.kind === "youtube" ? "YouTube" : "图文"}</div>
          <div class="info">
            <div class="t1">${esc(task.title)}</div>
            <div class="t2 ${task.error ? "err" : ""}">${sub}</div>
          </div>
          <div class="pct">
            <div class="bar"><i class="${cls}" style="width:${pct}%"></i></div>
            <div class="num"><span>${esc(statusText)}</span><span>${task.total_items > 1 ? `${task.done_items}/${task.total_items}` : ""}</span></div>
          </div>
          <div class="ops">
            ${active ? `<button class="btn sm ghost" data-pause="${task.id}">暂停</button>` : ""}
            ${task.status === "paused" ? `<button class="btn sm ghost" data-resume="${task.id}">开始</button>` : ""}
            ${active || task.status === "paused" ? `<button class="btn sm ghost" data-cancel="${task.id}">取消</button>` : ""}
            ${task.status === "error" ? `<button class="btn sm primary" data-retry="${task.id}">重试</button>` : ""}
          </div>
        </div>`;
      })
      .join("");
    renderTaskTools();
  }

  // 多选状态：只保留队列里还存在的任务，避免清除/删除后残留幽灵勾选
  function prunedSelection() {
    const tasks = (state.tasks && state.tasks.tasks) || [];
    const alive = new Set(tasks.map((t) => t.id));
    for (const id of [...state.selectedTasks]) {
      if (!alive.has(id)) state.selectedTasks.delete(id);
    }
    return { tasks, picked: tasks.filter((t) => state.selectedTasks.has(t.id)) };
  }

  function renderTaskTools() {
    const { tasks, picked } = prunedSelection();
    $("selCount").textContent = `已选 ${picked.length} 项`;
    const all = $("selectAllTasks");
    const allChecked = tasks.length > 0 && picked.length === tasks.length;
    all.checked = allChecked;
    all.disabled = !tasks.length;
    all.indeterminate = picked.length > 0 && !allChecked;
    $("pauseSelBtn").disabled = !picked.some((t) => t.status === "pending" || t.status === "running");
    $("resumeSelBtn").disabled = !picked.some((t) => t.status === "paused");
    $("cancelSelBtn").disabled = !picked.length;
    $("taskTools").style.display = tasks.length ? "" : "none";
    $("pauseAllBtn").disabled = !tasks.some((t) => t.status === "pending" || t.status === "running");
    $("resumeAllBtn").disabled = !tasks.some((t) => t.status === "paused");
  }

  $("taskList").addEventListener("change", (event) => {
    const box = event.target.closest("[data-select]");
    if (!box) return;
    const id = box.dataset.select;
    if (box.checked) state.selectedTasks.add(id);
    else state.selectedTasks.delete(id);
    const row = box.closest(".task");
    if (row) row.classList.toggle("sel", box.checked);
    renderTaskTools();
  });

  $("selectAllTasks").addEventListener("change", (event) => {
    const tasks = (state.tasks && state.tasks.tasks) || [];
    state.selectedTasks.clear();
    if (event.target.checked) tasks.forEach((t) => state.selectedTasks.add(t.id));
    renderTasks();
  });

  $("taskList").addEventListener("click", async (event) => {
    const retry = event.target.closest("[data-retry]");
    if (retry) {
      try {
        const r = await api("/api/tasks/retry", { method: "POST", body: { id: retry.dataset.retry } });
        toast(r.retried ? "已重新排队，正在重试" : "这个任务当前不能重试", r.retried ? "ok" : "err");
        pollTasks();
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }
    const pause = event.target.closest("[data-pause]");
    if (pause) {
      try {
        await api("/api/tasks/pause", { method: "POST", body: { id: pause.dataset.pause } });
        pollTasks();
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }
    const resume = event.target.closest("[data-resume]");
    if (resume) {
      try {
        await api("/api/tasks/resume", { method: "POST", body: { id: resume.dataset.resume } });
        pollTasks();
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }
    const btn = event.target.closest("[data-cancel]");
    if (!btn) return;
    try {
      await api("/api/tasks/cancel", { method: "POST", body: { id: btn.dataset.cancel } });
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("pauseAllBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/tasks/pause", { method: "POST", body: { all: true } });
      const n = (r && r.paused) || 0;
      toast(n ? `已暂停 ${n} 个任务` : "没有可暂停的任务", n ? "ok" : "");
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("resumeAllBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/tasks/resume", { method: "POST", body: { all: true } });
      const n = (r && r.resumed) || 0;
      toast(n ? `已继续 ${n} 个任务` : "没有已暂停的任务", n ? "ok" : "");
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  async function batchTaskAction(path, label) {
    const picked = [...state.selectedTasks];
    if (!picked.length) {
      toast("先勾选要操作的任务", "err");
      return;
    }
    try {
      const r = await api(path, { method: "POST", body: { ids: picked } });
      const n = (r && (r.paused ?? r.resumed ?? r.count)) || 0;
      toast(n ? `已${label} ${n} 个任务` : `选中的任务都不支持${label}`, n ? "ok" : "err");
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    }
  }

  $("pauseSelBtn").addEventListener("click", () => batchTaskAction("/api/tasks/pause", "暂停"));
  $("resumeSelBtn").addEventListener("click", () => batchTaskAction("/api/tasks/resume", "继续"));
  $("cancelSelBtn").addEventListener("click", () => batchTaskAction("/api/tasks/cancel", "取消"));
  renderTaskTools();

  $("cancelAllBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/tasks/cancel", { method: "POST", body: { all: true } });
      const n = (r && r.removed) || 0;
      toast(n ? `已取消并移除 ${n} 个任务` : "任务队列已经是空的", "ok");
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("retryFailedBtn").addEventListener("click", async () => {
    try {
      const r = await api("/api/tasks/retry", { method: "POST", body: {} });
      const n = (r && r.retried) || 0;
      toast(n ? `已重新排队 ${n} 个失败任务` : "没有失败的任务");
      pollTasks();
    } catch (e) {
      toast("重试失败：" + e.message, 3000);
    }
  });

  $("clearTasksBtn").addEventListener("click", async () => {
    try {
      await api("/api/tasks/clear", { method: "POST", body: {} });
      pollTasks();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  /* ------------------------------------------------ 登录 */
  async function startQr() {
    try {
      const data = await api("/api/login/qr/start", { method: "POST", body: {} });
      state.qrKey = data.key;
      const svg = await api("/api/qr?url=" + encodeURIComponent(data.url));
      $("qrBox").innerHTML = svg.svg;
      $("qrStatus").textContent = "请使用 B站 手机客户端扫码并在手机上确认登录";
      clearInterval(state.qrTimer);
      state.qrTimer = setInterval(pollQr, 2000);
    } catch (err) {
      toast(err.message, "err");
    }
  }

  async function pollQr() {
    if (!state.qrKey) return;
    try {
      const data = await api("/api/login/qr/poll", { method: "POST", body: { key: state.qrKey } });
      $("qrStatus").textContent = data.status_text || "";
      if (data.code === 0) {
        clearInterval(state.qrTimer);
        toast("登录成功", "ok");
        $("qrBox").innerHTML = '<div class="placeholder" style="color:#3fb950">登录成功</div>';
        loadStatus();
      } else if (data.code === 86038) {
        clearInterval(state.qrTimer);
        $("qrBox").innerHTML = '<div class="placeholder">二维码已失效，请刷新</div>';
      }
    } catch (err) {
      clearInterval(state.qrTimer);
      toast(err.message, "err");
    }
  }

  $("qrBtn").addEventListener("click", startQr);
  $("qrRefreshBtn").addEventListener("click", startQr);

  $("cookieLoginBtn").addEventListener("click", async () => {
    const cookie = $("cookieInput").value.trim();
    if (!cookie) {
      toast("请先粘贴 Cookie", "err");
      return;
    }
    const btn = $("cookieLoginBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 校验中…';
    try {
      const user = await api("/api/login/cookie", { method: "POST", body: { cookie } });
      toast(`登录成功：${user.name || user.mid}`, "ok");
      $("cookieInput").value = "";
      loadStatus();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "使用 Cookie 登录";
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    try {
      await api("/api/logout", { method: "POST", body: {} });
      toast("已退出登录", "ok");
      loadStatus();
    } catch (err) {
      toast(err.message, "err");
    }
  });


  /* ------------------------------------------------ 定时追更 */
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtWait(sec) {
    if (sec == null || sec < 0) return "未启用";
    if (sec < 60) return `${Math.round(sec)} 秒后检查`;
    if (sec < 3600) return `${Math.round(sec / 60)} 分钟后检查`;
    return `${(sec / 3600).toFixed(1)} 小时后检查`;
  }

  async function loadSubs() {
    try {
      const data = await api("/api/subs");
      state.subs = data;
      // 正在卡片里编辑（目录 / 模板 / 过滤词）时不要重绘，否则每 5 秒会打断输入
      const ae = document.activeElement;
      if (ae && ae.closest && ae.closest("#subList")) return;
      renderSubs();
    } catch (err) {
      /* 轮询错误忽略 */
    }
  }

  const SUB_FILTERS = [
    ["all", "全部"],
    ["up", "UP 主投稿"],
    ["fav", "收藏夹"],
    ["bangumi", "番剧 / 影视"],
    ["toview", "稍后再看"],
    ["lists", "合集"],
    ["readlist", "文集"],
    ["youtube", "YouTube"],
    ["douyin", "抖音作者"],
    ["xhs", "小红书作者"],
  ];

  function subKind(sub) {
    return (sub && sub.kind) || "up";
  }

  function visibleSubs() {
    const all = (state.subs && state.subs.subs) || [];
    return state.subFilter === "all" ? all : all.filter((s) => subKind(s) === state.subFilter);
  }

  function renderSubFilters() {
    const row = $("subFilterRow");
    if (!row) return;
    row.innerHTML = SUB_FILTERS.map(
      ([key, label]) =>
        `<button class="chip ${state.subFilter === key ? "on" : ""}" data-subfilter="${key}">${label}</button>`
    ).join("");
  }

  function updateSubSelUI() {
    if (!state.subs) return;
    const allIds = new Set(((state.subs.subs) || []).map((s) => s.id));
    [...state.subSel].forEach((id) => {
      if (!allIds.has(id)) state.subSel.delete(id);
    });
    const vis = visibleSubs();
    const selAll = $("subSelAll");
    if (selAll) {
      selAll.checked = vis.length > 0 && vis.every((s) => state.subSel.has(s.id));
      selAll.indeterminate = state.subSel.size > 0 && !selAll.checked;
    }
    const count = $("subSelCount");
    if (count) count.textContent = `已选 ${state.subSel.size} 个`;
  }

  function subVarChips(list, targetId) {
    return (list || [])
      .map(
        (v) =>
          `<span class="var" data-var="${esc(v.var)}" data-target="${esc(targetId)}">${esc(v.var)}<em>${esc(v.desc)}</em></span>`
      )
      .join("");
  }

  function renameBlock(sub, k, v, o) {
    const sid = esc(sub.id);
    const rows = [];
    if (v.enabled) {
      rows.push(`<div class="field" style="margin-top:6px">
        <label>视频重命名规则<span class="muted">（留空=跟随全局）</span></label>
        <textarea id="subvt-${sid}" data-act="vtpl" rows="2" placeholder="${esc(state.settings.video_template || "")}">${esc(v.template || "")}</textarea>
        <div class="var-list">${subVarChips(state.vars.video, "subvt-" + sub.id)}</div>
      </div>`);
    }
    if (o.enabled) {
      const vars = k === "readlist"
        ? [...(state.vars.readlist || []), ...(state.vars.opus || [])]
        : (state.vars.opus || []);
      const placeholder = k === "readlist"
        ? (state.settings.readlist_template || "")
        : (state.settings.opus_template || "");
      rows.push(`<div class="field" style="margin-top:6px">
        <label>图文重命名规则<span class="muted">（留空=跟随全局）</span></label>
        <textarea id="subot-${sid}" data-act="otpl" rows="2" placeholder="${esc(placeholder)}">${esc(o.template || "")}</textarea>
        <div class="var-list">${subVarChips(vars, "subot-" + sub.id)}</div>
      </div>`);
    }
    if (!rows.length) return "";
    const files = (v.files_count || 0) + (o.files_count || 0);
    return `<details style="margin-top:8px">
      <summary class="muted">重命名规则（点下面的变量插入，留空=跟随全局）${files ? ` · 已记录 ${files} 个已下载文件，保存后自动改名` : ""}</summary>
      ${rows.join("")}
    </details>`;
  }

  function renderSubs() {
    const data = state.subs;
    if (!data) return;
    const cfg = data.config || {};
    const on = !!cfg.enabled;
    $("subsStateChip").textContent = on ? "自动扫描：已开启" : "自动扫描：已关闭";
    $("subsStateChip").className = "chip " + (on ? "ok" : "warn");
    // 只统计「真的会扫描」的订阅：启用但视频/图文都关掉的不算
    const activeSubs = (data.subs || []).filter(
      (s) => s.enabled && (((s.video || {}).enabled || (s.opus || {}).enabled))
    ).length;
    $("subsNextChip").textContent = !on
      ? "所有订阅暂停"
      : activeSubs
        ? fmtWait(data.next_run)
        : "没有启用的订阅";

    const setVal = (id, value) => {
      const node = $(id);
      if (node && document.activeElement !== node) node.value = value;
    };
    if (document.activeElement !== $("subsEnabled")) $("subsEnabled").checked = on;
    setVal("subsInterval", Math.round((cfg.interval || 600) / 60));
    setVal("subsMaxNew", cfg.max_new || 20);
    setVal("subsMinGap", cfg.min_gap || 90);

    const all = data.subs || [];
    const toolbar = $("subToolbar");
    if (toolbar) toolbar.style.display = all.length ? "" : "none";
    renderSubFilters();
    if (!all.length) {
      $("subList").innerHTML =
        '<div class="card"><div class="empty">还没有订阅。上面填一个 UP 主 UID / 合集链接，点「添加订阅」开始。</div></div>';
      updateSubSelUI();
      return;
    }
    const subs = visibleSubs();
    if (!subs.length) {
      $("subList").innerHTML =
        '<div class="card"><div class="empty">当前类型下还没有订阅，点上面的「全部」看看其它的。</div></div>';
      updateSubSelUI();
      return;
    }
    $("subList").innerHTML = subs
      .map((sub) => {
        const k = subKind(sub);
        const v = sub.video || {};
        const o = sub.opus || {};
        const chip = (ch, label) =>
          `<span class="chip ${ch.enabled ? "ok" : ""}">${ch.enabled ? label : label + "（关）"}</span>`;
        const line = (ch, kindLabel) => {
          const since = ch.since
            ? `起点「${esc(ch.since_title || ch.since)}」（含）`
            : SOCIAL_KINDS[k]
              ? ""
              : k === "lists"
              ? "起点未设（会下载合集里的全部视频）"
              : k === "readlist"
                ? "起点未设（首次只建基线，之后只下新文章）"
                : "起点未设（首次只建基线）";
          const last = ch.last_message ? ` · ${esc(ch.last_message)}` : "";
          const err = ch.last_error ? ` · <span style="color:var(--red)">${esc(ch.last_error)}</span>` : "";
          const head = since ? `${kindLabel}：${since} · ` : "";
          return `<div class="sub-line">${head}目录 <code>${esc(ch.dir || "（全局）")}</code>${last}${err}</div>`;
        };
        return `<div class="card sub-card" data-id="${esc(sub.id)}">
          <div class="rowline">
            <div class="row" style="gap:12px;align-items:center">
              ${sub.face ? `<img class="avatar" src="${esc(sub.face)}" referrerpolicy="no-referrer" alt="">` : ""}
              <div>
                <b>${esc(sub.name || "UID " + sub.mid)}</b>
                <div class="muted">${esc(KIND_LABEL[k] || "UP 主投稿")}${k !== "up" && sub.target ? " " + esc(sub.target) : " · UID " + esc(sub.mid)} · 间隔 ${Math.round((sub.interval_effective || 0) / 60)} 分钟 · 上次检查 ${fmtTime(sub.last_check)}</div>
              </div>
            </div>
            <div class="row" style="flex-wrap:wrap;gap:6px">
              <label class="muted"><input type="checkbox" data-act="sel" ${state.subSel.has(sub.id) ? "checked" : ""} /> 选择</label>
              <label class="muted"><input type="checkbox" data-act="toggle" ${sub.enabled ? "checked" : ""} /> 启用</label>
              <button class="btn sm ghost" data-act="check">立即检查</button>
              ${k !== "readlist" && !SOCIAL_KINDS[k] ? `<button class="btn sm ghost" data-act="pick" data-kind="video">视频起点</button>` : ""}
              ${(k === "up" || k === "readlist" || SOCIAL_KINDS[k]) && !SOCIAL_KINDS[k] ? `<button class="btn sm ghost" data-act="pick" data-kind="opus">图文起点</button>` : ""}
              ${SOCIAL_KINDS[k] ? `<span class="chip" title="服务端拿不到抖音/小红书作者作品列表，由油猴脚本打开作者主页时上报">浏览器上报</span>` : ""}
              <button class="btn sm ghost" data-act="del">删除</button>
            </div>
          </div>
          <div class="row" style="margin-top:8px;gap:8px">
            ${k === "up" || SOCIAL_KINDS[k]
              ? `<label class="muted" title="取消勾选＝暂停这个作者（UP主 / 抖音 / 小红书）的视频追更（已下载的文件不受影响，随时可再打开）"><input type="checkbox" data-act="von" ${v.enabled ? "checked" : ""}/> 追视频</label>
                 <label class="muted" title="勾选后开始追图文；第一次会先建立基线，只下载之后的新作品"><input type="checkbox" data-act="oon" ${o.enabled ? "checked" : ""}/> 追图文</label>
                 ${!v.enabled && !o.enabled ? `<span class="chip warn" title="视频和图文都关着，这个订阅不会被扫描">两项都关</span>` : ""}`
              : `${chip(v, "视频")}${o.enabled ? chip(o, "图文") : ""}`}
            <input type="text" data-act="vdir" value="${esc(v.dir || "")}" placeholder="视频目录（留空=全局）" style="flex:1;min-width:180px" />
            ${o.enabled ? `<input type="text" data-act="odir" value="${esc(o.dir || "")}" placeholder="图文目录（留空=全局）" style="flex:1;min-width:180px" />` : ""}
            <input type="number" data-act="interval" value="${Math.round((sub.interval || 0) / 60)}" min="0" max="10080" title="单独间隔（分钟，0=用默认）" style="width:110px" />
            <button class="btn sm primary" data-act="save">保存</button>
          </div>
          <div class="row" style="margin-top:8px;gap:8px">
            <input type="text" data-act="finclude" value="${esc((v.filters || {}).include || "")}" placeholder="只下标题含这些词（空格分隔，需全含）" style="flex:1;min-width:200px" />
            <input type="text" data-act="fexclude" value="${esc((v.filters || {}).exclude || "")}" placeholder="排除标题含这些词" style="flex:1;min-width:180px" />
            <input type="number" data-act="fmindur" value="${Number((v.filters || {}).min_dur || 0)}" placeholder="最短秒" title="视频最短时长（秒，0=不限）" style="width:110px" />
            <input type="number" data-act="fmaxdur" value="${Number((v.filters || {}).max_dur || 0)}" placeholder="最长秒" title="视频最长时长（秒，0=不限）" style="width:110px" />
          </div>
          ${renameBlock(sub, k, v, o)}
          ${SOCIAL_KINDS[k] ? line(v, "追更") : line(v, "视频")}
          ${!SOCIAL_KINDS[k] && o.enabled ? line(o, "图文") : ""}
        </div>`;
      })
      .join("");
    updateSubSelUI();
  }

  $("subsSaveCfg").addEventListener("click", async () => {
    try {
      await api("/api/subs/config", {
        method: "POST",
        body: {
          enabled: $("subsEnabled").checked,
          interval: Math.max(2, Number($("subsInterval").value) || 10) * 60,
          max_new: Math.max(1, Number($("subsMaxNew").value) || 20),
          min_gap: Math.max(30, Number($("subsMinGap").value) || 90),
        },
      });
      toast("自动追更设置已保存", "ok");
      loadSubs();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  const KIND_LABEL = { up: "UP 主投稿", fav: "收藏夹", bangumi: "番剧 / 影视", toview: "稍后再看", lists: "合集", readlist: "文集", youtube: "YouTube 频道", douyin: "抖音作者", xhs: "小红书作者" };
  const SOCIAL_KINDS = { douyin: "抖音", xhs: "小红书" };
  const SUBS_KIND_HINT = {
    up: "UP主 UID 或空间链接，例如 2 或 https://space.bilibili.com/2/upload/opus",
    fav: "收藏夹 media_id（收藏夹链接里的 fid=…），例如 123456",
    bangumi: "番剧 season_id 或链接，例如 ss28747 / https://www.bilibili.com/bangumi/play/ss28747",
    toview: "稍后再看不需要填，直接用当前登录账号的列表",
    lists: "完整合集链接，例如 https://space.bilibili.com/601598/lists/6413356",
    readlist: "文集链接或 ID，例如 https://www.bilibili.com/read/readlist/rl1099181",
    youtube: "频道链接、@名字或频道 ID，例如 https://www.youtube.com/@RickAstleyYT",
    douyin: "抖音作者主页链接，例如 https://www.douyin.com/user/MS4wLjABAAAA…（由油猴脚本上报作品）",
    xhs: "小红书作者主页链接，例如 https://www.xiaohongshu.com/user/profile/6603db30000000000d027c6b（由油猴脚本上报作品）",
  };
  $("subsKind").addEventListener("change", () => {
    const k = $("subsKind").value;
    const social = !!SOCIAL_KINDS[k];
    $("subsMid").placeholder = SUBS_KIND_HINT[k] || "";
    $("subsMid").disabled = k === "toview";
    if (k === "toview") $("subsMid").value = "";
    $("subsOpusOn").checked = k === "up" || k === "readlist" || social;
    $("subsOpusOn").disabled = k !== "up" && !social;
    $("subsVideoOn").checked = true;
    $("subsVideoOn").disabled = k !== "up" && !social;
  });

  $("subsAddBtn").addEventListener("click", async () => {
    const kind = $("subsKind").value || "up";
    const raw = $("subsMid").value.trim();
    let mid = "";
    let target = "";
    if (kind === "up") {
      mid = parseMid(raw);
      if (!mid) {
        toast("请填写 UP 主 UID 或空间链接", "err");
        return;
      }
    } else if (kind === "toview") {
      target = "";
    } else if (kind === "lists") {
      const m = raw.match(/space\.bilibili\.com\/(\d+)\/lists\/(\d+)/) || raw.match(/(\d{1,12})\/lists\/(\d{2,})/);
      if (!m) {
        toast("请粘贴完整合集链接：https://space.bilibili.com/<UID>/lists/<合集ID>", "err");
        return;
      }
      mid = m[1];
      target = m[2];
    } else if (kind === "youtube") {
      target = raw;
      if (!target) {
        toast("请填写 YouTube 频道链接或 @名字", "err");
        return;
      }
    } else if (kind === "douyin" || kind === "xhs") {
      const label = SOCIAL_KINDS[kind];
      const pattern = kind === "douyin"
        ? /\/user\/([A-Za-z0-9_\-]{20,})/
        : /\/user\/profile\/([0-9a-fA-F]{20,32})/;
      const m = raw.match(pattern);
      if (!m) {
        toast(kind === "douyin" ? "请粘贴抖音作者主页链接，例如 https://www.douyin.com/user/MS4wLjABAAAA…" : "请粘贴小红书作者主页链接，例如 https://www.xiaohongshu.com/user/profile/…", "err");
        return;
      }
      target = m[1];
    } else if (kind === "readlist") {
      const m = raw.match(/(?:readlist\/)?(rl\d{3,})/i);
      if (!m) {
        toast("请粘贴文集链接，例如 https://www.bilibili.com/read/readlist/rl1099181", "err");
        return;
      }
      target = m[1].toLowerCase();
    } else if (kind === "bangumi") {
      const m = raw.match(/\/play\/(ep|ss)(\d+)/i) || raw.match(/^(ep|ss)(\d+)$/i);
      if (m) target = m[1].toLowerCase() === "ep" ? "ep" + m[2] : m[2];
      else target = (raw.match(/\d{2,}/) || [""])[0];
      if (!target) {
        toast("请填写番剧 season_id / ep_id 或链接", "err");
        return;
      }
    } else {
      target = (raw.match(/\d{2,}/) || [""])[0];
      if (!target) {
        toast("请填写收藏夹 media_id", "err");
        return;
      }
    }
    if (kind === "up" && !$("subsVideoOn").checked && !$("subsOpusOn").checked) {
      toast("至少勾选「追视频」或「追图文」中的一个（之后也能在订阅卡片里随时改）", "err");
      return;
    }
    const btn = $("subsAddBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span> 添加中…';
    try {
      const body = {
        kind,
        target,
        mid,
        video: {
          enabled: kind === "up" || SOCIAL_KINDS[kind] ? $("subsVideoOn").checked : kind !== "readlist",
          dir: $("subsVideoDir").value.trim(),
          template: $("subsVideoTpl").value.trim(),
        },
        opus: {
          enabled: kind === "up" || SOCIAL_KINDS[kind] ? $("subsOpusOn").checked : kind === "readlist",
          dir: $("subsOpusDir").value.trim(),
          template: $("subsOpusTpl").value.trim(),
        },
        interval: Math.max(0, Number($("subsOwnInterval").value) || 0) * 60,
      };
      await api("/api/subs", { method: "POST", body });
      toast(
        SOCIAL_KINDS[kind]
          ? `${SOCIAL_KINDS[kind]}订阅已添加：服务端拿不到作者作品列表，打开作者主页时油猴脚本会自动上报；首次上报只建基线，之后新作品会自动下载`
          : kind === "youtube"
          ? "YouTube 频道订阅已添加：首次扫描只建基线，之后新上传的视频会自动下载"
          : kind === "lists"
          ? "合集订阅已添加：扫描时会下载合集内全部视频（每个视频的全部分P）"
          : kind === "readlist"
            ? "文集订阅已添加：首次扫描只建基线，之后文集里新增的图文会自动下载"
            : "订阅已添加，记得给它设一个起点作品",
        "ok"
      );
      $("subsMid").value = "";
      loadSubs();
    } catch (err) {
      toast(err.message, "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "添加订阅";
    }
  });

  $("subFilterRow").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-subfilter]");
    if (!btn) return;
    state.subFilter = btn.dataset.subfilter;
    renderSubs();
  });

  $("subSelAll").addEventListener("change", () => {
    const vis = visibleSubs();
    if ($("subSelAll").checked) vis.forEach((s) => state.subSel.add(s.id));
    else vis.forEach((s) => state.subSel.delete(s.id));
    renderSubs();
  });

  async function batchSubs(action) {
    const ids = [...state.subSel];
    if (!ids.length) return toast("先在卡片上勾选订阅", "err");
    if (action === "delete" && !confirm(`删除选中的 ${ids.length} 个订阅？已下载的文件不会删除。`)) return;
    try {
      const data = await api("/api/subs/batch", { method: "POST", body: { action, ids } });
      if (data.state) state.subs = data.state;
      state.subSel.clear();
      const word = action === "delete" ? "删除" : action === "enable" ? "开启" : "关闭";
      toast(`已批量${word} ${data.count || 0} 个订阅`, "ok");
      renderSubs();
    } catch (err) {
      toast(err.message, "err");
    }
  }
  $("subBatchEnable").addEventListener("click", () => batchSubs("enable"));
  $("subBatchDisable").addEventListener("click", () => batchSubs("disable"));
  $("subBatchDelete").addEventListener("click", () => batchSubs("delete"));

  async function saveSub(sub, patch) {
    const v = sub.video || {};
    const o = sub.opus || {};
    const body = {
      id: sub.id,
      mid: sub.mid,
      enabled: patch.enabled != null ? patch.enabled : sub.enabled,
      interval: patch.interval != null ? patch.interval : sub.interval,
      video: { enabled: v.enabled, dir: patch.vdir != null ? patch.vdir : v.dir, ...(patch.video || {}) },
      opus: { enabled: o.enabled, dir: patch.odir != null ? patch.odir : o.dir, ...(patch.opus || {}) },
    };
    const data = await api("/api/subs", { method: "POST", body });
    state.subs = data.state;
    renderSubs();
    return data.sub;
  }

  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("#subList [data-act], #subPick [data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "pick-cancel") {
      state.subPick = null;
      $("subPick").innerHTML = "";
      return;
    }
    if (act === "pick-work") {
      const ctx = state.subPick;
      if (!ctx) return;
      const sub = (state.subs.subs || []).find((s) => s.id === ctx.sid);
      if (!sub) return;
      const work = ctx.works.find((w) => w.ident === btn.dataset.ident);
      if (!work) return;
      const patch = {};
      patch[ctx.kind] = {
        since: work.ident,
        since_title: work.title || work.ident,
        since_time: work.pubdate || 0,
      };
      try {
        await saveSub(sub, patch);
        toast(`起点已设为「${work.title || work.ident}」，从它开始（含它本身）往后自动下载`, "ok");
        state.subPick = null;
        $("subPick").innerHTML = "";
      } catch (err) {
        toast(err.message, "err");
      }
      return;
    }
    const card = btn.closest(".sub-card");
    if (!card) return;
    const sub = (state.subs.subs || []).find((s) => s.id === card.dataset.id);
    if (!sub) return;
    if (act === "sel") {
      if (btn.checked) state.subSel.add(sub.id);
      else state.subSel.delete(sub.id);
      updateSubSelUI();
      return;
    }
    try {
      if (act === "check") {
        btn.disabled = true;
        btn.innerHTML = '<span class="spin"></span> 检查中…';
        const data = await api("/api/subs/check", { method: "POST", body: { id: sub.id } });
        const r = data.result || {};
        toast(`检查完成：视频新增 ${r.video || 0} 个，图文新增 ${r.opus || 0} 个`, "ok");
        await loadSubs();
      } else if (act === "toggle") {
        await saveSub(sub, { enabled: btn.checked });
        toast(btn.checked ? "已启用该订阅" : "已暂停该订阅", "ok");
      } else if (act === "von" || act === "oon") {
        // 频道级开关：随时加开 / 关闭「追视频」「追图文」，不用删了重建
        const which = act === "von" ? "video" : "opus";
        const on = !!btn.checked;
        const patch = {};
        patch[which] = { enabled: on };
        await saveSub(sub, patch);
        const ch = sub[which] || {};
        if (which === "opus" && on && !(ch.seen || []).length && !ch.since) {
          toast("已开启图文追更：下次检查会先建立基线，之后只下载新图文", "ok");
        } else {
          toast(`${which === "video" ? "视频" : "图文"}追更已${on ? "开启" : "关闭"}`, "ok");
        }
      } else if (act === "del") {
        if (!confirm(`删除订阅「${sub.name || sub.mid}」？已下载的文件不会删除。`)) return;
        await api("/api/subs/delete", { method: "POST", body: { id: sub.id } });
        toast("订阅已删除", "ok");
        loadSubs();
      } else if (act === "save") {
        const vdir = card.querySelector('[data-act="vdir"]').value.trim();
        const odirNode = card.querySelector('[data-act="odir"]');
        const odir = odirNode ? odirNode.value.trim() : "";
        const vtplNode = card.querySelector('[data-act="vtpl"]');
        const otplNode = card.querySelector('[data-act="otpl"]');
        const mins = Math.max(0, Number(card.querySelector('[data-act="interval"]').value) || 0);
        const filters = {
          include: card.querySelector('[data-act="finclude"]').value.trim(),
          exclude: card.querySelector('[data-act="fexclude"]').value.trim(),
          min_dur: Math.max(0, Number(card.querySelector('[data-act="fmindur"]').value) || 0),
          max_dur: Math.max(0, Number(card.querySelector('[data-act="fmaxdur"]').value) || 0),
        };
        const v = sub.video || {};
        const o = sub.opus || {};
        const dirChanged = vdir !== (v.dir || "") || (odirNode && odir !== (o.dir || ""));
        const vtpl = vtplNode ? vtplNode.value.trim() : (v.template || "");
        const otpl = otplNode ? otplNode.value.trim() : (o.template || "");
        const tplChanged = (vtplNode && vtpl !== (v.template || "")) || (otplNode && otpl !== (o.template || ""));
        if (dirChanged && !confirm("保存后会把旧目录里的全部文件和文件夹移动到新目录（同名文件自动加 -1，不覆盖）。继续？")) {
          return;
        }
        const tracked = (v.files_count || 0) + (o.files_count || 0);
        if (tplChanged && tracked > 0 && !confirm(`保存后，已下载的 ${tracked} 个文件会按新规则改名；原文件已不存在的保持原样。继续？`)) {
          return;
        }
        await saveSub(sub, {
          vdir,
          odir,
          interval: mins * 60,
          video: { filters, ...(vtplNode ? { template: vtplNode.value.trim() } : {}) },
          opus: { filters, ...(otplNode ? { template: otplNode.value.trim() } : {}) },
        });
        toast(
          tplChanged && tracked > 0
            ? "规则已保存，正在按新规则重命名已下载文件"
            : dirChanged
              ? "订阅设置已保存，旧目录内容已迁移到新目录"
              : "订阅设置已保存",
          "ok"
        );
      } else if (act === "pick") {
        await pickStart(sub, btn.dataset.kind);
      }
    } catch (err) {
      toast(err.message, "err");
      if (act === "check") {
        btn.disabled = false;
        btn.textContent = "立即检查";
      }
      if (act === "von" || act === "oon") loadSubs();
    }
  });

  function showSubPick(sub, kind, works) {
    const label = kind === "video" ? "视频" : "图文";
    state.subPick = { sid: sub.id, kind, job: "static", works };
    const items = works
      .map(
        (w, i) => `<div class="work" data-act="pick-work" data-ident="${esc(w.ident)}" title="${esc(w.title)}">
          ${w.cover ? `<img class="thumb" loading="lazy" src="${esc(w.cover)}" referrerpolicy="no-referrer" alt="">` : '<div class="thumb"></div>'}
          <div class="t">#${i + 1} ${esc(w.title || w.ident)}<div class="muted" style="font-size:11px">${esc(w.ident)}</div></div>
        </div>`
      )
      .join("");
    $("subPick").innerHTML = `<div class="card">
      <div class="rowline">
        <div><b>选择${label}起点</b><div class="muted">点一部作品：从它开始（含它本身）往后自动下载，更早的作品不下载</div></div>
        <button class="btn sm ghost" data-act="pick-cancel">取消</button>
      </div>
      <div class="grid" style="max-height:420px;overflow:auto;margin-top:10px">${items || '<div class="empty">没有作品</div>'}</div>
    </div>`;
  }

  async function pickStart(sub, kind) {
    const sk = subKind(sub);
    if (sk !== "up" && sk !== "lists") {
      // 收藏夹 / 番剧 / 稍后再看 / 文集：走服务端只读列表，选起点
      const label = kind === "video" ? "视频" : "图文";
      $("subPick").innerHTML = `<div class="card"><b>正在读取「${esc(sub.name || sub.target)}」的${label}列表…</b>
        <div class="muted">只读一次列表，不会创建下载任务</div>
        <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-act="pick-cancel">取消</button></div></div>`;
      try {
        const data = await api("/api/subs/works", { method: "POST", body: { id: sub.id, kind } });
        const works = data.works || [];
        if (!works.length) {
          $("subPick").innerHTML = `<div class="card"><b style="color:var(--red)">没有取到作品</b>
            <div class="muted">${esc(data.note || "列表为空，或链接/登录状态有变化")}</div>
            <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-act="pick-cancel">关闭</button></div></div>`;
          state.subPick = null;
          return;
        }
        showSubPick(sub, kind, works);
      } catch (err) {
        $("subPick").innerHTML = `<div class="card"><b style="color:var(--red)">读取失败</b><div class="muted">${esc(err.message)}</div></div>`;
        state.subPick = null;
      }
      return;
    }
    if (sk === "lists") {
      $("subPick").innerHTML = `<div class="card"><b>正在读取合集「${esc(sub.name || sub.target)}」…</b>
        <div class="muted">只看一次合集列表，不会创建下载任务</div>
        <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-act="pick-cancel">取消</button></div></div>`;
      try {
        const data = await api("/api/parse", {
          method: "POST",
          body: { text: `https://space.bilibili.com/${sub.mid}/lists/${sub.target}` },
        });
        const item = (data.items || [])[0] || {};
        if (!item.ok) throw new Error(item.error || "合集读取失败");
        // 合集接口是旧→新；选起点时按新→旧展示，挑最近的作品更顺手
        showSubPick(sub, "video", (item.works || []).slice().reverse());
      } catch (err) {
        $("subPick").innerHTML = `<div class="card"><b style="color:var(--red)">合集读取失败</b><div class="muted">${esc(err.message)}</div></div>`;
        state.subPick = null;
      }
      return;
    }
    const label = kind === "video" ? "视频" : "图文";
    $("subPick").innerHTML = `<div class="card"><b>正在检索 ${esc(sub.name || sub.mid)} 的${label}作品…</b>
      <div class="muted" id="subPickMsg">这一步只在服务端翻页，带随机延迟</div>
      <div class="row" style="margin-top:10px"><button class="btn sm ghost" data-act="pick-cancel">取消</button></div></div>`;
    const data = await api("/api/space/scan", { method: "POST", body: { mid: sub.mid, tabs: [kind] } });
    const jobId = data.job;
    const started = Date.now();
    const tick = async () => {
      if (!state.subPick || state.subPick.job !== jobId) return;
      try {
        const job = await api("/api/space/scan/" + jobId);
        const msg = $("subPickMsg");
        if (msg) msg.textContent = job.message || "检索中…";
        if (job.status === "running") {
          if (Date.now() - started > 10 * 60 * 1000) {
            $("subPick").innerHTML = '<div class="card"><b style="color:var(--red)">检索超时</b><div class="muted">请稍后重试</div></div>';
            state.subPick = null;
            return;
          }
          setTimeout(tick, 1500);
          return;
        }
        if (job.status !== "done") {
          $("subPick").innerHTML = `<div class="card"><b style="color:var(--red)">检索失败</b><div class="muted">${esc(job.message)}</div></div>`;
          state.subPick = null;
          return;
        }
        const works = (kind === "video" ? job.video : job.opus) || [];
        showSubPick(sub, kind, works);
      } catch (err) {
        $("subPick").innerHTML = `<div class="card"><b style="color:var(--red)">检索失败</b><div class="muted">${esc(err.message)}</div></div>`;
        state.subPick = null;
      }
    };
    state.subPick = { sid: sub.id, kind, job: jobId, works: [] };
    setTimeout(tick, 1200);
  }

  /* ------------------------------------------------ 启动 */

  /* ------------------------------ 主题 ------------------------------ */
  const THEMES = [
    { id: "sakura",   name: "樱花夜色", tag: "默认", c: ["#fb7299", "#8b7cff", "#0b0d12", "#1d222d"] },
    { id: "midnight", name: "深海夜航", tag: "冷静", c: ["#4d9bff", "#22d3ee", "#070b14", "#16233a"] },
    { id: "aurora",   name: "极光薄荷", tag: "清爽", c: ["#2dd4bf", "#6ee7b7", "#06120f", "#142b25"] },
    { id: "ember",    name: "暖阳琥珀", tag: "温暖", c: ["#ff9f43", "#ff6b6b", "#0f0a07", "#2d1e14"] },
    { id: "matcha",   name: "抹茶奶绿", tag: "柔和", c: ["#a3d977", "#ffd166", "#090f09", "#1f2b1a"] },
    { id: "violet",   name: "幻夜紫",   tag: "赛博", c: ["#a78bfa", "#f472b6", "#0a0713", "#221838"] },
    { id: "daylight", name: "白天模式", tag: "明亮", c: ["#ee5a86", "#6d5cff", "#f4f6fb", "#ffffff"] },
  ];

  function currentTheme() {
    const saved = localStorage.getItem("bilidl.theme");
    return THEMES.some((t) => t.id === saved) ? saved : "sakura";
  }

  function applyTheme(id, silent) {
    document.documentElement.setAttribute("data-theme", id);
    localStorage.setItem("bilidl.theme", id);
    renderThemePickers();
    if (!silent) {
      const t = THEMES.find((x) => x.id === id);
      toast(`已切换到「${t ? t.name : id}」`);
    }
  }

  function renderThemePickers() {
    const now = document.documentElement.getAttribute("data-theme") || "sakura";
    const grid = $("themeGrid");
    if (grid) {
      grid.innerHTML = THEMES.map((t) => `
        <button class="theme-card${t.id === now ? " on" : ""}" data-theme-id="${t.id}">
          <span class="swatch">${t.c.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
          <span class="nm">${t.name}<span>${t.tag}</span></span>
        </button>`).join("");
    }
    const mini = $("themeMini");
    if (mini) {
      mini.innerHTML = THEMES.map((t) => `
        <button data-theme-mini="${t.id}" title="${t.name}" style="background:linear-gradient(135deg,${t.c[0]},${t.c[1]})"></button>`).join("");
    }
  }

  document.addEventListener("click", (ev) => {
    const card = ev.target.closest("[data-theme-id]");
    if (card) { applyTheme(card.dataset.themeId); return; }
    const mini = ev.target.closest("[data-theme-mini]");
    if (mini) { applyTheme(mini.dataset.themeMini); }
  });

  async function boot() {
    applyTheme(currentTheme(), true);
    const gClose = $("guideClose");
    if (gClose) {
      if (localStorage.getItem("bilidl.guide") === "off") $("guideCard").style.display = "none";
      gClose.addEventListener("click", () => {
        $("guideCard").style.display = "none";
        localStorage.setItem("bilidl.guide", "off");
      });
    }
    try {
      await loadStatus();
      state.vars = await api("/api/vars");
      renderVars();
    } catch (err) {
      toast(err.message, "err");
    }
    const params = new URLSearchParams(location.search);
    const linkParam = params.get("links");
    const scanParam = params.get("scan");
    if (linkParam) {
      switchPage("download");
      $("linksInput").value = linkParam;
      setTimeout(() => $("parseBtn").click(), 250);
      history.replaceState({}, "", "/");
    } else if (scanParam) {
      switchPage("space");
      $("spaceInput").value = scanParam;
      setTimeout(() => $("scanBtn").click(), 350);
      history.replaceState({}, "", "/");
    } else {
      const saved = sessionStorage.getItem("bilidl.page");
      if (saved) switchPage(saved);
    }
    // 不管在哪个页面都持续轮询，这样刷新后能立刻恢复「正在下载」的状态
    state.taskTimer = setInterval(pollTasks, 1500);
    const mtGo = $("mtGo");
    if (mtGo) mtGo.addEventListener("click", () => switchPage("tasks"));
    const mtHide = $("mtHide");
    if (mtHide) mtHide.addEventListener("click", () => { state.miniHidden = true; renderMiniTasks(); });
    setInterval(() => {
      if (state.page === "subs") loadSubs();
    }, 5000);
    pollTasks();
    updatePickSummary();
  }

  boot();
})();
