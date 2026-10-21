"""在线更新：比对远端版本号，只下载有变化需要的文件，不用手动拉取。

用法：
    python update.py              # 检查并更新
    python update.py --check      # 只检查版本，不改文件
    python update.py --restart    # 更新后尝试重启 CloudStorage 服务（需要管理员）

配置（config.ini 的 [UPDATE] 段）：
    repo   = Apkeniqo/CloudStorage
    branch = main
    token  = <GitHub 访问令牌>     # 私有仓库必填；public 仓库可留空

说明：本机访问 github.com:443 可能被拦截，所以这里全程走 api.github.com。
"""

import argparse
import base64
import configparser
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

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
    return repo, branch, token


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

    def get(self, path, raw=False):
        url = 'https://api.github.com' + path
        req = urllib.request.Request(url)
        req.add_header('Accept', 'application/vnd.github+json')
        req.add_header('User-Agent', 'cloudstorage-updater')
        if self.token:
            req.add_header('Authorization', 'token %s' % self.token)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise SystemExit(
                    'GitHub 拒绝访问（%d）。私有仓库需要在 config.ini 的 [UPDATE] token 填入访问令牌。'
                    % e.code)
            if e.code == 404:
                raise SystemExit('远端路径不存在（404）：%s（检查 [UPDATE] repo / branch）' % path)
            raise SystemExit('请求失败 %d：%s' % (e.code, path))
        if raw:
            return data
        return json.loads(data.decode('utf-8'))

    def text(self, path):
        return self.get(path, raw=True).decode('utf-8')


def fetch_remote_version(api, branch):
    data = api.get('/repos/%s/contents/version.py?ref=%s'
                   % (api.repo, urllib.parse.quote(branch)))
    source = base64.b64decode(data['content']).decode('utf-8')
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


def download_tree(api, branch):
    """返回 [(path, bytes)]，仅包含需要写入的文件"""
    tree = api.get('/repos/%s/git/trees/%s?recursive=1'
                   % (api.repo, urllib.parse.quote(branch, safe='')))
    if tree.get('truncated'):
        print('警告：仓库文件较多，GitHub 返回的树被截断，可能漏掉个别文件')

    files = []
    for item in tree.get('tree', []):
        if item.get('type') != 'blob':
            continue
        path = item['path']
        if should_skip(path):
            continue
        blob = api.get('/repos/%s/git/blobs/%s' % (api.repo, item['sha']))
        content = base64.b64decode(blob['content']) if blob.get('encoding') == 'base64' else blob['content'].encode()
        files.append((path, content))
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


def restart_service():
    print('尝试重启 CloudStorage 服务 ...')
    try:
        subprocess.run(['sc.exe', 'stop', 'CloudStorage'], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(3)
        rc = subprocess.run(['sc.exe', 'start', 'CloudStorage'], check=False).returncode
    except OSError as e:
        print('  重启失败：%s' % e)
        return False
    if rc != 0:
        print('  启动失败（exit %d）。请用管理员权限手动执行 Restart-Service CloudStorage。' % rc)
        return False
    print('  服务已重启')
    return True


def main():
    parser = argparse.ArgumentParser(description='CloudStorage 在线更新')
    parser.add_argument('--check', action='store_true', help='只检查版本，不写入文件')
    parser.add_argument('--restart', action='store_true', help='更新后重启 Windows 服务')
    args = parser.parse_args()

    repo, branch, token = load_config()
    local = local_version()
    print('当前版本：%s' % local)
    print('远端仓库：%s @ %s' % (repo, branch))

    api = Api(repo, token)
    try:
        remote = fetch_remote_version(api, branch)
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

    files = download_tree(api, branch)
    diff = changed_files(files)
    print('远端文件 %d 个，需要更新 %d 个' % (len(files), len(diff)))
    for path, _ in diff:
        print('  ~ %s' % path)

    if args.check:
        print('（--check 模式，未写入任何文件）')
        return 0

    for path, content in diff:
        write_file(path, content)
    print('更新完成：%d 个文件已写入' % len(diff))

    if args.restart:
        restart_service()
    else:
        print('重启服务后生效：Restart-Service CloudStorage')
    return 0


if __name__ == '__main__':
    sys.exit(main())
