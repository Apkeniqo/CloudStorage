"""一键自检：配置、依赖、目录、数据库，以及正在运行的服务。

用法：
    python selfcheck.py                      # 检查本机配置 + 默认端口上的服务
    python selfcheck.py --url http://host:5000
    python selfcheck.py --offline            # 不检查 HTTP，只看本地环境

退出码：0 全部通过，1 有失败项。
"""

import argparse
import configparser
import json
import os
import sys
import urllib.error
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, 'config.ini')

results = []


def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('  OK   ' if ok else '  FAIL ') + name + (('  ' + detail) if detail else ''))
    return ok


def resolve(raw, default):
    raw = (raw or '').strip() or default
    if os.path.isabs(raw):
        return os.path.abspath(raw)
    return os.path.abspath(os.path.join(BASE_DIR, raw))


def http_get(url, timeout=5):
    req = urllib.request.Request(url, headers={'User-Agent': 'cloudstorage-selfcheck'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def main():
    parser = argparse.ArgumentParser(description='CloudStorage 自检')
    parser.add_argument('--url', help='要检查的服务地址，默认 http://127.0.0.1:<配置端口>')
    parser.add_argument('--offline', action='store_true', help='跳过 HTTP 检查')
    args = parser.parse_args()

    print('== 运行环境 ==')
    check('Python 版本 >= 3.9', sys.version_info >= (3, 9), sys.version.split()[0])

    try:
        import version
        check('version.py', True, version.VERSION)
    except Exception as e:
        check('version.py', False, str(e))
        version = None

    for mod in ('flask', 'flask_socketio', 'watchdog'):
        try:
            __import__(mod)
            check('依赖 ' + mod, True)
        except Exception as e:
            check('依赖 ' + mod, False, str(e))

    print('== 配置文件 ==')
    if not os.path.isfile(CONFIG_PATH):
        check('config.ini 存在', False, '请先运行 install_service.ps1 或复制 config.example.ini')
        return finish()

    cfg = configparser.ConfigParser()
    try:
        cfg.read(CONFIG_PATH, encoding='utf-8-sig')
        check('config.ini 可解析', True, f'{len(cfg.sections())} 个段')
    except Exception as e:
        check('config.ini 可解析', False, str(e))
        return finish()

    port = cfg.getint('SERVER', 'port', fallback=5000)
    host = cfg.get('SERVER', 'host', fallback='::')

    print('== 目录 ==')
    dirs = {
        '存储目录': resolve(cfg.get('PATH', 'upload_folder', fallback='CloudStorage/Files'), 'CloudStorage/Files'),
        '临时目录': resolve(cfg.get('PATH', 'temp_dir', fallback='uploads_temp'), 'uploads_temp'),
        '回收站': resolve(cfg.get('PATH', 'trash_dir', fallback='Trash'), 'Trash'),
    }
    for label, path in dirs.items():
        try:
            os.makedirs(path, exist_ok=True)
            probe = os.path.join(path, '.selfcheck_probe')
            with open(probe, 'w', encoding='utf-8') as f:
                f.write('ok')
            os.remove(probe)
            check(f'{label}可写', True, path)
        except OSError as e:
            check(f'{label}可写', False, f'{path}: {e}')

    print('== 数据库 ==')
    db_path = resolve(cfg.get('DB', 'path', fallback='CloudStorage/cloudstorage.db'),
                      'CloudStorage/cloudstorage.db')
    try:
        import db
        db.init(db_path)
        stats = db.stats()
        check('数据库可用', True, f"{db_path}（{stats['files']} 文件 / {stats['users']} 用户）")
    except Exception as e:
        check('数据库可用', False, str(e))

    print('== 认证配置 ==')
    enabled = cfg.getboolean('AUTH', 'enabled', fallback=True)
    isolate = cfg.getboolean('AUTH', 'isolate_files', fallback=False)
    check('鉴权已启用', enabled, '关闭后任何人都能访问' if not enabled else '')
    check('文件隔离', True, '开启' if isolate else '关闭')

    if args.offline:
        return finish()

    print('== 运行中的服务 ==')
    url = (args.url or f'http://127.0.0.1:{port}').rstrip('/')
    try:
        status, body = http_get(url + '/healthz')
        data = json.loads(body)
        check('/healthz', status == 200 and data.get('ok'), json.dumps(data.get('checks', {}), ensure_ascii=False))
    except urllib.error.HTTPError as e:
        check('/healthz', False, f'HTTP {e.code}')
    except Exception as e:
        check('/healthz', False, f'连不上 {url}：{e}（服务没启动？）')

    try:
        status, body = http_get(url + '/api/version')
        data = json.loads(body)
        check('/api/version', status == 200, data.get('version', ''))
    except Exception as e:
        check('/api/version', False, str(e))

    try:
        status, body = http_get(url + '/login')
        check('/login 页面', status == 200 and b'CloudStorage' in body, f'{len(body)} 字节')
    except Exception as e:
        check('/login 页面', False, str(e))

    return finish()


def finish():
    total = len(results)
    failed = [r for r in results if not r[1]]
    print('')
    if failed:
        print(f'结果：{total - len(failed)}/{total} 通过，{len(failed)} 项失败')
        for name, _, detail in failed:
            print(f'  - {name} {detail}')
        return 1
    print(f'结果：全部 {total} 项通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
