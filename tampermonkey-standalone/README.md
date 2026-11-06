# BiliDL 独立版（油猴脚本，不依赖电脑）

这是一个**完全在浏览器里跑**的 B 站下载脚本：不需要装 BiliDL 服务端、不需要开电脑上的 exe，装进 Tampermonkey 就能用。

```
tampermonkey-standalone/
├── bilidl-standalone.user.js   # 脚本本体（唯一需要安装的文件）
└── README.md                   # 本文件
```

## 和主版本（tampermonkey/bilidl-pusher.user.js）的区别

| | 独立版（本目录） | 主版本 |
|---|---|---|
| 依赖 | **无**，纯浏览器 | 需要本机 BiliDL 服务（exe / docker / apk）在跑 |
| 登录 / 下载设置 | **脚本内小窗自己管** | 在 WebUI 里设 |
| 定时追更 | 无 | 有（订阅 UP/收藏夹/番剧/稍后再看） |
| 页面多选下载 | 有（视频 + 图文 + 专栏） | 有 |
| 下载落盘 | 浏览器下载目录 + 子目录 | 服务端任意目录 |

## 安装

1. 浏览器装 Tampermonkey（Chrome / Edge / Firefox 均可）。
2. 打开 Tampermonkey → 「添加新脚本」→ 把 `bilidl-standalone.user.js` 全文粘贴进去 → 保存。
3. 打开 B 站任意页面，右下角会出现一个半透明小圆点 **⬇**，点它打开设置小窗。

## 用法

### 1. 登录（想下 1080P 才需要）

小窗「账号」区三种方式：

- **B站 App 扫码登录**：点按钮弹出 B 站官方登录窗 → 手机 App 扫码 → 登录后自动检测并关闭弹窗（推荐的稳妥方式）。
- **手动 Cookie**：把浏览器里 `SESSDATA=…; bili_jct=…; DedeUserID=…` 整段贴进去 → 点「用 Cookie 登录」。脚本会写进本机 `.bilibili.com` 的 Cookie，不上传任何地方。若 SESSDATA 被浏览器标成 HttpOnly，脚本写不进去，会提示改用扫码。
- **刷新状态 / 退出登录**：随时检查当前登录态。

未登录也能下，但只有 720P 及以下。

### 2. 下载设置

- **清晰度**：8K / 4K / 1080P60（默认）/ 1080P+ / 1080P / 720P60 / 720P / 480P / 360P。实际能不能拿到取决于账号权限，脚本会自动逐级回退到可用清晰度。
- **下载子目录**：默认 `BiliDL`，文件会落在「浏览器下载目录/BiliDL/…」。
- **视频重命名规则**（默认 `<video_title>-<video_id>-<video_episode>.<ext>`）
  可用变量：`<video_title>` 视频标题、`<video_id>` BV 号、`<video_episode>` 分集序号、`<video_page_title>` 分集标题、`<video_author>` UP 主、`<video_quality>` 清晰度、`<video_date>` 发布日期、`<ext>` 扩展名。
- **图文重命名规则**（默认 `<opus_title>-<opus_id>-<opus_order>.<ext>`）
  可用变量：`<opus_title>` 标题、`<opus_id>` 图文 id、`<opus_order>` 图片序号、`<opus_author>` 作者、`<ext>` 扩展名。
- 规则里写 **`/`** 会在子目录下再建文件夹，例如 `<opus_author>/<opus_title>-<opus_order>.<ext>` → `BiliDL/作者名/标题-1.jpg`。
- 线程数（1~4）与文件间隔（毫秒）也在这一区。

### 3. UP 主空间页多选

1. 打开 `https://space.bilibili.com/<uid>/upload/opus`（图文）或 `/upload/video`（视频）。
2. 小窗里勾选 **「开启多选模式（点缩略图即选中）」**（默认关闭）。
3. 页面每张卡片左上角出现勾选框；点卡片/缩略图即选中（不会跳转）。
4. 底部条显示「已选 N 个（视频 a / 图文 b）」，可「全选本页 / 清空 / 发送下载」。
5. 发送后任务进入小窗「队列」，实时看进度与完成/失败数。
6. 队列工具行有「**取消全部**」：清空排队、中止在途下载，任务直接从队列删除（不会留 canceled 占位）。

### 4. 粘贴链接下载

小窗「粘贴链接下载」支持一次贴多行：`www.bilibili.com/video/BV…`、`space.bilibili.com/…`、`www.bilibili.com/opus/…`、`/read/cv…`、`t.bilibili.com/…`、`b23.tv/…` 短链（短链会用 `GM_xmlhttpRequest` 跟随跳转还原）。

## 风控与礼貌

- 所有接口请求都带随机延迟（默认 700ms + 0~250ms 抖动），并在连续请求之间排队。
- 遇到 `-352 / -412 / 429` 会**自动冷却**（20s/40s/60s 递增）后重试，不会硬刷。
- 下载并发默认 2，文件之间默认 900ms 间隔。
- 脚本只在你点「发送下载」时才请求 B 站，平时不扫描、不轮询、不后台跑。

## 已知限制（浏览器沙箱决定）

1. **只能存到浏览器的下载目录**：网页没有权限写任意路径，所以「下载子目录」是靠文件名前缀实现的（`BiliDL/作者/文件`），浏览器会在下载目录里自动建这些文件夹。
2. **单文件 MP4**：脚本用 `playurl(type=mp4)` 拿整段 MP4，所以清晰度上限受此限制（未登录 720P，登录常见 1080P）；4K/HDR 等需要 DASH 分轨合并，脚本不做合并。
3. **短链解析**依赖 `GM_xmlhttpRequest` 权限，若浏览器拦截，直接贴展开后的完整链接即可。
4. 视频列表页在**未登录**时有时不渲染卡片（B 站自身行为），登录后正常；图文页不受影响。

## 升级

Tampermonkey 里打开本脚本 → 全选删除 → 粘贴新版全文 → 保存。设置存在 `GM_setValue` 里，覆盖脚本不会丢。
