"""ailog_core —— CLI 与后端共用的纯逻辑（单一事实源）。

只放「不依赖落盘 / 不依赖 HTTP」的算法，保证 CLI 本地渲染与后端 ingest 用同一套：
    session     会话代号确定性派生
    transcript  会话 transcript 解析与 token/轮数统计
    timecalc    时间 / duration / 跨午夜天数计算
    schema      entry 字段定义与构建（pydantic 模型）

落盘（data.json）在 ailog_cli.store；HTML 渲染在 ailog_cli.render；二者不属于 core。
"""
