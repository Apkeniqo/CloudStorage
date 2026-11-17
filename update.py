"""在线更新：比对远端版本号，只下载有变化需要的文件，不用手动拉取。

用法：
    python update.py              # 检查、更新，并在写完后自动重启服务
    python update.py --check      # 只检查版本，不改文件
    python update.py --no-restart # 只更新文件，不重启服务
    python update.py --restart    # 兼容旧用法（现在默认就会重启）

重启需要管理员权限（sc stop/start）。

配置（config.ini 的 [UPDATE] 段）：
    repo   = Apkeniqo/CloudStorage
    branch = main
    token  = <GitHub 访问令牌>     # 私有仓库必填；public 仓库可留空

说明：本机访问 github.com:443 可能被拦截，所以这里全程走 api.github.com。
"""

import argparse
import base64
import configparser
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 默认加速节点（config.ini 的 [UPDATE] proxy 可覆盖，逗号分隔）
DEFAULT_PROXIES = ('https://tvv.tw,'
                   'https://gh.dpik.top,'
                   'https://git.yylx.win,'
                   'https://ghproxy.net')

_PROXY_LIST = []
_BAD_NODES = set()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, 'config.ini')

# 这些目录/文件属于本机数据或构建产物，更新时一律跳过
SKIP_DIRS = {'.git', '.venv', 'venv', 'logs', 'CloudStorage', 'uploads_temp',
             '__pycache__', 'node_modules'}
SKIP_FILES = {'config.ini'}
SKIP_SUFFIX = ('.pyc', '.pyo', '.part', '.tmp')


def load_config():
    cfg = configparser.ConfigParser()
    cfg.read(CONFIG_PATH, encoding='utf-8-sig')
    repo = cfg.get('UPDATE', 'repo', fallback='Apkeniqo/CloudStorage').strip()
    branch = cfg.get('UPDATE', 'branch', fallback='main').strip() or 'main'
    token = cfg.get('UPDATE', 'token', fallback='').strip()
    raw = cfg.get('UPDATE', 'proxy', fallback=DEFAULT_PROXIES) or ''
    proxies = [p.strip().rstrip('/') for p in raw.replace('\n', ',').split(',') if p.strip()]
    return repo, branch, token, proxies


def local_version():
    import version
    return version.VERSION


def parse_version(text):
    import version
    return version.parse(text)


def is_newer(remote, local):
    import version
    return version.is_newer(remote, local)


class Api:
    def __init__(self, repo, token):
        self.repo = repo
        self.token = token

    def get(self, path, raw=False, timeout=120, retries=3):
        url = 'https://api.github.com' + path
        last = None
        for attempt in range(1, retries + 1):
            req = urllib.request.Request(url)
            req.add_header('Accept', 'application/vnd.github+json')
            req.add_header('User-Agent', 'cloudstorage-updater')
            if self.token:
                req.add_header('Authorization', 'token %s' % self.token)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = resp.read()
                last = None
                break
            except urllib.error.HTTPError as e:
                last = e
                if e.code in (429, 500, 502, 503, 504) and attempt < retries:
                    print('  请求异常（%d），%ds 后重试 %d/%d ...'
                          % (e.code, attempt * 2, attempt, retries - 1))
                    time.sleep(attempt * 2)
                    continue
                break
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = e
                if attempt < retries:
                    print('  网络错误（%s），%ds 后重试 %d/%d ...'
                          % (e, attempt * 2, attempt, retries - 1))
                    time.sleep(attempt * 2)
                    continue
                break

        if last is None:
            if raw:
                return data
            return json.loads(data.decode('utf-8'))

        if isinstance(last, urllib.error.HTTPError):
            e = last
            if e.code in (401, 403):
                hint = ''
                reset = e.headers.get('X-RateLimit-Reset') if e.headers else None
                if reset:
                    try:
                        hint = '，额度重置于 %s' % time.strftime(
                            '%H:%M:%S', time.localtime(int(reset)))
                    except (ValueError, TypeError, OSError):
                        hint = ''
                raise SystemExit(
                    'GitHub 拒绝访问（%d）%s。\n'
                    '  · 未配置 token 时每小时只有 60 次 API 请求；'
                    '在 config.ini 的 [UPDATE] token 填入访问令牌可提升到 5000 次。\n'
                    '  · 私有仓库也必须填 token。' % (e.code, hint))
            if e.code == 404:
                raise SystemExit(
                    '远端路径不存在（404）：%s\n'
                    '注意：私有仓库不带令牌时 GitHub 同样返回 404，'
                    '请检查 config.ini 的 [UPDATE] repo / branch / token。' % path)
            raise SystemExit('请求失败 %d：%s' % (e.code, path))

        raise SystemExit(
            '连接 api.github.com 失败：%s\n'
            '请确认网络或代理能访问 api.github.com（github.com 被拦截不影响这里）。' % last)
        if raw:
            return data
        return json.loads(data.decode('utf-8'))

    def text(self, path):
        return self.get(path, raw=True).decode('utf-8')


def proxy_raw_url(proxy, repo, branch, path):
    """代理上的 raw 地址：<proxy>/https://raw.githubusercontent.com/<repo>/<branch>/<path>"""
    return '%s/https://raw.githubusercontent.com/%s/%s/%s' % (
        proxy.rstrip('/'), repo,
        urllib.parse.quote(branch, safe=''),
        urllib.parse.quote(path, safe='/'))


def fetch_one_node(proxy, repo, branch, path, timeout=20):
    """用指定节点取单个文件（失败抛异常）"""
    url = proxy_raw_url(proxy, repo, branch, path)
    req = urllib.request.Request(url)
    req.add_header('User-Agent', 'cloudstorage-updater')
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    head = data[:32].lstrip().lower()
    if head.startswith(b'<!doctype') or head.startswith(b'<html'):
        raise ValueError('节点返回 HTML（限流或不支持该地址）')
    return data


def fetch_via_proxy(proxies, repo, branch, path, timeout=20, expect_sha=None):
    """按顺序尝试各节点；失败的节点本次运行内不再使用。

    expect_sha 非空时校验 git blob SHA —— 代理有 CDN 缓存，可能返回旧版本内容。
    """
    last = None
    for node in proxies:
        if node in _BAD_NODES:
            continue
        try:
            data = fetch_one_node(node, repo, branch, path, timeout)
            if expect_sha and git_blob_sha(data) != expect_sha:
                raise ValueError('内容校验不符（代理缓存了旧版本）')
            return data
        except Exception as e:
            _BAD_NODES.add(node)
            last = e
            print('    节点 %s 不可用：%s' % (node, e))
    raise IOError('所有加速节点都失败：%s（%s）' % (path, last))


def probe_nodes(proxies, repo, branch, timeout=12):
    """并发测速：各节点拉一次 version.py，返回 [(node, seconds)]，按快慢排序。

    失败的节点直接计入 _BAD_NODES，本次运行不再使用。
    """
    todo = [p for p in proxies if p not in _BAD_NODES]
    if not todo:
        return []

    def one(node):
        t0 = time.time()
        try:
            fetch_one_node(node, repo, branch, 'version.py', timeout)
            return node, time.time() - t0
        except Exception:
            return node, None

    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(todo))) as pool:
        results = list(pool.map(one, todo))

    ok = [(n, sec) for n, sec in results if sec is not None]
    for node, sec in results:
        if sec is None:
            _BAD_NODES.add(node)
    ok.sort(key=lambda x: x[1])
    return ok


def fetch_remote_version(api, branch, proxies=None, repo=''):
    source = None
    try:
        data = api.get('/repos/%s/contents/version.py?ref=%s'
                       % (api.repo, urllib.parse.quote(branch)))
        source = base64.b64decode(data['content']).decode('utf-8')
    except SystemExit:
        if not (proxies and repo):
            raise
        print('  api.github.com 不可用，改用加速节点读取版本 ...')
        raw = fetch_via_proxy(proxies, repo, branch, 'version.py')
        source = raw.decode('utf-8', 'replace')
    for line in source.splitlines():
        line = line.strip()
        if line.startswith('VERSION'):
            return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit('远端 version.py 里没找到 VERSION')


def should_skip(path):
    parts = path.replace('\\', '/').split('/')
    if any(p in SKIP_DIRS for p in parts[:-1]):
        return True
    if parts[-1] in SKIP_FILES:
        return True
    return path.lower().endswith(SKIP_SUFFIX)


def git_blob_sha(data):
    """计算 git 的 blob 对象 SHA1（git hash-object 的等价实现）"""
    h = hashlib.sha1()
    h.update(b'blob %d\0' % len(data))
    h.update(data)
    return h.hexdigest()


def _local_blob_sha(full):
    """本地文件按 LF 归一化后算 blob SHA；不存在返回 None"""
    try:
        with open(full, 'rb') as f:
            data = f.read()
    except OSError:
        return None
    return git_blob_sha(data.replace(b'\r\n', b'\n'))


def download_tree(api, branch, write=False):
    """下载需要更新的文件；write=True 时边下边写（中断后可续）"""
    global _BAD_NODES
    tree = api.get('/repos/%s/git/trees/%s?recursive=1'
                   % (api.repo, urllib.parse.quote(branch, safe='')))
    if tree.get('truncated'):
        print('警告：仓库文件较多，GitHub 返回的树被截断，可能漏掉个别文件')

    files = []
    same = 0
    todo = []
    for item in tree.get('tree', []):
        if item.get('type') != 'blob':
            continue
        path = item['path']
        if should_skip(path):
            continue
        full = os.path.join(BASE_DIR, path.replace('/', os.sep))
        if os.path.isfile(full) and _local_blob_sha(full) == item['sha']:
            same += 1
            continue
        todo.append(item)

    print('远端文件 %d 个，%d 个未变化（跳过下载），%d 个需要下载'
          % (len(todo) + same, same, len(todo)))

    failed = []
    for i, item in enumerate(todo, 1):
        path = item['path']
        content = None

        if _PROXY_LIST and len(_BAD_NODES) < len(_PROXY_LIST):
            try:
                content = fetch_via_proxy(_PROXY_LIST, api.repo, branch, path,
                                          expect_sha=item['sha'])
            except Exception as e:
                print('  所有加速节点都不可用，本次剩余文件改走 API')
                content = None

        if content is None:
            try:
                blob = api.get('/repos/%s/git/blobs/%s?ref=%s'
                               % (api.repo, item['sha'], urllib.parse.quote(branch, safe='')))
                content = (base64.b64decode(blob['content'])
                           if blob.get('encoding') == 'base64' else blob['content'].encode())
                if git_blob_sha(content) != item['sha']:
                    raise SystemExit('API 返回内容校验不符')
            except SystemExit as e:
                failed.append((path, str(e)))
                print('  ✗ %s 下载失败：%s' % (path, e))
                continue

        print('  下载 %d/%d  %s（%d KB）'
              % (i, len(todo), path, max(1, len(content) // 1024)))
        files.append((path, content))
        if write:
            write_file(path, content)

    if failed:
        print()
        print('有 %d 个文件没下载成功：' % len(failed))
        for path, why in failed:
            print('  ✗ %s' % path)
        print('已成功写入的文件保留；重新执行 update 会从断点继续。')

    return files


def write_file(path, content):
    full = os.path.join(BASE_DIR, path.replace('/', os.sep))
    os.makedirs(os.path.dirname(full) or BASE_DIR, exist_ok=True)
    tmp = full + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(content)
    os.replace(tmp, full)


def _normalize(data):
    """换行差异不算变化：仓库里存 LF，Windows 工作区常是 CRLF"""
    return data.replace(b'\r\n', b'\n')


def changed_files(files):
    """只保留内容与本地不同的文件"""
    diff = []
    for path, content in files:
        full = os.path.join(BASE_DIR, path.replace('/', os.sep))
        if os.path.isfile(full):
            try:
                with open(full, 'rb') as f:
                    if _normalize(f.read()) == _normalize(content):
                        continue
            except OSError:
                pass
        diff.append((path, content))
    return diff


SERVICE_NAME = 'CloudStorage'


def _sc(*args, timeout=30):
    """跑 sc.exe，返回 (returncode, stdout, stderr)，失败不抛异常"""
    try:
        proc = subprocess.run(['sc.exe'] + list(args), capture_output=True, text=True,
                              check=False, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return 1, '', str(e)
    return proc.returncode, proc.stdout or '', proc.stderr or ''


def service_info():
    """返回 (状态, 可执行文件路径)；服务不存在时状态为 None"""
    rc, out, _ = _sc('query', SERVICE_NAME)
    if rc != 0:
        return None, ''
    m = re.search(r'STATE\s*:\s*\d+\s+(\w+)', out)
    state = m.group(1).upper() if m else 'UNKNOWN'

    rc, out, _ = _sc('qc', SERVICE_NAME)
    m = re.search(r'BINARY_PATH_NAME\s*:\s*(.+)', out)
    return state, (m.group(1).strip() if m else '')


def _service_exe(binary_path):
    """从 BINARY_PATH_NAME 里取出 exe 路径（可能带引号 + 参数）"""
    if not binary_path:
        return ''
    if binary_path.startswith('"'):
        end = binary_path.find('"', 1)
        return binary_path[1:end] if end > 0 else ''
    return binary_path.split(' ')[0]


def _broken_venv(exe):
    """venv 的启动器还在、但基础解释器被删了 —— 这种服务一起来就会失败。
    返回问题描述，没问题返回空串。"""
    scripts = os.path.dirname(exe)
    cfg = os.path.join(os.path.dirname(scripts), 'pyvenv.cfg')
    if not os.path.isfile(cfg):
        return ''
    try:
        with open(cfg, encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except OSError:
        return ''
    m = re.search(r'^\s*home\s*=\s*(.+)$', content, re.M)
    if not m:
        return ''
    home = m.group(1).strip()
    base = os.path.join(home, 'python.exe')
    if os.path.isfile(base):
        return ''
    return 'venv 的基础解释器不存在：%s' % base


def wait_state(target, timeout=60, interval=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        state, _ = service_info()
        if state is None:
            return False
        if state == target:
            return True
        time.sleep(interval)
    return False


def restart_service(timeout=60):
    """重启 CloudStorage 服务。返回 'ok' / 'skip'（没装服务）/ 'fail'"""
    print('重启 %s 服务 ...' % SERVICE_NAME)

    state, binary = service_info()
    if state is None:
        print('  未找到名为 %s 的服务，跳过重启。' % SERVICE_NAME)
        print('  如果是用 python server.py / service.py 手动运行的，请自己重启进程。')
        return 'skip'

    # 先确认服务的可执行文件还在：否则一停就起不来，反而把服务弄挂
    exe = _service_exe(binary)
    if not exe or not os.path.isfile(exe):
        print('  服务的可执行文件不存在：%s' % (exe or '(空)'))
        print('  为避免停掉服务却起不来，这次不重启。请先修好运行环境（例如重建 .venv）。')
        return 'fail'

    problem = _broken_venv(exe)
    if problem:
        print('  %s' % problem)
        print('  服务现在停掉就起不来，所以这次不重启。请先重建 .venv 再执行 Restart-Service %s。'
              % SERVICE_NAME)
        return 'fail'

    print('  当前状态：%s' % state)

    if state != 'STOPPED':
        rc, out, err = _sc('stop', SERVICE_NAME)
        if rc != 0:
            print('  停止失败（exit %d）：%s' % (rc, (err or out).strip()))
            if rc == 5:
                print('  需要管理员权限，请以管理员身份运行更新。')
            return 'fail'
        if not wait_state('STOPPED', timeout=timeout):
            print('  等待停止超时（%ds），请手动检查。' % timeout)
            return 'fail'
        print('  已停止')

    rc, out, err = _sc('start', SERVICE_NAME)
    if rc != 0 and rc != 1056:          # 1056 = 服务已在运行
        print('  启动失败（exit %d）：%s' % (rc, (err or out).strip()))
        if rc == 5:
            print('  需要管理员权限，请以管理员身份运行更新。')
        return 'fail'

    if not wait_state('RUNNING', timeout=timeout):
        print('  已下发启动命令，但 %ds 内没有进入 RUNNING，请检查 logs\\cloudstorage.log。' % timeout)
        return 'fail'

    print('  服务已重启，当前状态：RUNNING')
    return 'ok'


def main():
    parser = argparse.ArgumentParser(description='CloudStorage 在线更新')
    parser.add_argument('--check', action='store_true', help='只检查版本，不写入文件')
    parser.add_argument('--no-restart', action='store_true', help='更新后不重启服务')
    parser.add_argument('--restart', action='store_true',
                        help='兼容旧用法：更新后重启服务（现在默认就会重启）')
    args = parser.parse_args()

    repo, branch, token, proxies = load_config()
    local = local_version()
    print('当前版本：%s' % local)
    print('远端仓库：%s @ %s' % (repo, branch))
    if proxies:
        print('加速节点：%s' % ' , '.join(proxies))

    api = Api(repo, token)
    global _PROXY_LIST, _BAD_NODES
    _PROXY_LIST = list(proxies)
    _BAD_NODES = set()

    # 更新前先测速，挑最快的节点；测不通的直接拉黑
    if _PROXY_LIST:
        print('节点测速中（各拉一次 version.py）...')
        ranked = probe_nodes(_PROXY_LIST, repo, branch)
        if ranked:
            for i, (node, sec) in enumerate(ranked, 1):
                print('  %d. %-40s %.2fs' % (i, node, sec))
            _PROXY_LIST = [n for n, _ in ranked]
            print('选用节点：%s（%.2fs）' % (ranked[0][0], ranked[0][1]))
        else:
            print('  所有节点测速都失败，本次改走 api.github.com')
            _PROXY_LIST = []
    try:
        remote = fetch_remote_version(api, branch, proxies, repo)
    except SystemExit:
        raise
    except Exception as e:
        raise SystemExit('检查更新失败：%s' % e)

    print('远端版本：%s' % remote)

    if not is_newer(remote, local):
        if remote == local:
            print('已是最新版本，无需更新。')
        else:
            print('本地版本比远端新（本地开发版？），不执行更新。')
        return 0

    print('发现新版本：%s -> %s' % (local, remote))

    files = download_tree(api, branch, write=not args.check)
    print('远端文件 %d 个，需要更新 %d 个' % (len(files), len(files)))
    for path, _ in files:
        print('  ~ %s' % path)

    if args.check:
        print('（--check 模式，未写入任何文件）')
        return 0

    print('更新完成：%d 个文件已写入' % len(files))
    diff = files

    if not diff:
        print('远端内容与本地一致，无需重启。')
        return 0

    if args.no_restart:
        print('（--no-restart）文件已更新，但服务没重启，新版本还没生效。')
        print('需要时执行：Restart-Service %s' % SERVICE_NAME)
        return 0

    # 默认：更新完立刻重启，让新代码马上生效
    result = restart_service()
    if result == 'ok':
        return 0
    if result == 'skip':
        print('文件已更新。没有可重启的服务，请手动重启进程使新版本生效。')
        return 0

    print('文件已更新，但服务重启失败；新版本暂时不会生效。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
