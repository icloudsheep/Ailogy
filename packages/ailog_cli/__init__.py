"""ai-log 日志记录工具的内部包。

模块划分（高内聚低耦合，扁平结构）：
    config      —— 配置文件与保存目录（root）解析
    session     —— 会话代号确定性派生
    store       —— data.json 读写、时间线计算、跨午夜接续、日期目录遍历
    transcript  —— 会话 transcript 解析与 token/轮数统计
    render      —— index.html / data.js 渲染、资产软链、别名 aliases.js
    entry       —— git 分支读取、日志条目写入 / 编辑 / 删除
    cli         —— argparse 参数解析与命令分发（main 入口）

对外入口为 cli.main()，由同级 ../ai_logger.py 薄封装调用。
"""
