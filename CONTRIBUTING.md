# 贡献指南

欢迎提 Issue 和 PR。这个项目以「能在 NAS / 小主机上稳定跑」为第一目标，改动请尽量保持：Python 标准库优先、前端零构建、Docker 镜像可离线重建。

## 本地开发

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# 启动（数据目录 / 下载目录都可以用环境变量改）
BILIDL_DATA_DIR=./data BILIDL_DOWNLOAD_DIR=./downloads \
  python3 -m bilidl --host 127.0.0.1 --port 2197
```

## 提交前自检

```bash
python3 -m py_compile bilidl/*.py
node --check web/app.js
node --check tampermonkey/bilidl-pusher.user.js
node --check tampermonkey-standalone/bilidl-standalone.user.js

PYTHONPATH=. python3 tests/naming_test.py
PYTHONPATH=. python3 tests/social_test.py
node tests/standalone_social_test.js
node tests/pusher_social_send_test.js
```

`tests/final_test.py` 需要真实服务端在跑，默认连 `http://127.0.0.1:2197`，不放进常规自检。

## 代码约定

- 不引入需要编译的 Python 依赖；新增依赖请写进 `requirements.txt` 并说明用途。
- 前端不引 CDN、不加构建步骤；样式改完在 1440×900 下确认不溢出。
- 油猴脚本保持两个版本（推送版 / 独立版）行为一致；新增站点时两边的 `classify`、卡片扫描、勾选框、批量发送要一起改。
- 不要提交 `data/`、`downloads/`、`.env`、任何 Cookie / Token / 密钥 / 个人路径。

## 安全

发现安全问题请不要公开提 Issue，直接通过仓库主页的联系方式私下告知。
