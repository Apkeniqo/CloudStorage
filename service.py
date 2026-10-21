"""把 CloudStorage 注册成 Windows 服务，开机静默运行。

首次部署（管理员 PowerShell）：

    python service.py install              # 注册服务（默认手动启动）
    python service.py --startup auto install   # 注册并设为开机自启
    python service.py start / stop         # 手动控制
    python service.py remove               # 卸载

调试用：

    python service.py --foreground         # 前台运行，日志同时打到控制台
    python service.py debug                # 以「服务」方式在控制台里跑（不注册服务）

说明：Windows 服务不能从网络共享（\\\\server\\share\\...）启动，
所以项目必须放在本机磁盘上；install_service.ps1 会做这个检查。
"""

import os
import sys
import time
import logging
import threading
import logging.handlers

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

import logutil

LOG_DIR = logutil.LOG_DIR
LOG_FILE = logutil.LOG_FILE

logger = logging.getLogger('cloudstorage')


# ---------------------------------------------------------------- 日志

def setup_logging(redirect=False):
    """文件日志；redirect=True 时接管 stdout/stderr（服务模式没有控制台）"""
    return logutil.setup_logging(redirect=redirect)


# ---------------------------------------------------------------- 服务主体

class ServerRunner:
    """用 werkzeug 的可关闭服务器承载 Flask + Socket.IO，便于优雅停止"""

    def __init__(self):
        self.httpd = None
        self.thread = None
        self.server = None
        self.listen_sock = None

    def start(self):
        # 告诉 server.py 当前跑在 Windows 服务里（自动重启走 sc start）
        os.environ['CLOUDSTORAGE_SERVICE'] = '1'
        import server  # 放在这里导入：先装好日志，模块初始化的 print 才不会丢

        self.server = server
        # 由 server.create_http_server() 统一处理 '::' 的双栈绑定
        self.httpd, self.listen_sock = server.create_http_server()
        server.start_background_workers()

        self.thread = threading.Thread(target=self.httpd.serve_forever,
                                       name='cloudstorage-http', daemon=True)
        self.thread.start()
        logger.info('服务已启动：http://%s:%s（数据库 %s）',
                    server.HOST, server.PORT, server.DB_PATH)

    def stop(self):
        if not self.httpd:
            return
        logger.info('正在停止服务...')
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            logger.exception('停止 HTTP 服务时出错')
        finally:
            self.httpd = None
            if self.listen_sock is not None:
                try:
                    self.listen_sock.close()
                except OSError:
                    pass
                self.listen_sock = None


def run_foreground():
    """前台运行（调试/计划任务用），Ctrl+C 退出"""
    setup_logging(redirect=False)
    import server

    server.validate_bind_port()
    server.print_runtime_summary()
    runner = ServerRunner()
    runner.start()
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n收到 Ctrl+C，正在退出...")
    finally:
        runner.stop()


# ---------------------------------------------------------------- Windows 服务

try:
    import win32serviceutil
    import win32service
    import win32event
    import servicemanager
    HAS_PYWIN32 = True
except ImportError:  # 非 Windows 或没装 pywin32 时仍可用 --foreground
    HAS_PYWIN32 = False


if HAS_PYWIN32:

    class CloudStorageService(win32serviceutil.ServiceFramework):
        _svc_name_ = 'CloudStorage'
        _svc_display_name_ = 'CloudStorage 文件服务'
        _svc_description_ = '局域网文件存储与上传服务（Flask + SocketIO），开机静默运行。'
        # 显式指定解释器与脚本，避免注册成无法启动的命令行
        _exe_name_ = sys.executable
        _exe_args_ = '"%s"' % os.path.abspath(__file__)

        def __init__(self, args):
            super().__init__(args)
            self.stop_event = win32event.CreateEvent(None, 0, 0, None)
            self.runner = ServerRunner()

        def SvcStop(self):
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
            win32event.SetEvent(self.stop_event)
            self.runner.stop()

        def SvcDoRun(self):
            setup_logging(redirect=True)
            try:
                servicemanager.LogMsg(servicemanager.EVENTLOG_INFORMATION_TYPE,
                                      servicemanager.PYS_SERVICE_STARTED,
                                      (self._svc_name_, ''))
            except Exception:
                pass

            logger.info('========== 服务启动 ==========')
            try:
                self.runner.start()
            except SystemExit as e:
                logger.error('启动失败：%s', e)
                return
            except Exception:
                logger.exception('启动失败')
                return

            win32event.WaitForSingleObject(self.stop_event, win32event.INFINITE)
            logger.info('========== 服务已停止 ==========')


def is_admin():
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


# 这些命令需要管理员权限，提前拦一下，免得 pywin32 只打印一行英文错误还返回 0
ADMIN_COMMANDS = ('install', 'update', 'remove', 'start', 'stop', 'restart')


def main():
    args = sys.argv[1:]

    if '--foreground' in args:
        run_foreground()
        return

    if not HAS_PYWIN32:
        print("未安装 pywin32，无法注册为 Windows 服务。")
        print("  安装： python -m pip install pywin32")
        print("  或者： python service.py --foreground")
        raise SystemExit(1)

    if not args:
        # SCM 启动服务时命令行不带任何参数。新版 pywin32 的 HandleCommandLine
        # 在参数为空时只会打印 usage 然后退出，SCM 等 30 秒后报 7009/1053。
        # 所以这里必须自己接管服务控制器。
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(CloudStorageService)
        servicemanager.StartServiceCtrlDispatcher()
        return

    command = next((a for a in args if a in ADMIN_COMMANDS), None)
    if command and not is_admin():
        print(f"执行 '{command}' 需要管理员权限。")
        print("请用「以管理员身份运行」的 PowerShell 再执行，或直接运行 install_service.ps1。")
        raise SystemExit(1)

    try:
        win32serviceutil.HandleCommandLine(CloudStorageService)
    except Exception as e:
        print(f"操作失败：{e}")
        print("提示：注册/启停 Windows 服务需要管理员权限，")
        print("      请用「以管理员身份运行」的 PowerShell 执行，或直接运行 install_service.ps1。")
        raise SystemExit(1)


if __name__ == '__main__':
    main()
