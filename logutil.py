"""运行日志：文件位置、写入方式与保留策略。

被 server.py（命令行/前台）和 service.py（Windows 服务）共用。
只依赖标准库，导入很快，不会触发业务模块初始化。
"""

import logging
import logging.handlers
import os
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(BASE_DIR, 'logs')
LOG_FILE = os.path.join(LOG_DIR, 'cloudstorage.log')

# 单文件上限与备份数：cloudstorage.log + .1 ... .10
# 单文件 20MB、最多 10 份备份 ≈ 220MB 上限，真正由下面的 100MB 策略来瘦身
MAX_BYTES = 20 * 1024 * 1024
BACKUP_COUNT = 10

_configured = False

logger = logging.getLogger('cloudstorage')


class _StreamToLogger:
    """服务进程没有控制台，把 print() 的输出转进日志文件"""

    def __init__(self, level):
        self.level = level
        self.buffer = ''

    def write(self, text):
        self.buffer += text
        while '\n' in self.buffer:
            line, self.buffer = self.buffer.split('\n', 1)
            if line.strip():
                logger.log(self.level, line)

    def flush(self):
        if self.buffer.strip():
            logger.log(self.level, self.buffer.strip())
        self.buffer = ''

    def isatty(self):
        return False


def setup_logging(redirect=False):
    """加一个滚动文件日志；redirect=True 时接管 stdout/stderr（服务模式用）"""
    global _configured
    os.makedirs(LOG_DIR, exist_ok=True)

    root = logging.getLogger()
    if not any(isinstance(h, logging.handlers.RotatingFileHandler) for h in root.handlers):
        handler = logging.handlers.RotatingFileHandler(
            LOG_FILE, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding='utf-8')
        handler.setFormatter(logging.Formatter('%(asctime)s [%(levelname)s] %(message)s'))
        root.addHandler(handler)
        if root.level > logging.INFO:
            root.setLevel(logging.INFO)

    if redirect and not _configured:
        import sys
        sys.stdout = _StreamToLogger(logging.INFO)
        sys.stderr = _StreamToLogger(logging.ERROR)

    _configured = True
    return LOG_FILE


def log_files():
    """返回 [(path, name, size, mtime)]，按修改时间从旧到新"""
    if not os.path.isdir(LOG_DIR):
        return []
    items = []
    for name in os.listdir(LOG_DIR):
        path = os.path.join(LOG_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        items.append((path, name, st.st_size, st.st_mtime))
    items.sort(key=lambda x: x[3])
    return items


def dir_size():
    return sum(item[2] for item in log_files())


def prune_logs(max_total_bytes=100 * 1024 * 1024, max_age_days=30, max_files=20):
    """按「总大小 / 文件数 / 保留天数」清理旧日志，返回被删除的文件名。

    正在写入的 cloudstorage.log 不会被删（Windows 上也删不掉）。
    """
    items = log_files()
    if not items:
        return []

    active = os.path.normcase(os.path.abspath(LOG_FILE))
    total = sum(item[2] for item in items)
    removed = []
    now = time.time()

    for path, name, size, mtime in items:
        if os.path.normcase(os.path.abspath(path)) == active:
            continue
        remaining = len(items) - len(removed)
        too_old = max_age_days > 0 and (now - mtime) > max_age_days * 86400
        too_many = max_files > 0 and remaining > max_files
        too_big = max_total_bytes > 0 and total > max_total_bytes
        if not (too_old or too_many or too_big):
            continue
        try:
            os.remove(path)
        except OSError:
            continue  # 被占用/权限不足就跳过，下一轮再说
        removed.append(name)
        total -= size

    return removed
