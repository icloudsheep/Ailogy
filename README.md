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

开发中。里程碑：

- **M0** 核心抽取 + FastAPI 骨架
- **M1** 三视图瀑布流读取链路
- **M2** 账号与密钥平台
- **M3** CLI 上报双模式
- **M4** 多用户隔离与公开分享
- **M5** 安全加固

## 许可证

[MIT](LICENSE)
