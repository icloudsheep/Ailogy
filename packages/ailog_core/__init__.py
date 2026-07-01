"""ailog_core —— 后端入库校验用的 entry 契约（单一事实源）。

只保留一条日志条目的规范形状（pydantic 模型），供后端 ingest 解析 / 校验请求体、
repo 落盘映射复用：
    schema      entry 字段定义（Entry / Usage / Carryover）与 day_of

会话代号派生、token 统计、时间计算、本地落盘与 HTML 渲染都属于「客户端」职责，
已收敛到 ai-log skill（唯一 CLI 真源），本后端仓库不再持有那部分逻辑。
"""
