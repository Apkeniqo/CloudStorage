"""被服务/进程自己拉起的小助手：等旧进程退出后把服务重新启动。

由 server.py 调用，不要手动执行：

    python restart_helper.py <service|process> <pid> <delay> <python> <script> [args...]

service 模式：等旧进程退出后执行 `sc start CloudStorage`。
process 模式：等旧进程退出后用同样的命令重新拉起脚本。
"""

import os
import subprocess
import sys
import time

SERVICE_NAME = 'CloudStorage'
DETACHED = 0x00000008 | 0x00000200          # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
BREAKAWAY = 0x01000000                      # CREATE_BREAKAWAY_FROM_JOB


def _alive(pid):
    try:
        out = subprocess.run(['tasklist', '/FI', 'PID eq %d' % pid, '/NH'],
                             capture_output=True, text=True, timeout=10)
        return str(pid) in (out.stdout or '')
    except Exception:
        return False


def main():
    if len(sys.argv) < 6:
        print('usage: restart_helper.py <service|process> <pid> <delay> <python> <script> [args...]')
        return 2

    mode = sys.argv[1]
    pid = int(sys.argv[2])
    delay = float(sys.argv[3])
    exe = sys.argv[4]
    script = sys.argv[5]
    extra = sys.argv[6:]

    time.sleep(max(0.2, delay))

    # 等旧进程真正退出（最多 60 秒）
    for _ in range(120):
        if not _alive(pid):
            break
        time.sleep(0.5)
    time.sleep(0.5)

    if mode == 'service':
        subprocess.run(['sc.exe', 'start', SERVICE_NAME],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return 0

    args = [exe, script] + extra
    cwd = os.path.dirname(os.path.abspath(script))
    try:
        subprocess.Popen(args, cwd=cwd, close_fds=True, creationflags=DETACHED | BREAKAWAY,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        # 某些作业对象不允许 breakaway，退回普通脱离方式
        subprocess.Popen(args, cwd=cwd, close_fds=True, creationflags=DETACHED,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return 0


if __name__ == '__main__':
    sys.exit(main())
