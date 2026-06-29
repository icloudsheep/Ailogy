# Ailogy

把 AI 工作日志从「本地离线单文件」升级为「前后端服务」：CLI 带密钥上报，后端按用户隔离存储到 SQLite，网页以瀑布流呈现，可按日期 / 按 session / 忽略日期三种视图无限下滑查看。

> 本仓库脱胎于 [claude-skills 的 ai-log skill](https://github.com/icloudsheep/claude-skills)。原本的纯本地离线工具仍保留，本项目在其之上增加后端、数据库与密钥平台。

## 架构一览

```mermaid
flowchart TB
    subgraph CLI["CLI ai-log（双模式）"]
        C1["write_entry / edit / delete"] --> C2["本地离线渲染 index.html"]
        C1 --> C3["带密钥 POST 上报"]
    end
    subgraph Browser["浏览器"]
        P1["密钥平台：注册/登录/申请/审批"]
        P2["用户瀑布流页面：静态壳 + 渲染 JS"]
    end
    subgraph Backend["FastAPI (uvicorn)"]
        MW["鉴权层：API Key / Session / Share Token"]
        CORE["ailog_core（代号/token/时间计算）"]
        ST["静态资产：mermaid/katex/壳"]
    end
    DB[("SQLite 单文件")]
    C3 -->|API Key| MW
    P1 -->|Session Cookie| MW
    P2 -->|Session 或 Share Token| MW
    P2 -.->|加载壳与资产| ST
    MW --> DB
    MW --> CORE
```

## 目录结构

```
Ailogy/
├── packages/
│   ├── ailog_core/     # 纯逻辑：会话代号派生、token 统计、时间计算、entry 模型（CLI 与后端共用）
│   └── ailog_cli/      # 本地 CLI：写 data.json + 离线渲染，外加可选带密钥上报
├── backend/app/        # FastAPI：路由、模型、DB、鉴权、安全
├── frontend/
│   ├── shared/js/      # 纯渲染：markdown / mermaid / katex / 格式化工具（前后端两场景复用）
│   ├── viewer/         # 用户瀑布流页面（静态壳 + API 分页拉取）
│   └── platform/       # 密钥平台前端（注册/登录/申请/审批）
├── vendor/             # mermaid.min.js / katex / version.js（后端静态路由提供）
└── scripts/            # 导入、建库、管理员等运维脚本
```

## 状态

里程碑全部完成（M0–M5）：

- **M0** 核心抽取 + FastAPI 骨架
- **M1** 三视图瀑布流读取链路
- **M2** 账号与密钥平台
- **M3** CLI 上报双模式
- **M4** 多用户隔离与公开分享
- **M5** 安全加固（限流等）

## 运行

```bash
python3 -m venv .venv && .venv/bin/pip install -e .   # 安装依赖
# 启动后端（含静态前端）
AILOGY_DB=./ailogy.db PYTHONPATH=packages:backend \
  .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

- 瀑布流页面：`http://127.0.0.1:8000/`（需登录）或 `/u/{handle}`；公开分享 `/?share=<token>`
- 密钥平台：`http://127.0.0.1:8000/platform`（注册 / 登录 / 申请 / 密钥 / 审批）
- 首个注册用户自动成为管理员；管理员也可用 `python scripts/admin.py list|approve|reject|make-admin`
- 导入既有 ai-log 数据：`python scripts/import_datajson.py <ai-log 根目录>`

CLI 双模式上报（在 `~/.config/ai-log/config.json` 配 `backend.url`/`api_key`/`report`，或用环境变量
`AILOG_BACKEND_URL` / `AILOG_API_KEY`，或 `--report` 临时开启）：

```bash
ailog --report --title "标题" --summary "正文"   # 本地渲染 + 上报后端
```

## 安全说明

- 密码 argon2id 哈希；API 密钥只存 sha256 + 前缀，明文仅创建时返回一次，可吊销。
- 会话用服务端表 + httponly/SameSite=Lax cookie；登录/注册/申请/ingest 有 IP 限流（防爆破）。
- 读取/编辑强制 user_id 归属校验（防 IDOR）；页面默认私有，公开是显式动作、转私即吊销分享链接。
- ⚠️ 本地运行是**无 TLS 的明文 http**，仅限本机 / 内网。对外暴露务必置于 https 反向代理之后，
  并把 cookie 的 `secure` 置 true、收紧 CORS 白名单。

## 许可证

[MIT](LICENSE)
