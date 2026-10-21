"""版本号：每次更新都要递增。

格式：<阶段> <年份>.<月日>.<同日构建号>
例如 beta 2026.1022.16，当天第二次更新就是 beta 2026.1022.16。
"""

VERSION = 'beta 2026.1022.16'

# 便于程序解析：拆成 (阶段, 年份, 月日, 构建号)
def parse(value=None):
    text = (value or VERSION).strip()
    stage, _, rest = text.partition(' ')
    year, _, tail = rest.partition('.')
    md, _, build = tail.partition('.')
    return stage, int(year or 0), int(md or 0), int(build or 0)


def is_newer(remote, local=None):
    """远端版本是否比本地新（按 阶段/年/月日/构建号 依次比较）"""
    return parse(remote) > parse(local or VERSION)
