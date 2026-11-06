(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var toastTimer;
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function api(path, opts) {
    opts = opts || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  var state = { parsed: [], scan: null, subs: null, since: null, scanQ: '' };

  // ---------- 通用 ----------
  function switchTab(name) {
    $$('nav button').forEach(function (b) { b.classList.toggle('active', b.dataset.tab === name); });
    $$('section').forEach(function (s) { s.classList.toggle('active', s.id === 'tab-' + name); });
    if (name === 'tasks') pollTasks();
    if (name === 'settings') loadSubs();
  }
  $$('nav button').forEach(function (b) {
    b.addEventListener('click', function () { switchTab(b.dataset.tab); });
  });

  function loadStatus() {
    return api('/api/status').then(function (s) {
      var chip = $('#loginChip');
      chip.textContent = s.login ? '已登录' : '未登录';
      chip.classList.toggle('on', !!s.login);
      return s;
    });
  }

  // ---------- 设置 ----------
  var settings = null;
  function loadSettings() {
    return api('/api/settings').then(function (s) {
      settings = s;
      $('#videoDir').value = s.video_dir || '';
      $('#opusDir').value = s.opus_dir || '';
      $('#videoTpl').value = s.video_template || '';
      $('#opusTpl').value = s.opus_template || '';
      $('#apiInt').value = s.api_interval;
      $('#scanInt').value = s.scan_interval;
      $('#fileInt').value = s.file_interval;
      var sel = $('#quality');
      var qs = s.qualities || [];
      sel.innerHTML = qs.map(function (q) {
        return '<option value="' + esc(q) + '"' + (q === s.quality ? ' selected' : '') + '>' + esc(q) + '</option>';
      }).join('');
      $('#videoHints').textContent = '可用变量：<video_title>=视频标题 <video_id>=BV号 <video_episode>=分集序号 <video_page_title>=分集标题 <video_author>=UP主 <video_quality>=实际清晰度 <video_date>=发布日期 <ext>=扩展名';
      $('#opusHints').textContent = '可用变量：<opus_title>=标题 <opus_id>=专栏/动态id <opus_order>=图片序号 <opus_author>=作者 <opus_date>=日期 <ext>=扩展名';
    });
  }
  $('#saveSet').addEventListener('click', function () {
    api('/api/settings', {
      method: 'POST',
      body: {
        video_dir: $('#videoDir').value.trim(),
        opus_dir: $('#opusDir').value.trim(),
        video_template: $('#videoTpl').value.trim(),
        opus_template: $('#opusTpl').value.trim(),
        api_interval: Number($('#apiInt').value) || 1.2,
        scan_interval: Number($('#scanInt').value) || 1.6,
        file_interval: Number($('#fileInt').value) || 0.8
      }
    }).then(function () { toast('设置已保存'); }).catch(function (e) { toast(e.message); });
  });

  // ---------- 链接解析 ----------
  $('#parseBtn').addEventListener('click', function () {
    var text = $('#links').value.trim();
    if (!text) return toast('先粘贴链接');
    var btn = $('#parseBtn');
    btn.disabled = true; btn.textContent = '解析中…';
    api('/api/links/parse', { method: 'POST', body: { text: text, quality: $('#quality').value } })
      .then(function (res) {
        state.parsed = (res.items || []).map(function (it) {
          it.pagesSel = (it.pages || []).map(function () { return true; });
          it.seasonSel = {};
          it.seasonAll = false;
          it.dir = '';
          return it;
        });
        renderParsed();
      })
      .catch(function (e) { toast('解析失败：' + e.message); })
      .finally(function () { btn.disabled = false; btn.textContent = '解析'; });
  });
  $('#clearBtn').addEventListener('click', function () {
    $('#links').value = ''; state.parsed = []; renderParsed();
  });

  function renderParsed() {
    var box = $('#parseResult');
    if (!state.parsed.length) { box.innerHTML = ''; $('#dlActions').style.display = 'none'; return; }
    box.innerHTML = state.parsed.map(function (it, i) {
      if (!it.ok) {
        return '<div class="card"><div class="title">' + esc(it.url) + '</div><div class="hint" style="color:#f87171">解析失败：' + esc(it.error) + '</div></div>';
      }
      var head = '<div class="work"><img src="' + esc(it.cover || '') + '" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'"><div class="meta">' +
        '<div class="title">' + esc(it.title) + '</div><div class="sub">' + esc(kindName(it.kind)) +
        (it.author ? ' · ' + esc(it.author) : '') + (it.kind === 'video' ? ' · ' + esc(it.ident) : '') +
        (it.kind === 'space' ? ' · UID ' + esc(it.mid) : '') + '</div>';
      if (it.kind === 'video') {
        head += '<div class="chips" data-idx="' + i + '">' + (it.pages || []).map(function (p, j) {
          return '<span class="chip2 ' + (it.pagesSel[j] ? 'on' : '') + '" data-page="' + j + '">P' + p.index + ' ' + esc((p.title || '').slice(0, 12)) + '</span>';
        }).join('') + '</div>';
        head += '<div class="row"><button class="tiny" data-all="1" data-idx="' + i + '">全选分集</button><button class="tiny" data-all="0" data-idx="' + i + '">全不选</button>' +
          (it.season && it.season.length ? '<span class="hint" style="margin:0">合集：' + esc(it.season_title) + '（' + it.season.length + ' 个，默认不勾）</span>' : '') + '</div>';
        if (it.season && it.season.length) {
          var shown = it.seasonAll ? it.season : it.season.slice(0, 24);
          head += '<div class="chips" data-season="' + i + '">' + shown.map(function (s) {
            return '<span class="chip2 ' + (it.seasonSel[s.bvid] ? 'on' : '') + '" data-bv="' + esc(s.bvid) + '">' + esc((s.title || s.bvid).slice(0, 14)) + '</span>';
          }).join('') + '</div>';
          head += '<div class="row"><button class="tiny" data-seasonall="' + i + '">' +
            (it.seasonAll ? '收起合集（只显示前 24 个）' : '显示全部 ' + it.season.length + ' 个合集视频') + '</button>' +
            '<button class="tiny" data-seasonclear="' + i + '">清空合集勾选</button></div>';
        }
      } else if (it.count) {
        head += '<div class="sub">共 ' + it.count + ' 张图片</div>';
      }
      head += '<div class="field"><label>单独目录（留空用设置里的目录）</label><input type="text" data-dir="' + i + '" value="' + esc(it.dir) + '" placeholder="/storage/emulated/0/Download/..."></div>';
      return head + '</div></div>';
    }).join('');
    $('#dlActions').style.display = 'block';

    box.querySelectorAll('[data-page]').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.parentNode.dataset.idx), j = Number(el.dataset.page);
        state.parsed[i].pagesSel[j] = !state.parsed[i].pagesSel[j];
        el.classList.toggle('on', state.parsed[i].pagesSel[j]);
      });
    });
    box.querySelectorAll('[data-all]').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.dataset.idx), on = el.dataset.all === '1';
        state.parsed[i].pagesSel = state.parsed[i].pagesSel.map(function () { return on; });
        renderParsed();
      });
    });
    box.querySelectorAll('[data-season] .chip2').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.parentNode.dataset.season);
        var bv = el.dataset.bv;
        state.parsed[i].seasonSel[bv] = !state.parsed[i].seasonSel[bv];
        el.classList.toggle('on', state.parsed[i].seasonSel[bv]);
      });
    });
    box.querySelectorAll('[data-seasonall]').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.dataset.seasonall);
        state.parsed[i].seasonAll = !state.parsed[i].seasonAll;
        renderParsed();
      });
    });
    box.querySelectorAll('[data-seasonclear]').forEach(function (el) {
      el.addEventListener('click', function () {
        var i = Number(el.dataset.seasonclear);
        state.parsed[i].seasonSel = {};
        renderParsed();
      });
    });
    box.querySelectorAll('[data-dir]').forEach(function (el) {
      el.addEventListener('input', function () { state.parsed[Number(el.dataset.dir)].dir = el.value; });
    });
  }

  function kindName(k) {
    return ({ video: '视频', opus: '图文', dynamic: '动态', article: '专栏', space: 'UP 主空间' })[k] || k;
  }

  $('#startBtn').addEventListener('click', function () {
    var videos = [], opus = [];
    state.parsed.forEach(function (it) {
      if (!it.ok) return;
      if (it.kind === 'video') {
        var pages = [];
        (it.pages || []).forEach(function (p, j) { if (it.pagesSel[j]) pages.push(p.index); });
        if (!pages.length) { toast('《' + it.title + '》没有选分集'); return; }
        var seasonBvids = Object.keys(it.seasonSel).filter(function (k) { return it.seasonSel[k]; });
        videos.push({ ident: it.ident, title: it.title, dir: it.dir, all_pages: true, season_all: false, pages: pages, season_bvids: seasonBvids });
      } else if (it.kind === 'space') {
        toast('UP 主空间链接请到「UP 主批量」页检索后再下载');
      } else {
        opus.push({ ident: it.ident, sub_kind: it.kind, title: it.title, dir: it.dir });
      }
    });
    if (!videos.length && !opus.length) return toast('没有可下载的内容');
    api('/api/download', { method: 'POST', body: { videos: videos, opus: opus } })
      .then(function (r) {
        toast('已创建 ' + r.created + ' 个任务');
        state.parsed = [];
        renderParsed();
        switchTab('tasks');
      })
      .catch(function (e) { toast('提交失败：' + e.message); });
  });

  // ---------- 任务 ----------
  var taskTimer;
  document.addEventListener('DOMContentLoaded', function () {
    var r = $('#retryFailed'), c = $('#clearDone'), a = $('#cancelAll');
    if (a) a.addEventListener('click', function () {
      api('/api/tasks/cancel', { method: 'POST', body: { all: true } })
        .then(function (res) {
          toast('已取消并移除 ' + ((res && res.removed) || 0) + ' 个任务');
          pollTasks();
        })
        .catch(function (e) { toast('取消失败：' + e.message); });
    });
    if (r) r.addEventListener('click', function () {
      api('/api/tasks/retry', { method: 'POST', body: {} }).then(function (res) {
        toast(res && res.retried ? ('已重新排队 ' + res.retried + ' 个失败任务') : '没有失败的任务');
        pollTasks();
      });
    });
    if (c) c.addEventListener('click', function () {
      api('/api/tasks/clear', { method: 'POST', body: {} }).then(function () { toast('已清除完成的任务（失败任务保留）'); pollTasks(); });
    });
  });
  function pollTasks() {
    api('/api/status').then(function (s) {
      var box = $('#taskList');
      if (!s.tasks.length) { box.innerHTML = '<span class="muted">暂无任务</span>'; }
      else {
        box.innerHTML = s.tasks.map(function (t) {
          var pct = t.total ? Math.round(t.done * 100 / t.total) : 0;
          var badge = ({ queued: '排队', running: '下载中', done: '完成', error: '失败', skipped: '跳过', canceled: '取消' })[t.status] || t.status;
          return '<div class="task"><img src="" style="display:none"><div class="t"><b>' + esc(t.title) + '</b>' +
            '<span>' + esc(badge) + ' · ' + t.done + '/' + t.total + ' · ' + esc(t.message || '') + '</span>' +
            '<div class="bar"><i style="width:' + pct + '%"></i></div></div>' +
            (t.status === 'queued' || t.status === 'running' ? '<button class="tiny" data-cancel="' + t.id + '">取消</button>' : '') +
            (t.status === 'error' ? '<button class="tiny" data-retry="' + t.id + '">重试</button>' : '') +
            '</div>';
        }).join('');
        $$('[data-retry]').forEach(function (b) {
          b.addEventListener('click', function () {
            api('/api/tasks/retry', { method: 'POST', body: { id: b.dataset.retry } }).then(function () { toast('已重新排队'); pollTasks(); });
          });
        });
        $$('[data-cancel]').forEach(function (b) {
          b.addEventListener('click', function () {
            api('/api/tasks/cancel', { method: 'POST', body: { id: b.dataset.cancel } }).then(function () { pollTasks(); });
          });
        });
      }
      $('#logBox').textContent = (s.events || []).slice(-12).join('\n');
      var chip = $('#loginChip');
      chip.textContent = s.login ? '已登录' : '未登录';
      chip.classList.toggle('on', !!s.login);
    }).catch(function () { });
  }
  $('#refreshTasks').addEventListener('click', pollTasks);
  taskTimer = setInterval(function () {
    if ($('#tab-tasks').classList.contains('active')) pollTasks();
  }, 2500);

  // ---------- 扫码登录 ----------
  var qrTimer;
  $('#qrBtn').addEventListener('click', function () {
    api('/api/login/qr', { method: 'POST', body: {} }).then(function (r) {
      $('#qrMsg').textContent = '请用 B站 App 扫码';
      try {
        var qr = qrcode(0, 'M');
        qr.addData(r.url);
        qr.make();
        $('#qrBox').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 8, scalable: true });
      } catch (e) {
        $('#qrBox').innerHTML = '<div class="hint">二维码渲染失败，请用 Cookie 登录</div>';
      }
      clearInterval(qrTimer);
      qrTimer = setInterval(function () {
        api('/api/login/qr/poll?key=' + encodeURIComponent(r.key)).then(function (res) {
          $('#qrMsg').textContent = res.message || '';
          if (res.code === 0) {
            clearInterval(qrTimer);
            toast('登录成功');
            loadStatus();
            $('#qrBox').innerHTML = '<div class="hint" style="color:#4ade80">已登录</div>';
          } else if (res.code === 86038) {
            clearInterval(qrTimer);
          }
        }).catch(function () { clearInterval(qrTimer); });
      }, 2000);
    }).catch(function (e) { toast('二维码获取失败：' + e.message); });
  });
  $('#cookieBtn').addEventListener('click', function () {
    var ck = $('#cookie').value.trim();
    if (!ck) return toast('先粘贴 Cookie');
    api('/api/login/cookie', { method: 'POST', body: { cookie: ck } }).then(function (r) {
      if (r.is_login) { toast('登录成功：' + (r.uname || '')); $('#loginChip').textContent = '已登录'; $('#loginChip').classList.add('on'); }
      else toast('Cookie 无效或未登录');
    }).catch(function (e) { toast('登录失败：' + e.message); });
  });
  $('#logoutBtn').addEventListener('click', function () {
    api('/api/logout', { method: 'POST', body: {} }).then(function () { toast('已退出'); loadStatus(); });
  });

  // ---------- UP 主批量 ----------
  var scanTimer;

  $('#upQ').addEventListener('input', function () {
    state.scanQ = $('#upQ').value.trim();
    if (state.scan) renderScan();
  });

  $('#upQAll').addEventListener('click', function () {
    var j = state.scan;
    if (!j) { toast('请先检索 UP 主作品'); return; }
    var q = state.scanQ || '';
    j.vSel = {}; j.oSel = {};
    (j.videos || []).forEach(function (v, i) { if (matchQ(v.title, q)) j.vSel[i] = true; });
    (j.opus || []).forEach(function (o, i) { if (matchQ(o.title, q)) j.oSel[i] = true; });
    renderScan();
    var n = Object.keys(j.vSel).filter(function (k) { return j.vSel[k]; }).length +
            Object.keys(j.oSel).filter(function (k) { return j.oSel[k]; }).length;
    toast('已选中匹配作品 ' + n + ' 个');
  });
  $('#scanBtn').addEventListener('click', function () {
    var mid = ($('#upMid').value || '').trim().replace(/.*space\.bilibili\.com\/(\d+).*/, '$1');
    if (!/^\d+$/.test(mid)) return toast('请输入 UP 主 UID 或空间链接');
    $('#scanBox').innerHTML = '<div class="card"><div class="hint">正在检索…</div></div>';
    api('/api/space/scan', { method: 'POST', body: { mid: mid, tabs: ['video', 'opus'] } }).then(function (r) {
      var job = r.job;
      clearInterval(scanTimer);
      scanTimer = setInterval(function () {
        api('/api/space/scan?id=' + job).then(function (j) {
          if (j.status === 'running') {
            $('#scanBox').innerHTML = '<div class="card"><div class="hint">' + esc(j.message) + '</div></div>';
            return;
          }
          clearInterval(scanTimer);
          state.scan = j;
          j.vSel = {}; j.oSel = {};
          renderScan();
        });
      }, 1500);
    }).catch(function (e) { toast('检索失败：' + e.message); });
  });

  function matchQ(title, q) {
    var text = String(title || '').toLowerCase();
    var toks = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return true;
    return toks.every(function (t) { return text.indexOf(t) >= 0; });
  }

  function renderScan() {
    var j = state.scan;
    if (!j) return;
    var q = state.scanQ || '';
    var vIdx = (j.videos || []).map(function (_, i) { return i; })
      .filter(function (i) { return matchQ((j.videos || [])[i].title, q); });
    var oIdx = (j.opus || []).map(function (_, i) { return i; })
      .filter(function (i) { return matchQ((j.opus || [])[i].title, q); });
    if (j.status !== 'done') {
      $('#scanBox').innerHTML = '<div class="card"><div class="hint" style="color:#f87171">' + esc(j.message) + '</div></div>';
      return;
    }
    var vCount = (j.videos || []).filter(function (_, i) { return j.vSel[i]; }).length;
    var oCount = (j.opus || []).filter(function (_, i) { return j.oSel[i]; }).length;
    var vLabel = q ? '匹配 ' + vIdx.length + ' / 共 ' + (j.videos || []).length + ' 个' : '视频 ' + (j.videos || []).length + ' 个';
    var oLabel = q ? '匹配 ' + oIdx.length + ' / 共 ' + (j.opus || []).length + ' 个' : '图文作品 ' + (j.opus || []).length + ' 个';
    $('#scanBox').innerHTML =
      '<div class="card"><h2>' + esc(j.name || j.mid) + ' · ' + vLabel + '</h2>' +
      '<div class="row"><button class="tiny" data-sel="v1">全选</button><button class="tiny" data-sel="v0">清空</button>' +
      '<button class="ghost" data-dl="v" style="margin-left:auto">下载选中视频（' + vCount + '）</button></div>' +
      '<div class="grid" style="margin-top:10px">' + (vIdx.length ? vIdx.map(function (i) {
        var v = j.videos[i];
        return '<div class="gcard ' + (j.vSel[i] ? 'sel' : '') + '" data-v="' + i + '"><img src="' + esc(v.cover) + '" loading="lazy" referrerpolicy="no-referrer"><div class="gt">' + esc(v.title) + '</div></div>';
      }).join('') : '<div class="hint">没有标题匹配的视频</div>') + '</div></div>' +
      '<div class="card"><h2>' + oLabel + '</h2>' +
      '<div class="row"><button class="tiny" data-sel="o1">全选</button><button class="tiny" data-sel="o0">清空</button>' +
      '<button class="ghost" data-dl="o" style="margin-left:auto">下载选中图文（' + oCount + '）</button></div>' +
      '<div class="grid" style="margin-top:10px">' + (oIdx.length ? oIdx.map(function (i) {
        var o = j.opus[i];
        return '<div class="gcard ' + (j.oSel[i] ? 'sel' : '') + '" data-o="' + i + '"><img src="' + esc(o.cover) + '" loading="lazy" referrerpolicy="no-referrer"><div class="gt">' + esc(o.title) + '</div></div>';
      }).join('') : '<div class="hint">没有标题匹配的图文</div>') + '</div></div>';

    $$('[data-v]').forEach(function (el) {
      el.addEventListener('click', function () { var i = el.dataset.v; state.scan.vSel[i] = !state.scan.vSel[i]; renderScan(); });
    });
    $$('[data-o]').forEach(function (el) {
      el.addEventListener('click', function () { var i = el.dataset.o; state.scan.oSel[i] = !state.scan.oSel[i]; renderScan(); });
    });
    $$('[data-sel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var k = btn.dataset.sel;
        if (k[0] === 'v') (state.scan.videos || []).forEach(function (_, i) { state.scan.vSel[i] = k[1] === '1'; });
        else (state.scan.opus || []).forEach(function (_, i) { state.scan.oSel[i] = k[1] === '1'; });
        if (k[1] === '1' && (state.scanQ || '')) {
          var jj = state.scan;
          jj.vSel = {}; jj.oSel = {};
          (jj.videos || []).forEach(function (v, i) { if (matchQ(v.title, state.scanQ)) jj.vSel[i] = true; });
          (jj.opus || []).forEach(function (o, i) { if (matchQ(o.title, state.scanQ)) jj.oSel[i] = true; });
        }
        renderScan();
      });
    });
    $$('[data-dl]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var kind = btn.dataset.dl, body = { videos: [], opus: [] };
        if (kind === 'v') {
          (state.scan.videos || []).forEach(function (v, i) {
            if (state.scan.vSel[i]) body.videos.push({ ident: v.ident, title: v.title, all_pages: true, pages: [] });
          });
        } else {
          (state.scan.opus || []).forEach(function (o, i) {
            if (state.scan.oSel[i]) body.opus.push({ ident: o.ident, sub_kind: 'opus', title: o.title });
          });
        }
        if (!body.videos.length && !body.opus.length) return toast('还没有选中作品');
        api('/api/download', { method: 'POST', body: body }).then(function (r) {
          toast('已创建 ' + r.created + ' 个任务');
          switchTab('tasks');
        }).catch(function (e) { toast('提交失败：' + e.message); });
      });
    });
  }

  // ---------- 定时追更 ----------
  function loadSubs() {
    api('/api/subs').then(function (s) { state.subs = s; renderSubs(); });
  }
  function renderSubs() {
    var s = state.subs;
    if (!s) return;
    $('#subsOn').checked = !!s.enabled;
    $('#subsInt').value = Math.round(s.interval / 60);
    $('#subsGap').value = s.min_gap;
    var box = $('#subsList');
    if (!s.subs.length) { box.innerHTML = '<div class="hint">还没有订阅</div>'; return; }
    box.innerHTML = s.subs.map(function (sub) {
      var last = sub.last_check ? new Date(sub.last_check * 1000).toLocaleString() : '从未';
      var vs = sub.video.since ? (sub.video.since_title || sub.video.since) : '未设（首次只建基线）';
      var os = sub.opus.since ? (sub.opus.since_title || sub.opus.since) : '未设（首次只建基线）';
      return '<div class="work" style="flex-direction:column;align-items:stretch">' +
        '<div class="row" style="margin:0"><img src="' + esc(sub.face) + '" style="width:40px;height:40px;border-radius:50%">' +
        '<div class="meta"><div class="title" style="font-size:14px">' + esc(sub.name || sub.mid) + '</div>' +
        '<div class="sub">UID ' + esc(sub.mid) + ' · 每 ' + Math.round(sub.interval_effective / 60) + ' 分钟 · 上次 ' + esc(last) + '</div></div>' +
        '<label class="hint" style="margin:0"><input type="checkbox" data-toggle="' + sub.id + '"' + (sub.enabled ? ' checked' : '') + '> 启用</label>' +
        '<button class="tiny" data-check="' + sub.id + '">立即检查</button>' +
        '<button class="tiny" data-del="' + sub.id + '">删除</button></div>' +
        '<div class="row" style="margin-top:8px">' +
        '<label class="hint" style="margin:0"><input type="checkbox" data-ch="v:' + sub.id + '"' + (sub.video.enabled ? ' checked' : '') + '> 追视频</label>' +
        '<label class="hint" style="margin:0"><input type="checkbox" data-ch="o:' + sub.id + '"' + (sub.opus.enabled ? ' checked' : '') + '> 追图文</label>' +
        '<span class="hint" style="margin:0">单独间隔</span><input type="number" value="' + (sub.interval ? Math.round(sub.interval / 60) : 0) + '" min="0" style="width:74px" data-iv="' + sub.id + '">' +
        '</div>' +
        '<div class="field"><label>视频起点：' + esc(vs) + '</label>' +
        '<div class="row" style="margin:0"><input type="text" value="' + esc(sub.video.dir) + '" placeholder="视频目录（留空=全局）" style="flex:1" data-vdir="' + sub.id + '">' +
        '<button class="tiny" data-pick="v:' + sub.id + ':' + esc(sub.mid) + '">选视频起点</button></div></div>' +
        '<div class="field"><label>图文起点：' + esc(os) + '</label>' +
        '<div class="row" style="margin:0"><input type="text" value="' + esc(sub.opus.dir) + '" placeholder="图文目录（留空=全局）" style="flex:1" data-odir="' + sub.id + '">' +
        '<button class="tiny" data-pick="o:' + sub.id + ':' + esc(sub.mid) + '">选图文起点</button></div></div>' +
        '<div class="row" style="margin-top:8px"><input type="text" value="' + esc(((sub.video.filters || {}).include) || '') + '" placeholder="只下标题含（空格分隔）" style="flex:1" data-finc="' + sub.id + '">' +
        '<input type="text" value="' + esc(((sub.video.filters || {}).exclude) || '') + '" placeholder="排除标题含" style="flex:1" data-fexc="' + sub.id + '"></div>' +
        '<div class="row" style="margin-top:6px"><span class="hint" style="margin:0">时长(秒)</span>' +
        '<input type="number" value="' + Number(((sub.video.filters || {}).min_dur) || 0) + '" placeholder="最短" style="width:88px" data-fmin="' + sub.id + '">' +
        '<input type="number" value="' + Number(((sub.video.filters || {}).max_dur) || 0) + '" placeholder="最长" style="width:88px" data-fmax="' + sub.id + '">' +
        '<span class="hint" style="margin:0">0=不限；过滤只影响新作品</span></div>' +
        '<div class="hint">' + esc(sub.video.last_message || sub.opus.last_message || '') + '</div>' +
        '</div>';
    }).join('') + '<div id="subPickBox"></div>';

    $$('[data-toggle]').forEach(function (el) {
      el.addEventListener('change', function () {
        api('/api/subs', { method: 'POST', body: { id: el.dataset.toggle, enabled: el.checked } })
          .then(function (r) { state.subs = r.state; loadSubs(); });
      });
    });
    $$('[data-check]').forEach(function (el) {
      el.addEventListener('click', function () {
        toast('正在检查…');
        api('/api/subs/check', { method: 'POST', body: { id: el.dataset.check } }).then(function (r) {
          toast('检查完成：视频新增 ' + (r.video || 0) + ' 个，图文新增 ' + (r.opus || 0) + ' 个');
          state.subs = r.state; renderSubs();
        }).catch(function (e) { toast('检查失败：' + e.message); });
      });
    });
    $$('[data-del]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm('删除该订阅？')) return;
        api('/api/subs/delete', { method: 'POST', body: { id: el.dataset.del } }).then(function () { loadSubs(); });
      });
    });
    $$('[data-ch]').forEach(function (el) {
      el.addEventListener('change', function () {
        var parts = el.dataset.ch.split(':');
        var body = { id: parts[1] };
        body[parts[0] === 'v' ? 'video' : 'opus'] = { enabled: el.checked };
        api('/api/subs', { method: 'POST', body: body }).then(function (r) { state.subs = r.state; renderSubs(); });
      });
    });
    $$('[data-iv]').forEach(function (el) {
      el.addEventListener('change', function () {
        api('/api/subs', { method: 'POST', body: { id: el.dataset.iv, interval: Math.max(0, (Number(el.value) || 0) * 60) } })
          .then(function (r) { state.subs = r.state; renderSubs(); });
      });
    });
    function saveFilters(sid) {
      var q = function (a) { return document.querySelector('[data-' + a + '="' + sid + '"]'); };
      var filt = {
        include: q('finc').value.trim(),
        exclude: q('fexc').value.trim(),
        min_dur: Math.max(0, Number(q('fmin').value) || 0),
        max_dur: Math.max(0, Number(q('fmax').value) || 0)
      };
      api('/api/subs', { method: 'POST', body: { id: sid, video: { filters: filt }, opus: { filters: filt } } })
        .then(function (r) { state.subs = r.state; renderSubs(); toast('过滤规则已保存'); });
    }
    ['finc', 'fexc', 'fmin', 'fmax'].forEach(function (a) {
      $$('[data-' + a + ']').forEach(function (el) {
        el.addEventListener('change', function () { saveFilters(el.dataset[a]); });
      });
    });
    $$('[data-pick]').forEach(function (el) {
      el.addEventListener('click', function () {
        var parts = el.dataset.pick.split(':');
        pickStart(parts[0], parts[1], parts[2]);
      });
    });
    $$('[data-vdir]').forEach(function (el) {
      el.addEventListener('change', function () {
        api('/api/subs', { method: 'POST', body: { id: el.dataset.vdir, video: { dir: el.value } } })
          .then(function (r) { state.subs = r.state; });
      });
    });
    $$('[data-odir]').forEach(function (el) {
      el.addEventListener('change', function () {
        api('/api/subs', { method: 'POST', body: { id: el.dataset.odir, opus: { dir: el.value } } })
          .then(function (r) { state.subs = r.state; });
      });
    });
  }
  function pickStart(kind, subId, mid) {
    var box = $('#subPickBox');
    box.innerHTML = '<div class="card"><div class="hint">正在检索该 UP 主的' + (kind === 'v' ? '视频' : '图文') + '…</div></div>';
    api('/api/space/scan', { method: 'POST', body: { mid: mid, tabs: [kind === 'v' ? 'video' : 'opus'] } })
      .then(function (r) {
        var job = r.job;
        var timer = setInterval(function () {
          api('/api/space/scan?id=' + job).then(function (j) {
            if (j.status === 'running') return;
            clearInterval(timer);
            var list = kind === 'v' ? (j.videos || []) : (j.opus || []);
            if (!list.length) { box.innerHTML = '<div class="card"><div class="hint">没有检索到作品</div></div>'; return; }
            box.innerHTML = '<div class="card"><h2>选一部作为起点（含它本身，往后下载）</h2>' +
              '<div class="grid" style="margin-top:8px">' + list.map(function (w, i) {
                return '<div class="gcard" data-pickwork="' + i + '"><img src="' + esc(w.cover) + '" loading="lazy" referrerpolicy="no-referrer">' +
                  '<div class="gt">' + esc(w.title) + '</div></div>';
              }).join('') + '</div>' +
              '<div class="row"><button class="ghost" data-pickcancel="1">取消</button></div></div>';
            $$('[data-pickwork]').forEach(function (c) {
              c.addEventListener('click', function () {
                var w = list[Number(c.dataset.pickwork)];
                var ch = { since: w.ident, since_title: w.title, since_time: 0 };
                var body = { id: subId };
                body[kind === 'v' ? 'video' : 'opus'] = ch;
                api('/api/subs', { method: 'POST', body: body }).then(function (r) {
                  state.subs = r.state;
                  box.innerHTML = '';
                  renderSubs();
                  toast('起点已设为「' + w.title.slice(0, 20) + '」，从它开始往后下载');
                });
              });
            });
            var cancel = $('[data-pickcancel]');
            if (cancel) cancel.addEventListener('click', function () { box.innerHTML = ''; });
          });
        }, 1500);
      })
      .catch(function (e) { box.innerHTML = '<div class="card"><div class="hint" style="color:#f87171">检索失败：' + esc(e.message) + '</div></div>'; });
  }

  $('#subsSave').addEventListener('click', function () {
    api('/api/subs/config', {
      method: 'POST',
      body: { enabled: $('#subsOn').checked, interval: Math.max(120, (Number($('#subsInt').value) || 10) * 60), max_new: 20, min_gap: Number($('#subsGap').value) || 90 }
    }).then(function (s) { state.subs = s; renderSubs(); toast('追更设置已保存'); });
  });
  $('#subsKind').addEventListener('change', function () {
    var k = this.value;
    var ph = { up: 'UP 主 UID', fav: '收藏夹 media_id', bangumi: 'season_id / ss12345', toview: '稍后再看（无需填写）' }[k];
    $('#subsMid').placeholder = ph;
    $('#subsMid').disabled = k === 'toview';
    if (k === 'toview') $('#subsMid').value = '';
  });

  $('#subsAdd').addEventListener('click', function () {
    var kind = $('#subsKind').value || 'up';
    var raw = ($('#subsMid').value || '').trim();
    var mid = '', target = '';
    if (kind === 'up') {
      mid = raw;
      if (!/^\d+$/.test(mid)) return toast('请输入 UP 主 UID');
    } else if (kind !== 'toview') {
      target = (raw.match(/\d{2,}/) || [''])[0];
      if (!target) return toast(kind === 'fav' ? '请输入收藏夹 media_id' : '请输入番剧 season_id');
    }
    api('/api/subs', { method: 'POST', body: { kind: kind, mid: mid, target: target, enabled: true, interval: 0,
        video: { enabled: true }, opus: { enabled: kind === 'up' } } })
      .then(function (r) {
        state.subs = r.state; renderSubs();
        $('#subsMid').value = '';
        toast('已添加，首次扫描只建立基线');
      }).catch(function (e) { toast('添加失败：' + e.message); });
  });

  // ---------- 启动 ----------
  loadStatus();
  loadSettings();
  pollTasks();
  setInterval(loadStatus, 15000);
})();
