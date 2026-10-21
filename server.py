import os
import re
import sys
import time
import shutil
import secrets
import hashlib
import getpass
import argparse
import logging
import threading
import traceback
import configparser
from datetime import timedelta
from flask import (Flask, render_template, request, jsonify, send_from_directory,
                   session, redirect, url_for, abort)
from flask_socketio import SocketIO, emit
from werkzeug.security import generate_password_hash, check_password_hash
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

import db
import logutil
import version

MIN_PYTHON = (3, 9)
if sys.version_info < MIN_PYTHON:
    raise SystemExit(
        "需要 Python %d.%d 或更高版本，当前是 %s。请升级 Python 后重试。"
        % (MIN_PYTHON[0], MIN_PYTHON[1], sys.version.split()[0])
    )

app = Flask(__name__)

START_TIME = time.time()

merge_tasks = {}

# 读取或自动生成 config.ini 配置
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
config_file = os.path.join(BASE_DIR, 'config.ini')

# 默认配置模板（附路径填写说明）
DEFAULT_CONFIG_INI = """[SERVER]
# 监听地址与端口 ('::' 代表同时支持 IPv4/IPv6 双栈)
host = ::
# 注意：80 / 443 已被运营商封锁，程序启动时会拒绝这两个端口
port = 5000
debug = false

[PATH]
# 存储目录：相对路径基于 server.py 所在目录，也可填绝对路径（如 G:\\CloudStorage）
upload_folder = CloudStorage/Files
# 未完成切片的临时目录
temp_dir = uploads_temp

[LIMIT]
# 单次请求体最大限制（单位：MB）
max_content_length_mb = 500

[CLEANUP]
# 未完成切片的过期停滞时间（秒），3600 秒 = 1 小时
chunk_expire_seconds = 3600
# 后台自动巡检扫描间隔（秒），300 秒 = 5 分钟
cleanup_interval_seconds = 300

[DB]
# SQLite 数据库文件（相对路径基于 server.py 所在目录）
path = CloudStorage/cloudstorage.db

[AUTH]
# 是否启用登录（true / false）
enabled = true
# 首次启动自动创建的管理员账号
admin_user = admin
# 管理员初始密码；留空则随机生成并打印到控制台（仅首次创建时使用）
admin_password =
# 会话签名密钥；留空则自动生成并写回本文件
secret =
"""

# 如果配置文件不存在，自动创建并写入默认参数
if not os.path.exists(config_file):
    print(f"未检测到配置文件，正在自动生成默认 {config_file} ...")
    try:
        with open(config_file, 'w', encoding='utf-8') as f:
            f.write(DEFAULT_CONFIG_INI.strip())
        print(f"默认配置文件生成成功！")
    except Exception as e:
        print(f"自动生成配置文件失败: {e}")
else:
    print(f"已加载配置文件: {config_file}")

# 读取配置文件
config = configparser.ConfigParser()
# utf-8-sig：兼容被记事本等编辑器存成「UTF-8 带 BOM」的配置文件
config.read(config_file, encoding='utf-8-sig')

# 解析 SERVER 配置
HOST = config.get('SERVER', 'host', fallback='::')
PORT = config.getint('SERVER', 'port', fallback=5000)
DEBUG = config.getboolean('SERVER', 'debug', fallback=False)

# ---- 鉴权配置 ----
def persist_config_value(section, key, value):
    """把某个配置项写回 config.ini：已有就替换，没有就在对应段补一行，其余注释原样保留"""
    with open(config_file, 'r', encoding='utf-8-sig') as f:
        lines = f.read().splitlines()

    header = f"[{section.lower()}]"
    in_section = False
    section_index = None
    replaced = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            in_section = stripped.lower() == header
            if in_section:
                section_index = i
            continue
        if in_section and stripped.lower().startswith(key.lower()) and '=' in stripped:
            lines[i] = f"{key} = {value}"
            replaced = True
            break

    if not replaced:
        if section_index is None:
            lines.extend(['', f'[{section}]', f'{key} = {value}'])
        else:
            lines.insert(section_index + 1, f'{key} = {value}')

    with open(config_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

# ---- Web 后台：可配置项定义 ----
# restart=True 表示写回 config.ini 后需要重启服务才生效
SETTING_SPECS = [
    {'group': '服务', 'key': 'host', 'section': 'SERVER', 'type': 'str', 'restart': True,
     'label': '监听地址', 'help': "'::' 表示 IPv4/IPv6 双栈；也可填 0.0.0.0 或具体网卡 IP"},
    {'group': '服务', 'key': 'port', 'section': 'SERVER', 'type': 'int', 'restart': True,
     'label': '监听端口', 'min': 1, 'max': 65535, 'help': '80 / 443 被运营商封锁，禁止使用'},

    {'group': '存储', 'key': 'upload_folder', 'section': 'PATH', 'type': 'path', 'restart': True,
     'label': '存储目录', 'help': '相对路径基于 server.py 所在目录，也可以填绝对路径'},
    {'group': '存储', 'key': 'temp_dir', 'section': 'PATH', 'type': 'path', 'restart': True,
     'label': '切片临时目录', 'help': '未完成分片存放处，清理线程会按下面的时间回收'},

    {'group': '限制', 'key': 'max_content_length_mb', 'section': 'LIMIT', 'type': 'int',
     'restart': False, 'label': '单次请求上限 (MB)', 'min': 1, 'max': 1048576,
     'help': '保存后立即生效，只影响之后的请求'},
    {'group': '限制', 'key': 'max_storage_mb', 'section': 'LIMIT', 'type': 'int',
     'restart': False, 'label': '存储总量上限 (MB)', 'min': 0, 'max': 10485760,
     'help': '0 表示不限制；超过后上传与合成都返回 413'},

    {'group': '清理', 'key': 'chunk_expire_seconds', 'section': 'CLEANUP', 'type': 'int',
     'restart': False, 'label': '未完成切片过期时间 (秒)', 'min': 60, 'max': 2592000},
    {'group': '清理', 'key': 'cleanup_interval_seconds', 'section': 'CLEANUP', 'type': 'int',
     'restart': False, 'label': '后台巡检间隔 (秒)', 'min': 10, 'max': 86400},

    {'group': '认证', 'key': 'enabled', 'section': 'AUTH', 'type': 'bool', 'restart': True,
     'label': '启用登录', 'help': '关闭后所有人可直接访问；改动需重启'},
    {'group': '认证', 'key': 'admin_user', 'section': 'AUTH', 'type': 'str', 'restart': True,
     'label': '管理员用户名', 'help': '仅在数据库里还没有任何用户时用于创建首个管理员'},

    {'group': '日志', 'key': 'max_total_mb', 'section': 'LOG', 'type': 'int', 'restart': False,
     'label': '日志目录上限 (MB)', 'min': 1, 'max': 102400,
     'help': 'logs 目录超过这个大小就开始删除最旧的日志'},
    {'group': '日志', 'key': 'max_age_days', 'section': 'LOG', 'type': 'int', 'restart': False,
     'label': '日志保留天数', 'min': 0, 'max': 3650, 'help': '0 表示不按时间清理'},
    {'group': '日志', 'key': 'max_files', 'section': 'LOG', 'type': 'int', 'restart': False,
     'label': '最多保留文件数', 'min': 1, 'max': 1000},
    {'group': '日志', 'key': 'check_interval_seconds', 'section': 'LOG', 'type': 'int',
     'restart': False, 'label': '日志检查间隔 (秒)', 'min': 10, 'max': 86400},
]


def validate_setting(spec, raw):
    """返回 (值, 写回文件的文本)，非法时抛 ValueError"""
    kind = spec['type']
    if kind == 'bool':
        text = str(raw).strip().lower()
        if text in ('1', 'true', 'yes', 'on'):
            return True, 'true'
        if text in ('0', 'false', 'no', 'off'):
            return False, 'false'
        raise ValueError('应为 true 或 false')
    if kind == 'int':
        try:
            value = int(str(raw).strip())
        except (TypeError, ValueError):
            raise ValueError('必须是整数')
        if 'min' in spec and value < spec['min']:
            raise ValueError(f'不能小于 {spec["min"]}')
        if 'max' in spec and value > spec['max']:
            raise ValueError(f'不能大于 {spec["max"]}')
        if spec['key'] == 'port' and value in (80, 443):
            raise ValueError('80 / 443 被运营商封锁，请换一个端口')
        return value, str(value)

    text = str(raw).strip()
    if not text:
        raise ValueError('不能为空')
    if kind == 'path':
        # 只允许相对路径或本地绝对路径；拒绝 UNC（服务无法从网络共享运行）
        if text.startswith('\\\\') or text.startswith('//'):
            raise ValueError('不支持网络路径（UNC）')
    if spec['key'] == 'host' and re.search(r'[\s/]', text):
        raise ValueError('地址里不能有空格或斜杠')
    return text, text


def update_config_values(pairs):
    """批量写回 config.ini；只改对应行，注释与顺序原样保留。pairs: {(section, key): text}"""
    with open(config_file, 'r', encoding='utf-8-sig') as f:
        lines = f.read().splitlines()

    def section_ranges():
        ranges = {}
        current = None
        for i, line in enumerate(lines):
            s = line.strip()
            if s.startswith('[') and s.endswith(']'):
                current = s[1:-1].strip().upper()
                ranges[current] = [i, i]
            elif current is not None:
                ranges[current][1] = i
        return ranges

    ranges = section_ranges()
    missing = []
    for (section, key), text in pairs.items():
        sec = section.upper()
        if sec not in ranges:
            missing.append(((section, key), text))
            continue
        start, end = ranges[sec]
        found = False
        for i in range(start + 1, end + 1):
            s = lines[i].strip()
            if s.startswith('#') or '=' not in s:
                continue
            if s.split('=', 1)[0].strip().upper() == key.upper():
                lines[i] = f'{key} = {text}'
                found = True
                break
        if not found:
            missing.append(((section, key), text))

    for (section, key), text in missing:
        ranges = section_ranges()
        sec = section.upper()
        if sec in ranges:
            lines.insert(ranges[sec][1] + 1, f'{key} = {text}')
        else:
            lines.extend(['', f'[{section}]', f'{key} = {text}'])

    with open(config_file, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def hot_apply(keys):
    """把不需要重启的配置立刻应用到内存"""
    global MAX_CONTENT_LENGTH_MB, MAX_CONTENT_LENGTH, CHUNK_EXPIRE_SECONDS, CLEANUP_INTERVAL_SECONDS
    global LOG_MAX_TOTAL_MB, LOG_MAX_AGE_DAYS, LOG_MAX_FILES, LOG_CHECK_INTERVAL, MAX_STORAGE_MB

    if 'max_content_length_mb' in keys:
        MAX_CONTENT_LENGTH_MB = config.getint('LIMIT', 'max_content_length_mb',
                                              fallback=MAX_CONTENT_LENGTH_MB)
        MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH_MB * 1024 * 1024
        app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH
    if 'max_storage_mb' in keys:
        MAX_STORAGE_MB = config.getint('LIMIT', 'max_storage_mb', fallback=MAX_STORAGE_MB)
    if 'chunk_expire_seconds' in keys:
        CHUNK_EXPIRE_SECONDS = config.getint('CLEANUP', 'chunk_expire_seconds',
                                             fallback=CHUNK_EXPIRE_SECONDS)
    if 'cleanup_interval_seconds' in keys:
        CLEANUP_INTERVAL_SECONDS = config.getint('CLEANUP', 'cleanup_interval_seconds',
                                                 fallback=CLEANUP_INTERVAL_SECONDS)
    if 'max_total_mb' in keys:
        LOG_MAX_TOTAL_MB = config.getint('LOG', 'max_total_mb', fallback=LOG_MAX_TOTAL_MB)
    if 'max_age_days' in keys:
        LOG_MAX_AGE_DAYS = config.getint('LOG', 'max_age_days', fallback=LOG_MAX_AGE_DAYS)
    if 'max_files' in keys:
        LOG_MAX_FILES = config.getint('LOG', 'max_files', fallback=LOG_MAX_FILES)
    if 'check_interval_seconds' in keys:
        LOG_CHECK_INTERVAL = config.getint('LOG', 'check_interval_seconds',
                                           fallback=LOG_CHECK_INTERVAL)


def apply_config_changes(payload):
    """校验并写回；返回 (已修改的键, 需重启的键, 错误字典)"""
    applied, restart, errors, updates = [], [], {}, {}

    for spec in SETTING_SPECS:
        key = spec['key']
        if key not in payload:
            continue
        try:
            _, text = validate_setting(spec, payload[key])
        except ValueError as e:
            errors[key] = str(e)
            continue
        current = (config.get(spec['section'], key, fallback='') or '').strip()
        if current == text:
            continue
        updates[(spec['section'], key)] = text
        applied.append(key)
        if spec['restart']:
            restart.append(key)

    if errors:
        return [], [], errors

    if updates:
        update_config_values(updates)
        config.read(config_file, encoding='utf-8-sig')
        hot_apply([k for (_, k) in updates])

    return applied, restart, errors


def config_groups():
    """给模板用的分组配置视图"""
    groups = {}
    for spec in SETTING_SPECS:
        item = {
            'key': spec['key'],
            'label': spec['label'],
            'type': spec['type'],
            'restart': spec['restart'],
            'help': spec.get('help', ''),
            'value': (config.get(spec['section'], spec['key'], fallback='') or '').strip(),
        }
        groups.setdefault(spec['group'], []).append(item)
    return [{'name': name, 'items': items} for name, items in groups.items()]


AUTH_ENABLED = config.getboolean('AUTH', 'enabled', fallback=True)
ADMIN_USER = (config.get('AUTH', 'admin_user', fallback='admin') or '').strip() or 'admin'
ADMIN_PASSWORD = (config.get('AUTH', 'admin_password', fallback='') or '').strip()

# 会话密钥：没有就生成一个并写回配置，重启服务后已登录用户不掉线
SESSION_SECRET = (config.get('AUTH', 'secret', fallback='') or '').strip()
if not SESSION_SECRET:
    SESSION_SECRET = secrets.token_hex(32)
    try:
        persist_config_value('AUTH', 'secret', SESSION_SECRET)
        print("[鉴权] 已生成会话密钥并写入 config.ini → [AUTH] secret")
    except OSError as e:
        print(f"[鉴权] 无法写入 config.ini：{e}")

SECRET_KEY = hashlib.sha256(SESSION_SECRET.encode('utf-8')).hexdigest()

# 路径解析辅助函数：优先绝对路径，未指定/相对路径则在 server 目录下拼接生成
def resolve_path(raw_path, default_relative):
    raw_path = (raw_path or '').strip()
    if raw_path and os.path.isabs(raw_path):
        return os.path.abspath(raw_path)
    rel_folder = raw_path if raw_path else default_relative
    return os.path.abspath(os.path.join(BASE_DIR, rel_folder))

# 解析 PATH 配置
UPLOAD_FOLDER = resolve_path(config.get('PATH', 'upload_folder', fallback='CloudStorage/Files'), 'CloudStorage/Files')
TEMP_DIR = resolve_path(config.get('PATH', 'temp_dir', fallback='uploads_temp'), 'uploads_temp')
TRASH_DIR = resolve_path(config.get('PATH', 'trash_dir', fallback='Trash'), 'Trash')

# 解析 LIMIT 与 CLEANUP 配置
MAX_CONTENT_LENGTH_MB = config.getint('LIMIT', 'max_content_length_mb', fallback=500)
MAX_CONTENT_LENGTH = MAX_CONTENT_LENGTH_MB * 1024 * 1024

# 存储总量上限（MB，0 = 不限制）
MAX_STORAGE_MB = config.getint('LIMIT', 'max_storage_mb', fallback=0)

CHUNK_EXPIRE_SECONDS = config.getint('CLEANUP', 'chunk_expire_seconds', fallback=3600)
CLEANUP_INTERVAL_SECONDS = config.getint('CLEANUP', 'cleanup_interval_seconds', fallback=300)

# 日志保留策略（logs 目录默认 100MB 上限，超了删最旧的）
LOG_DIR = logutil.LOG_DIR
LOG_FILE = logutil.LOG_FILE
LOG_MAX_TOTAL_MB = config.getint('LOG', 'max_total_mb', fallback=100)
LOG_MAX_AGE_DAYS = config.getint('LOG', 'max_age_days', fallback=30)
LOG_MAX_FILES = config.getint('LOG', 'max_files', fallback=20)
LOG_CHECK_INTERVAL = config.getint('LOG', 'check_interval_seconds', fallback=600)

# 单个文件允许的最大切片数，防止恶意的 totalChunks 拖死合并线程
MAX_TOTAL_CHUNKS = 10000

def is_safe_hash(file_hash):
    # 只允许纯字母、数字、短横线、下划线和点
    return bool(file_hash and re.match(r'^[a-zA-Z0-9_\-\.]+$', file_hash))

def is_safe_chunk_index(chunk_index):
    """切片序号必须是纯数字且在合理范围内（挡住 ../../ 之类的注入）"""
    return bool(chunk_index is not None
                and str(chunk_index).isdigit()
                and int(chunk_index) < MAX_TOTAL_CHUNKS)

def is_within(base, target):
    """判断 target 是否落在 base 目录内（最终防穿越校验）"""
    base_n = os.path.normcase(os.path.abspath(base))
    target_n = os.path.normcase(os.path.abspath(target))
    return target_n == base_n or target_n.startswith(base_n + os.sep)

def safe_join(base, *parts):
    """把 parts 拼到 base 下；一旦越出 base 就返回 None"""
    target = os.path.abspath(os.path.join(os.path.abspath(base), *parts))
    return target if is_within(base, target) else None

def clean_filename(raw_name):
    """只保留文件名本身，丢弃任何目录部分与特殊名"""
    if not isinstance(raw_name, str):
        return ''
    name = raw_name.replace('\\', '/').split('/')[-1].strip()
    if not name or name in ('.', '..'):
        return ''
    return name

def file_sha256(path):
    """分块计算文件 SHA-256，避免把大文件整个读进内存"""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def move_to_trash(src_path, name):
    """把文件移进回收站，返回回收站里的路径（带时间前缀，避免重名）"""
    os.makedirs(TRASH_DIR, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    target = unique_path(TRASH_DIR, f'{stamp}_{name}')
    shutil.move(src_path, target)
    return target


def unique_path(directory, filename):
    """同名文件不覆盖，自动追加 (1)、(2)…"""
    stem, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    counter = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{stem} ({counter}){ext}")
        counter += 1
    return candidate

def ensure_dir(path, label, fallback_relative):
    """尝试创建目录；不可用（例如盘符不存在）时降级到 server 目录下的固定子目录"""
    try:
        os.makedirs(path, exist_ok=True)
        return path
    except OSError as e:
        fallback = os.path.join(BASE_DIR, *fallback_relative)
        print(f"[{label}] 无法使用 {path}（{e}），自动降级到 {fallback}")
        os.makedirs(fallback, exist_ok=True)
        return fallback

# 确保必要的目录存在：存储目录与临时目录都取自 config.ini，不可用时自动降级
TEMP_DIR = ensure_dir(TEMP_DIR, '临时目录', ('uploads_temp',))
UPLOAD_FOLDER = ensure_dir(UPLOAD_FOLDER, '存储目录', ('CloudStorage', 'Files'))
TRASH_DIR = ensure_dir(TRASH_DIR, '回收站', ('Trash',))

# ---- 数据库 ----
DB_PATH = resolve_path(config.get('DB', 'path', fallback='CloudStorage/cloudstorage.db'),
                       'CloudStorage/cloudstorage.db')
try:
    db.init(DB_PATH)
except Exception as e:
    # 数据库不可用时不静默降级：直接报错退出，避免文件记录丢失
    raise SystemExit(f"[数据库] 无法初始化 {DB_PATH}：{e}")

print(f"[数据库] SQLite: {DB_PATH}")

# 首次启动：没有任何用户时创建管理员
if db.count_users() == 0:
    _initial_password = ADMIN_PASSWORD or secrets.token_urlsafe(12)
    db.create_user(ADMIN_USER, generate_password_hash(_initial_password), 'admin')
    print("=" * 64)
    print(f"[初始化] 已创建管理员账号：{ADMIN_USER}")
    if ADMIN_PASSWORD:
        print("[初始化] 密码取自 config.ini 的 [AUTH] admin_password")
    else:
        print(f"[初始化] 初始密码：{_initial_password}")
        print("[初始化] 建议登录后立即修改：python server.py --set-password admin")
    print("=" * 64)

# 更新 Flask 配置
app.config.update(
    SECRET_KEY=SECRET_KEY,
    UPLOAD_FOLDER=UPLOAD_FOLDER,
    MAX_CONTENT_LENGTH=MAX_CONTENT_LENGTH,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax',
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)

# 使用 SocketIO 支持实时推送
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode='threading',
    max_http_buffer_size=1024 * 1024 * 1024
    )

def get_file_list():
    """高效获取文件列表（以磁盘为准，叠加数据库里的上传者/上传时间）"""
    file_list = []
    base_path = app.config['UPLOAD_FOLDER']
    if not os.path.exists(base_path): 
        os.makedirs(base_path, exist_ok=True)

    try:
        records = db.latest_file_records()
    except Exception as e:
        print(f"[数据库] 读取文件记录失败: {e}")
        records = {}

    try:
        with os.scandir(base_path) as it:
            for entry in it:
                try:
                    if entry.is_file():
                        stat = entry.stat()
                        item = {
                            'name': entry.name,
                            'size': stat.st_size,
                            'mtime': stat.st_mtime
                        }
                        rec = records.get(entry.name)
                        if rec:
                            item['uploader'] = rec.get('uploader_name')
                            item['uploaded_at'] = rec.get('created_at')
                            item['sha256'] = rec.get('sha256')
                        file_list.append(item)
                except OSError:
                    continue

    except Exception as e:
        print(f"读取文件错误: {e}")
    return sorted(file_list, key=lambda x: x['mtime'], reverse=True)


def storage_usage():
    """存储目录当前占用（字节）"""
    total = 0
    try:
        with os.scandir(app.config['UPLOAD_FOLDER']) as it:
            for entry in it:
                try:
                    if entry.is_file():
                        total += entry.stat().st_size
                except OSError:
                    continue
    except OSError:
        pass
    return total


def quota_error(extra_bytes):
    """超出存储上限时返回 {'message': ...}，否则 None。max_storage_mb=0 表示不限制。"""
    if MAX_STORAGE_MB <= 0:
        return None
    limit = MAX_STORAGE_MB * 1024 * 1024
    used = storage_usage()
    if used + max(0, extra_bytes) > limit:
        return {
            'used': used,
            'limit': limit,
            'message': f"存储空间不足：已用 {used / 1048576:.1f} MB / 上限 {MAX_STORAGE_MB} MB",
        }
    return None


def async_merge_process(file_hash, raw_filename, total_chunks, target_dir, chunk_dir,
                        uploader_id=None, uploader_name=None):
    """后台线程：执行大文件合并，不阻塞主服务"""
    target_path = None
    tmp_target_path = None
    hasher = hashlib.sha256()
    try:
        merge_tasks[file_hash] = {
            'status': 'processing', 'progress': 0,
            'name': raw_filename, 'updated_at': time.time()
        }

        # 双重校验：切片目录必须在临时目录内，存储目录必须存在
        if not is_within(TEMP_DIR, chunk_dir):
            raise ValueError('切片目录越界')
        if not os.path.isdir(target_dir):
            raise ValueError('存储目录不存在')

        # 同名文件自动改名，绝不覆盖已有文件
        target_path = unique_path(target_dir, raw_filename)
        final_name = os.path.basename(target_path)
        merge_tasks[file_hash]['name'] = final_name
        tmp_target_path = target_path + '.part'

        with open(tmp_target_path, 'wb') as target_file:
            for i in range(total_chunks):
                chunk_path = os.path.join(chunk_dir, str(i))
                if not os.path.exists(chunk_path):
                    raise FileNotFoundError(f"切片 {i} 缺失，合并中断")
                if not is_within(chunk_dir, chunk_path):
                    raise ValueError(f"切片 {i} 路径越界")
                with open(chunk_path, 'rb') as f:
                    # 合并的同时计算 SHA-256，避免合并完再完整读一遍大文件
                    while True:
                        block = f.read(8 * 1024 * 1024)
                        if not block:
                            break
                        hasher.update(block)
                        target_file.write(block)
                merge_tasks[file_hash]['progress'] = int(((i + 1) / total_chunks) * 100)
                merge_tasks[file_hash]['updated_at'] = time.time()

            # 只在全部写完时落一次盘：每个切片都 fsync 会让大文件合并慢一个数量级
            target_file.flush()
            os.fsync(target_file.fileno())

        # 合并完整无误后，原子重命名
        os.replace(tmp_target_path, target_path)
        tmp_target_path = None

        if os.path.exists(chunk_dir):
            shutil.rmtree(chunk_dir, ignore_errors=True)

        # 写入文件记录（数据库只是记录，列表仍以磁盘为准）
        digest = hasher.hexdigest()
        try:
            db.add_file(name=final_name, size=os.path.getsize(target_path), sha256=digest,
                        uploader_id=uploader_id, uploader_name=uploader_name,
                        method='chunked')
        except Exception as e:
            print(f"[数据库] 写入文件记录失败（合并结果不受影响）: {e}")

        try:
            db.add_event('upload', uploader_name or 'anonymous', final_name,
                         f'{os.path.getsize(target_path)} bytes (chunked)')
        except Exception:
            pass

        merge_tasks[file_hash] = {
            'status': 'success', 'progress': 100,
            'name': final_name, 'sha256': digest, 'updated_at': time.time()
        }

        # 只广播一次
        with app.app_context():
            socketio.emit('file_update', get_file_list())

    except Exception as e:
        print(f"后台合并异常: {e}")
        traceback.print_exc()
        # 清理残余的 .part 文件；切片目录保留，便于客户端重试续传
        if tmp_target_path and os.path.exists(tmp_target_path):
            try: os.remove(tmp_target_path)
            except Exception: pass
        merge_tasks[file_hash] = {
            'status': 'error', 'message': str(e),
            'name': os.path.basename(target_path) if target_path else raw_filename,
            'updated_at': time.time()
        }

class FileChangeHandler(FileSystemEventHandler):
    """磁盘文件变动监听及防抖广播"""
    def __init__(self):
        self.timer = None
        
    def on_any_event(self, event):
        if event.is_directory: return
        if self.timer: self.timer.cancel()
        self.timer = threading.Timer(0.5, self.push_update)
        self.timer.start()
        
    def push_update(self):
        with app.app_context():
            socketio.emit('file_update', get_file_list(), namespace='/')

def auto_cleanup_stale_chunks():
    """后台定时线程：清理超时废弃切片以及内存中的过期合并任务记录"""
    print("已启动自动清理...")
    while True:
        try:
            time.sleep(CLEANUP_INTERVAL_SECONDS)
            now = time.time()

            # 1. 清理磁盘过期切片
            if os.path.exists(TEMP_DIR):
                for file_hash in os.listdir(TEMP_DIR):
                    chunk_dir = os.path.join(TEMP_DIR, file_hash)
                    if not os.path.isdir(chunk_dir):
                        continue

                    latest_mtime = os.path.getmtime(chunk_dir)
                    try:
                        for fname in os.listdir(chunk_dir):
                            fpath = os.path.join(chunk_dir, fname)
                            if os.path.isfile(fpath):
                                latest_mtime = max(latest_mtime, os.path.getmtime(fpath))
                    except Exception:
                        pass

                    idle_time = now - latest_mtime
                    if idle_time > CHUNK_EXPIRE_SECONDS:
                        print(f"[清理废弃切片] Hash: {file_hash} 已停滞 {int(idle_time)} 秒，正在删除...")
                        shutil.rmtree(chunk_dir, ignore_errors=True)

            # 2. 清理内存中保存超过 10 分钟的合并任务记录，防内存泄露
            expired_hashes = [
                h for h, info in list(merge_tasks.items())
                if now - info.get('updated_at', 0) > 600
            ]
            for h in expired_hashes:
                merge_tasks.pop(h, None)

        except Exception as e:
            print(f"[自动清理] 巡检发生异常: {e}")

# --- 访问鉴权 ---
# 页面请求未登录时跳转登录页；接口/Socket.IO 请求直接 401，避免前端拿到一段 HTML
PROTECTED_PREFIXES = ('/upload', '/download', '/socket.io')

def current_user():
    """返回当前会话对应的用户；用户被删除或被禁用时返回 None"""
    if not AUTH_ENABLED:
        return {'id': None, 'username': 'anonymous', 'role': 'admin'}
    uid = session.get('uid')
    if not uid:
        return None
    user = db.get_user_by_id(uid)
    if not user or not user.get('active', 1):
        session.clear()
        return None
    return user

@app.before_request
def require_login():
    if not AUTH_ENABLED:
        return None
    if request.endpoint in ('login', 'static', 'auth_me', 'share_download', 'healthz', 'api_version'):
        return None
    if current_user():
        return None
    if request.path.startswith(PROTECTED_PREFIXES):
        return jsonify({'status': 'error', 'message': '未登录或登录已过期'}), 401
    return redirect(url_for('login', next=request.path))

# ---- 登录失败限流（内存计数，重启清零）----
LOGIN_MAX_FAILS = 5
LOGIN_WINDOW = 15 * 60      # 15 分钟内
LOGIN_LOCK_SECONDS = 10 * 60  # 锁 10 分钟

_login_guard = {}
_login_guard_lock = threading.Lock()


def _login_key(username):
    return f"{(request.remote_addr or '?')}|{(username or '').strip().lower()}"


def login_locked_for(key):
    """返回剩余锁定秒数，0 表示未锁定"""
    now = time.time()
    with _login_guard_lock:
        state = _login_guard.get(key)
        if not state:
            return 0
        if state.get('until', 0) > now:
            return int(state['until'] - now)
        if now - state.get('first', 0) > LOGIN_WINDOW:
            _login_guard.pop(key, None)
        return 0


def login_record_fail(key):
    now = time.time()
    with _login_guard_lock:
        # 顺带清理过大的表，避免长期运行后无限增长
        if len(_login_guard) > 2000:
            for k, v in list(_login_guard.items()):
                if now - v.get('first', 0) > LOGIN_WINDOW and v.get('until', 0) <= now:
                    _login_guard.pop(k, None)

        state = _login_guard.get(key)
        if not state or now - state.get('first', 0) > LOGIN_WINDOW:
            state = {'count': 0, 'first': now, 'until': 0}
        state['count'] += 1
        if state['count'] >= LOGIN_MAX_FAILS:
            state['until'] = now + LOGIN_LOCK_SECONDS
            state['count'] = 0
            state['first'] = now
            print(f"[登录] {key} 连续失败 {LOGIN_MAX_FAILS} 次，锁定 {LOGIN_LOCK_SECONDS // 60} 分钟")
        _login_guard[key] = state


def login_record_success(key):
    with _login_guard_lock:
        _login_guard.pop(key, None)


@app.route('/login', methods=['GET', 'POST'])
def login():
    if not AUTH_ENABLED:
        return redirect(url_for('index'))

    error = None
    username = ''
    if request.method == 'POST':
        username = (request.form.get('username') or '').strip()
        password = request.form.get('password') or ''
        key = _login_key(username)

        wait = login_locked_for(key)
        if wait:
            error = f'登录失败次数过多，请 {max(1, (wait + 59) // 60)} 分钟后再试'
            return render_template('login.html', error=error,
                                   next=request.args.get('next', ''), username=username), 429

        user = db.get_user(username) if username else None
        if user and not user.get('active', 1):
            login_record_fail(key)
            error = '账号已被禁用，请联系管理员'
        elif user and check_password_hash(user['password_hash'], password):
            login_record_success(key)
            session.clear()
            session['uid'] = user['id']
            session['username'] = user['username']
            session['role'] = user['role']
            session.permanent = True
            db.touch_login(user['id'])
            audit('login', user['username'])
            target = request.values.get('next') or '/'
            # 只允许跳回站内路径，避免开放重定向
            if not target.startswith('/') or target.startswith('//'):
                target = '/'
            return redirect(target)
        else:
            login_record_fail(key)
            audit('login_failed', username or '-')
            # 不区分「用户不存在」和「密码错误」，避免账号枚举
            error = '用户名或密码不正确'

    return render_template('login.html', error=error,
                           next=request.args.get('next', ''), username=username)

@app.route('/logout')
def logout():
    session.clear()
    if not AUTH_ENABLED:
        return redirect(url_for('index'))
    return redirect(url_for('login'))

@app.route('/auth/me')
def auth_me():
    """供前端判断当前会话是否仍然有效"""
    user = current_user() if AUTH_ENABLED else None
    return jsonify({
        'authenticated': bool(user),
        'username': user['username'] if user else None,
        'role': user['role'] if user else None,
    })

# ---------------------------------------------------------------- 管理后台
def _require_admin():
    user = current_user()
    if not user or user.get('role') != 'admin':
        abort(403)
    return user


def _csrf_token():
    token = session.get('csrf')
    if not token:
        token = secrets.token_urlsafe(24)
        session['csrf'] = token
    return token


def _csrf_ok():
    token = session.get('csrf')
    return bool(token) and request.headers.get('X-CSRF-Token') == token


def audit(action, target='', detail=''):
    """记一条审计事件；失败不影响主流程"""
    try:
        user = current_user()
        actor = user['username'] if user else 'anonymous'
        db.add_event(action, actor, target, detail, request.remote_addr or '')
    except Exception as e:
        print(f"[审计] 记录失败: {e}")


@app.route('/admin/events')
def admin_events():
    _require_admin()
    try:
        limit = max(1, min(int(request.args.get('limit', 100)), 500))
    except (TypeError, ValueError):
        limit = 100
    return jsonify({'events': db.list_events(limit)})


@app.route('/admin')
def admin_page():
    user = _require_admin()
    try:
        stats = db.stats()
    except Exception:
        stats = {'files': 0, 'bytes': 0, 'users': 0}
    try:
        db_size = os.path.getsize(DB_PATH)
    except OSError:
        db_size = 0

    info = {
        'version': version.VERSION,
        'host': HOST,        'port': PORT,
        'upload_folder': UPLOAD_FOLDER,
        'temp_dir': TEMP_DIR,
        'db_path': DB_PATH,
        'db_size': db_size,
        'config_path': config_file,
        'log_path': os.path.join(BASE_DIR, 'logs', 'cloudstorage.log'),
        'uptime': int(time.time() - START_TIME),
        'storage_used': storage_usage(),
        'storage_limit': MAX_STORAGE_MB,
        'files': stats.get('files', 0),
        'bytes': stats.get('bytes', 0),
        'users': stats.get('users', 0),
    }
    return render_template('admin.html', user=user, csrf=_csrf_token(),
                           groups=config_groups(), info=info)


@app.route('/admin/config', methods=['POST'])
def admin_save_config():
    _require_admin()
    if not _csrf_ok():
        return jsonify({'ok': False, 'message': '页面已过期，请刷新后重试'}), 400

    payload = request.get_json(silent=True) or {}
    applied, restart, errors = apply_config_changes(payload)
    if errors:
        return jsonify({'ok': False, 'message': '有配置项未通过校验', 'errors': errors}), 400
    if not applied:
        return jsonify({'ok': True, 'message': '没有改动', 'restart': []})

    audit('config', '', ','.join(applied))

    message = f'已保存 {len(applied)} 项'
    if restart:
        message += '，其中 ' + '、'.join(restart) + ' 需要重启服务后生效'
    return jsonify({'ok': True, 'message': message, 'applied': applied, 'restart': restart})


@app.route('/admin/password', methods=['POST'])
def admin_change_password():
    user = _require_admin()
    if not _csrf_ok():
        return jsonify({'ok': False, 'message': '页面已过期，请刷新后重试'}), 400

    data = request.get_json(silent=True) or {}
    old = data.get('old') or ''
    new = data.get('new') or ''

    row = db.get_user_by_id(user['id'])
    if not row or not check_password_hash(row['password_hash'], old):
        return jsonify({'ok': False, 'message': '当前密码不正确'}), 400
    if len(new) < 6:
        return jsonify({'ok': False, 'message': '新密码至少 6 位'}), 400
    if len(new) > 128:
        return jsonify({'ok': False, 'message': '新密码太长'}), 400

    db.set_password(user['id'], generate_password_hash(new))
    return jsonify({'ok': True, 'message': '密码已更新，下次登录请使用新密码'})


# ---- 用户管理 ----
USERNAME_RE = re.compile(r'^[A-Za-z0-9_.\-]{3,32}$')


def _user_public(row):
    return {
        'id': row['id'],
        'username': row['username'],
        'role': row['role'],
        'active': bool(row.get('active', 1)),
        'created_at': row['created_at'],
        'last_login_at': row['last_login_at'],
    }


@app.route('/admin/users')
def admin_users():
    _require_admin()
    return jsonify({'users': [_user_public(r) for r in db.list_users()]})


@app.route('/admin/users/create', methods=['POST'])
def admin_users_create():
    me = _require_admin()
    if not _csrf_ok():
        return jsonify({'ok': False, 'message': '页面已过期，请刷新后重试'}), 400

    data = request.get_json(silent=True) or {}
    username = (data.get('username') or '').strip()
    password = data.get('password') or ''
    role = 'admin' if data.get('role') == 'admin' else 'user'

    if not USERNAME_RE.match(username):
        return jsonify({'ok': False, 'message': '用户名需为 3-32 位字母/数字/下划线/点/横线'}), 400
    if len(password) < 6:
        return jsonify({'ok': False, 'message': '密码至少 6 位'}), 400
    if db.get_user(username):
        return jsonify({'ok': False, 'message': '用户名已存在'}), 409

    db.create_user(username, generate_password_hash(password), role)
    audit('user_create', username, role)
    print(f"[用户] {me['username']} 创建了 {username}（{role}）")
    return jsonify({'ok': True, 'message': f'已创建 {username}'})


@app.route('/admin/users/password', methods=['POST'])
def admin_users_password():
    me = _require_admin()
    if not _csrf_ok():
        return jsonify({'ok': False, 'message': '页面已过期，请刷新后重试'}), 400

    data = request.get_json(silent=True) or {}
    try:
        uid = int(data.get('id'))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'message': '用户 ID 非法'}), 400
    password = data.get('password') or ''
    if len(password) < 6:
        return jsonify({'ok': False, 'message': '密码至少 6 位'}), 400

    row = db.get_user_by_id(uid)
    if not row:
        return jsonify({'ok': False, 'message': '用户不存在'}), 404

    db.set_password(uid, generate_password_hash(password))
    audit('user_password', row['username'])
    print(f"[用户] {me['username']} 重置了 {row['username']} 的密码")
    return jsonify({'ok': True, 'message': f"已重置 {row['username']} 的密码"})


@app.route('/admin/users/update', methods=['POST'])
def admin_users_update():
    me = _require_admin()
    if not _csrf_ok():
        return jsonify({'ok': False, 'message': '页面已过期，请刷新后重试'}), 400

    data = request.get_json(silent=True) or {}
    try:
        uid = int(data.get('id'))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'message': '用户 ID 非法'}), 400

    row = db.get_user_by_id(uid)
    if not row:
        return jsonify({'ok': False, 'message': '用户不存在'}), 404

    role = row['role']
    if 'role' in data:
        role = 'admin' if data.get('role') == 'admin' else 'user'
    active = bool(data.get('active', row.get('active', 1)))

    # 保护：不能把自己降级/禁用，也不能把最后一个管理员干掉
    if uid == me['id'] and (role != 'admin' or not active):
        return jsonify({'ok': False, 'message': '不能禁用或降级当前登录的管理员'}), 400
    if row['role'] == 'admin' and (role != 'admin' or not active) and db.count_admins() <= 1:
        return jsonify({'ok': False, 'message': '至少要保留一个启用的管理员'}), 400

    db.set_role(uid, role)
    db.set_active(uid, active)
    audit('user_update', row['username'], f'role={role} active={active}')
    print(f"[用户] {me['username']} 更新了 {row['username']}：role={role} active={active}")
    return jsonify({'ok': True, 'message': '已保存'})


@app.route('/admin/users/delete', methods=['POST'])
def admin_users_delete():
    me = _require_admin()
    if not _csrf_ok():
        return jsonify({'ok': False, 'message': '页面已过期，请刷新后重试'}), 400

    data = request.get_json(silent=True) or {}
    try:
        uid = int(data.get('id'))
    except (TypeError, ValueError):
        return jsonify({'ok': False, 'message': '用户 ID 非法'}), 400
    if uid == me['id']:
        return jsonify({'ok': False, 'message': '不能删除当前登录的账号'}), 400

    row = db.get_user_by_id(uid)
    if not row:
        return jsonify({'ok': False, 'message': '用户不存在'}), 404
    if row['role'] == 'admin' and db.count_admins() <= 1:
        return jsonify({'ok': False, 'message': '至少要保留一个启用的管理员'}), 400

    db.delete_user(uid)
    audit('user_delete', row['username'])
    print(f"[用户] {me['username']} 删除了 {row['username']}")
    return jsonify({'ok': True, 'message': f"已删除 {row['username']}"})


# --- Socket.IO 事件绑定 ---
@socketio.on('connect')
def on_connect():
    # 未登录直接拒绝握手
    if AUTH_ENABLED and not current_user():
        return False
    emit('file_update', get_file_list())

@socketio.on('get_files')
def handle_get_files():
    if AUTH_ENABLED and not current_user():
        return
    emit('file_update', get_file_list())

# --- HTTP 路由服务 ---
@app.route('/')
def index():
    user = current_user()
    return render_template('index.html',
                           is_admin=bool(user and user.get('role') == 'admin'))

# 检查已上传的切片 (断点续传)
@app.route('/upload/check', methods=['GET'])
def check_chunks():
    file_hash = request.args.get('fileHash')
    if not is_safe_hash(file_hash):
        return jsonify({'uploadedChunks': []})

    chunk_dir = safe_join(TEMP_DIR, file_hash)
    if chunk_dir is None:
        return jsonify({'uploadedChunks': []})

    uploaded_chunks = []
    
    if os.path.exists(chunk_dir):
        try:
            for fname in os.listdir(chunk_dir):
                if fname.isdigit():
                    uploaded_chunks.append(int(fname))
        except Exception as e:
            print(f"读取切片目录失败: {e}")
            
    return jsonify({'uploadedChunks': uploaded_chunks})

# 接收切片
@app.route('/upload/chunk', methods=['POST'])
def upload_chunk():
    try:
        # 两种上传方式：
        #   raw       —— 请求体就是切片本身，元数据放 X-File-Hash / X-Chunk-Index 头
        #                （省掉 multipart 解析和一次临时文件落盘，大文件快很多）
        #   multipart —— 旧前端用的 form-data，保留兼容
        raw_mode = (request.headers.get('X-Upload-Mode') or '').lower() == 'raw'

        if raw_mode:
            file_hash = request.headers.get('X-File-Hash')
            chunk_index = request.headers.get('X-Chunk-Index')
            source = request.stream
            if request.content_length is None:
                return jsonify({'status': 'error', 'message': '缺少 Content-Length'}), 411
        else:
            file = request.files.get('chunk')
            file_hash = request.form.get('fileHash')
            chunk_index = request.form.get('chunkIndex')
            source = file.stream if file else None

        if not source or not file_hash or chunk_index is None:
            return jsonify({'status': 'error', 'message': '参数不完整'}), 400
        # 关键校验：hash 与序号都必须干净，否则会把文件写到临时目录之外
        if not is_safe_hash(file_hash):
            return jsonify({'status': 'error', 'message': 'fileHash 非法'}), 400
        if not is_safe_chunk_index(chunk_index):
            return jsonify({'status': 'error', 'message': 'chunkIndex 非法'}), 400

        chunk_dir = safe_join(TEMP_DIR, file_hash)
        if chunk_dir is None:
            return jsonify({'status': 'error', 'message': '路径非法'}), 400
        os.makedirs(chunk_dir, exist_ok=True)

        chunk_path = safe_join(chunk_dir, str(int(chunk_index)))
        if chunk_path is None:
            return jsonify({'status': 'error', 'message': '路径非法'}), 400

        # 先写 .part 再原子改名：断点续传时绝不会把写了一半的切片当成“已完成”
        part_path = chunk_path + '.part'
        try:
            with open(part_path, 'wb') as f:
                shutil.copyfileobj(source, f, length=4 * 1024 * 1024)
                f.flush()
                os.fsync(f.fileno())
            os.replace(part_path, chunk_path)
        except Exception:
            try:
                os.remove(part_path)
            except OSError:
                pass
            raise

        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"[切片保存失败] Index: {request.headers.get('X-Chunk-Index') or request.form.get('chunkIndex')}, Error:")
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': '切片保存失败'}), 500
    
# 合并切片并写入主存储文件夹
@app.route('/upload/merge', methods=['POST'])
def merge_chunks():
    try:
        data = request.get_json(silent=True) or {}
        file_hash = data.get('fileHash')
        file_name = data.get('fileName')

        try:
            total_chunks = int(data.get('totalChunks', 0))
        except (TypeError, ValueError):
            return jsonify({'status': 'error', 'message': 'totalChunks 非法'}), 400

        if not is_safe_hash(file_hash):
            return jsonify({'status': 'error', 'message': 'fileHash 非法'}), 400

        raw_filename = clean_filename(file_name) or f"file_{int(time.time())}"

        if total_chunks <= 0 or total_chunks > MAX_TOTAL_CHUNKS:
            return jsonify({'status': 'error', 'message': 'totalChunks 超出范围'}), 400

        chunk_dir = safe_join(TEMP_DIR, file_hash)
        if chunk_dir is None:
            return jsonify({'status': 'error', 'message': '路径非法'}), 400

        # 合并前先确认切片齐全，缺片立即返回，避免后台线程白跑
        missing = [i for i in range(total_chunks)
                   if not os.path.exists(os.path.join(chunk_dir, str(i)))]
        if missing:
            preview = ', '.join(str(i) for i in missing[:10])
            return jsonify({
                'status': 'error',
                'message': f'缺少 {len(missing)} 个切片（如 {preview}），无法合并'
            }), 400

        # 同一个文件正在合并时不要再起一个线程，避免两个线程写同一个目标
        if merge_tasks.get(file_hash, {}).get('status') == 'processing':
            return jsonify({'status': 'error', 'message': '该文件正在合并中，请稍候'}), 409

        # 合并前检查存储配额（切片大小之和就是最终文件大小）
        total_size = 0
        for i in range(total_chunks):
            try:
                total_size += os.path.getsize(os.path.join(chunk_dir, str(i)))
            except OSError:
                pass
        quota = quota_error(total_size)
        if quota:
            return jsonify({'status': 'error', 'message': quota['message']}), 413

        # 开启后台线程独立合并（带上上传者，成功后写入文件记录）
        user = current_user() or {}
        t = threading.Thread(
            target=async_merge_process,
            args=(file_hash, raw_filename, total_chunks, app.config['UPLOAD_FOLDER'], chunk_dir),
            kwargs={'uploader_id': user.get('id'), 'uploader_name': user.get('username')},
        )
        t.daemon = True
        t.start()

        return jsonify({'status': 'processing', 'message': '已进入后台合并队列'}), 202
    except Exception as e:
        print(f"[合并请求失败] {e}")
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': '合并请求失败'}), 500

@app.route('/upload/merge_status', methods=['GET'])
def get_merge_status():
    file_hash = request.args.get('fileHash')
    task_info = merge_tasks.get(file_hash, {'status': 'not_found'})
    return jsonify(task_info)

# 普通小文件直接上传备用接口
@app.route('/upload', methods=['POST'])
def upload_file():
    try:
        if 'file' not in request.files:
            return jsonify({'status': 'error', 'message': '未找到文件'}), 400
        
        file = request.files['file']
        if file.filename == '':
            return jsonify({'status': 'error', 'message': '未选择文件'}), 400

        # 用 Content-Length 作为上界，超配额直接拒绝（比写完再回滚省事）
        quota = quota_error(request.content_length or 0)
        if quota:
            return jsonify({'status': 'error', 'message': quota['message']}), 413

        if file:
            raw_filename = clean_filename(file.filename) or f"file_{int(time.time())}"
            # 同名文件自动加 (1) 后缀，不再静默覆盖
            file_path = unique_path(app.config['UPLOAD_FOLDER'], raw_filename)
            file.save(file_path)

            user = current_user() or {}
            try:
                db.add_file(name=os.path.basename(file_path),
                            size=os.path.getsize(file_path),
                            sha256=file_sha256(file_path),
                            uploader_id=user.get('id'),
                            uploader_name=user.get('username'),
                            method='single')
            except Exception as e:
                print(f"[数据库] 写入文件记录失败（上传结果不受影响）: {e}")

            with app.app_context():
                socketio.emit('file_update', get_file_list())
            audit('upload', os.path.basename(file_path), f'{os.path.getsize(file_path)} bytes')
            return jsonify({'status': 'success', 'message': '文件上传成功',
                            'name': os.path.basename(file_path)})
    except Exception as e:
        print(f"上传出错: {e}")
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': '上传失败'}), 500

# ---------------------------------------------------------------- 健康检查
@app.route('/healthz')
def healthz():
    """供监控/网关探活，不需要登录。任何一项失败返回 503。"""
    checks = {}
    ok = True

    try:
        stats = db.stats()
        checks['db'] = f"ok ({stats['files']} files, {stats['users']} users)"
    except Exception as e:
        ok = False
        checks['db'] = f'error: {e}'

    try:
        os.makedirs(TEMP_DIR, exist_ok=True)
        probe = os.path.join(TEMP_DIR, '.health_probe')
        with open(probe, 'w', encoding='utf-8') as f:
            f.write('ok')
        os.remove(probe)
        checks['storage'] = 'ok'
    except OSError as e:
        ok = False
        checks['storage'] = f'error: {e}'

    if not os.path.isdir(app.config['UPLOAD_FOLDER']):
        ok = False
        checks['upload_dir'] = 'missing'
    else:
        checks['upload_dir'] = 'ok'

    return jsonify({
        'ok': ok,
        'version': version.VERSION,
        'uptime': int(time.time() - START_TIME),
        'checks': checks,
    }), (200 if ok else 503)


@app.route('/api/version')
def api_version():
    return jsonify({
        'version': version.VERSION,
        'python': sys.version.split()[0],
        'uptime': int(time.time() - START_TIME),
    })


# 文件下载路由
@app.route('/download/<path:filename>')
def download(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename, as_attachment=True)


# ---------------------------------------------------------------- 分享链接
SHARE_TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')


def _share_valid(row):
    """返回 (是否有效, 原因)"""
    if not row:
        return False, 'not_found'
    if row.get('expires_at') and row['expires_at'] < time.time():
        return False, 'expired'
    if row.get('max_downloads') and row['downloads'] >= row['max_downloads']:
        return False, 'used_up'
    return True, ''


@app.route('/s/<token>')
def share_download(token):
    if not SHARE_TOKEN_RE.match(token or ''):
        abort(404)
    row = db.get_share(token)
    ok, reason = _share_valid(row)
    if not ok:
        abort(410 if reason != 'not_found' else 404)

    path = safe_join(app.config['UPLOAD_FOLDER'], row['file_name'])
    if path is None or not os.path.isfile(path):
        abort(404)

    db.touch_share(token)
    return send_from_directory(app.config['UPLOAD_FOLDER'], row['file_name'], as_attachment=True)


@app.route('/api/shares', methods=['GET', 'POST'])
def api_shares():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    if request.method == 'GET':
        name = clean_filename(request.args.get('name'))
        rows = db.list_shares(name) if name else db.list_shares()
        now = time.time()
        items = []
        for r in rows:
            ok, reason = _share_valid(r)
            items.append({
                'token': r['token'],
                'name': r['file_name'],
                'url': f'/s/{r["token"]}',
                'created_at': r['created_at'],
                'expires_at': r['expires_at'],
                'max_downloads': r['max_downloads'],
                'downloads': r['downloads'],
                'active': ok,
                'reason': reason,
            })
        return jsonify({'items': items})

    data = request.get_json(silent=True) or {}
    name = clean_filename(data.get('name'))
    if not name:
        return jsonify({'status': 'error', 'message': '文件名非法'}), 400

    path = safe_join(app.config['UPLOAD_FOLDER'], name)
    if path is None or not os.path.isfile(path):
        return jsonify({'status': 'error', 'message': '文件不存在'}), 404

    try:
        hours = float(data.get('expire_hours') or 0)
    except (TypeError, ValueError):
        hours = 0
    try:
        max_downloads = int(data.get('max_downloads') or 0)
    except (TypeError, ValueError):
        max_downloads = 0
    max_downloads = max(0, min(max_downloads, 100000))

    expires_at = time.time() + hours * 3600 if hours > 0 else None
    token = secrets.token_urlsafe(16)
    db.create_share(token, name, user['username'], expires_at, max_downloads)
    audit('share', name)
    print(f"[分享] {user['username']} 分享了 {name}（{hours or '永久'} 小时 / {max_downloads or '不限'} 次）")
    return jsonify({'status': 'success', 'url': f'/s/{token}', 'token': token})


@app.route('/api/shares/revoke', methods=['POST'])
def api_share_revoke():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    token = (request.get_json(silent=True) or {}).get('token') or ''
    if not SHARE_TOKEN_RE.match(token):
        return jsonify({'status': 'error', 'message': '链接非法'}), 400
    db.delete_share(token)
    audit('share_revoke', token)
    print(f"[分享] {user['username']} 取消了一个分享链接")
    return jsonify({'status': 'success'})



# 删除文件：移动到回收站（可从后台恢复）
@app.route('/files/delete', methods=['POST'])
def delete_file():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    data = request.get_json(silent=True) or {}
    name = clean_filename(data.get('name'))
    if not name:
        return jsonify({'status': 'error', 'message': '文件名非法'}), 400

    src = safe_join(app.config['UPLOAD_FOLDER'], name)
    if src is None or not os.path.isfile(src):
        return jsonify({'status': 'error', 'message': '文件不存在'}), 404

    try:
        trashed = move_to_trash(src, name)
    except OSError as e:
        print(f"[删除] 移动到回收站失败: {e}")
        return jsonify({'status': 'error', 'message': '删除失败'}), 500

    try:
        db.mark_deleted(name)
    except Exception as e:
        print(f"[数据库] 标记删除失败: {e}")

    # 文件都没了，指向它的分享链接一并作废
    try:
        db.delete_shares_for(name)
    except Exception as e:
        print(f"[数据库] 清理分享链接失败: {e}")

    audit('delete', name)
    print(f"[删除] {name} -> {os.path.basename(trashed)}（操作人 {user['username']}）")
    with app.app_context():
        socketio.emit('file_update', get_file_list())
    return jsonify({'status': 'success', 'message': '已移到回收站', 'trash': os.path.basename(trashed)})


# 重命名文件
@app.route('/files/rename', methods=['POST'])
def rename_file():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    data = request.get_json(silent=True) or {}
    old = clean_filename(data.get('name'))
    new = clean_filename(data.get('newName'))
    if not old or not new:
        return jsonify({'status': 'error', 'message': '文件名非法'}), 400
    if old == new:
        return jsonify({'status': 'success', 'name': new})

    src = safe_join(app.config['UPLOAD_FOLDER'], old)
    if src is None or not os.path.isfile(src):
        return jsonify({'status': 'error', 'message': '文件不存在'}), 404

    dst = safe_join(app.config['UPLOAD_FOLDER'], new)
    if dst is None:
        return jsonify({'status': 'error', 'message': '文件名非法'}), 400
    if os.path.exists(dst):
        return jsonify({'status': 'error', 'message': '同名文件已存在'}), 409

    try:
        os.rename(src, dst)
    except OSError as e:
        print(f"[重命名] 失败: {e}")
        return jsonify({'status': 'error', 'message': '重命名失败'}), 500

    try:
        db.rename_file(old, new)
    except Exception as e:
        print(f"[数据库] 同步重命名失败: {e}")

    audit('rename', old, f'-> {new}')
    print(f"[重命名] {old} -> {new}（操作人 {user['username']}）")
    with app.app_context():
        socketio.emit('file_update', get_file_list())
    return jsonify({'status': 'success', 'name': new})


# ---------------------------------------------------------------- 回收站
TRASH_NAME_RE = re.compile(r'^\d{8}-\d{6}_(.+)$')


def trash_original_name(name):
    """从回收站文件名还原原始文件名：20261022-120000_xxx.txt -> xxx.txt"""
    m = TRASH_NAME_RE.match(name)
    return m.group(1) if m else name


def _trash_entries():
    items = []
    if not os.path.isdir(TRASH_DIR):
        return items
    for entry in os.scandir(TRASH_DIR):
        try:
            if not entry.is_file():
                continue
            st = entry.stat()
        except OSError:
            continue
        items.append({
            'trash': entry.name,
            'name': trash_original_name(entry.name),
            'size': st.st_size,
            'mtime': st.st_mtime,
        })
    items.sort(key=lambda x: x['mtime'], reverse=True)
    return items


@app.route('/trash')
def trash_page():
    user = current_user()
    if not user:
        return redirect(url_for('login', next='/trash'))
    return render_template('trash.html', user=user)


@app.route('/api/trash')
def api_trash():
    if not current_user():
        return jsonify({'status': 'error', 'message': '未登录'}), 401
    return jsonify({'items': _trash_entries()})


@app.route('/trash/restore', methods=['POST'])
def trash_restore():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    name = clean_filename((request.get_json(silent=True) or {}).get('trash'))
    if not name:
        return jsonify({'status': 'error', 'message': '文件名非法'}), 400

    src = safe_join(TRASH_DIR, name)
    if src is None or not os.path.isfile(src):
        return jsonify({'status': 'error', 'message': '回收站里没有这个文件'}), 404

    target = unique_path(UPLOAD_FOLDER, trash_original_name(name))
    try:
        shutil.move(src, target)
    except OSError as e:
        print(f"[回收站] 恢复失败: {e}")
        return jsonify({'status': 'error', 'message': '恢复失败'}), 500

    try:
        db.restore_record(os.path.basename(target))
    except Exception as e:
        print(f"[数据库] 恢复记录失败: {e}")

    audit('restore', os.path.basename(target))
    print(f"[回收站] 恢复 {name} -> {os.path.basename(target)}（操作人 {user['username']}）")
    with app.app_context():
        socketio.emit('file_update', get_file_list())
    return jsonify({'status': 'success', 'name': os.path.basename(target)})


@app.route('/trash/purge', methods=['POST'])
def trash_purge():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    name = clean_filename((request.get_json(silent=True) or {}).get('trash'))
    if not name:
        return jsonify({'status': 'error', 'message': '文件名非法'}), 400

    path = safe_join(TRASH_DIR, name)
    if path is None or not os.path.isfile(path):
        return jsonify({'status': 'error', 'message': '回收站里没有这个文件'}), 404
    try:
        os.remove(path)
    except OSError as e:
        print(f"[回收站] 彻底删除失败: {e}")
        return jsonify({'status': 'error', 'message': '删除失败'}), 500

    audit('purge', name)
    print(f"[回收站] 彻底删除 {name}（操作人 {user['username']}）")
    return jsonify({'status': 'success'})


@app.route('/trash/empty', methods=['POST'])
def trash_empty():
    user = current_user()
    if not user:
        return jsonify({'status': 'error', 'message': '未登录'}), 401

    removed, failed = 0, 0
    for item in _trash_entries():
        path = safe_join(TRASH_DIR, item['trash'])
        if path is None:
            continue
        try:
            os.remove(path)
            removed += 1
        except OSError:
            failed += 1

    audit('trash_empty', '', f'removed={removed} failed={failed}')
    print(f"[回收站] 清空：删除 {removed} 个，失败 {failed} 个（操作人 {user['username']}）")
    return jsonify({'status': 'success', 'removed': removed, 'failed': failed})


# ---------------------------------------------------------------- 命令行工具
def cli_list_users():
    rows = db.list_users()
    if not rows:
        print("还没有任何用户")
        return
    print(f"{'ID':<4}{'用户名':<20}{'角色':<8}{'最后登录'}")
    for row in rows:
        last = time.strftime('%Y-%m-%d %H:%M', time.localtime(row['last_login_at'])) if row['last_login_at'] else '-'
        print(f"{row['id']:<4}{row['username']:<20}{row['role']:<8}{last}")


def read_new_password(username, preset=None):
    """读取新密码：优先用 --password 或环境变量（便于脚本化），否则交互式输入两次"""
    if preset:
        return preset
    env = os.environ.get('CLOUDSTORAGE_PASSWORD')
    if env:
        return env
    password = getpass.getpass(f"为 {username} 设置密码：")
    confirm = getpass.getpass("再输入一次：")
    if password != confirm:
        print("两次输入不一致")
        return None
    return password


def cli_create_user(username, role='user', password=None):
    if db.get_user(username):
        print(f"用户已存在：{username}")
        return 1
    password = read_new_password(username, password)
    if password is None:
        return 1
    if len(password) < 6:
        print("密码至少 6 位")
        return 1
    db.create_user(username, generate_password_hash(password), role)
    print(f"已创建用户：{username}（角色：{role}）")
    return 0


def cli_set_password(username, password=None):
    user = db.get_user(username)
    if not user:
        print(f"用户不存在：{username}")
        return 1
    password = read_new_password(username, password)
    if password is None:
        return 1
    if len(password) < 6:
        print("密码至少 6 位")
        return 1
    db.set_password(user['id'], generate_password_hash(password))
    print(f"已更新 {username} 的密码")
    return 0


def run_cli(argv):
    parser = argparse.ArgumentParser(description='CloudStorage 服务 / 账号管理')
    parser.add_argument('--list-users', action='store_true', help='列出所有用户')
    parser.add_argument('--create-user', metavar='USERNAME', help='创建普通用户')
    parser.add_argument('--create-admin', metavar='USERNAME', help='创建管理员')
    parser.add_argument('--set-password', metavar='USERNAME', help='修改指定用户的密码')
    parser.add_argument('--password', metavar='PASSWORD',
                        help='配合创建/改密使用（不填则交互式输入）')
    args = parser.parse_args(argv)

    if args.list_users:
        cli_list_users()
        return 0
    if args.create_user:
        return cli_create_user(args.create_user, 'user', args.password)
    if args.create_admin:
        return cli_create_user(args.create_admin, 'admin', args.password)
    if args.set_password:
        return cli_set_password(args.set_password, args.password)
    return None


def validate_bind_port():
    """80/443 会被运营商封锁，配置到这两个端口时直接拒绝启动"""
    if not isinstance(PORT, int) or not (1 <= PORT <= 65535):
        raise SystemExit(f"[端口] 配置的端口 {PORT} 无效，应在 1-65535 之间")
    if PORT in (80, 443):
        raise SystemExit(
            f"[端口] {PORT} 是 80/443，运营商已封锁这两个端口。\n"
            f"       请把 config.ini 的 [SERVER] port 改成 5000 / 8080 / 8443 等端口后再启动。"
        )


def _log_maintenance_msg(msg):
    """日志维护自己的消息：总是写进日志文件；控制台模式下同时打印"""
    logging.getLogger('cloudstorage').info(msg)
    if not isinstance(sys.stdout, logutil._StreamToLogger):
        print(msg)


def prune_logs_now(reason=''):
    """按当前策略清理日志，返回被删掉的文件名列表"""
    removed = logutil.prune_logs(
        max_total_bytes=LOG_MAX_TOTAL_MB * 1024 * 1024,
        max_age_days=LOG_MAX_AGE_DAYS,
        max_files=LOG_MAX_FILES,
    )
    if removed:
        msg = f"[日志] 已清理 {len(removed)} 个旧日志（{', '.join(removed)}）"
        if reason:
            msg += f"，原因：{reason}"
        _log_maintenance_msg(msg)
    return removed


def start_log_maintenance():
    """后台线程：定时检查 logs 目录的文件数与总大小，超标就删最旧的"""

    def loop():
        # 启动时先扫一遍，避免上次异常退出留下的堆积
        try:
            prune_logs_now('启动检查')
        except Exception as e:
            _log_maintenance_msg(f"[日志] 启动检查失败: {e}")

        while True:
            try:
                time.sleep(max(10, LOG_CHECK_INTERVAL))
                total = logutil.dir_size()
                limit = LOG_MAX_TOTAL_MB * 1024 * 1024
                if total > limit:
                    prune_logs_now(f'目录 {total / 1024 / 1024:.1f}MB 超过上限 {LOG_MAX_TOTAL_MB}MB')
                else:
                    # 未超限也可能有过期文件，按文件数与天数清理
                    prune_logs_now()
            except Exception as e:
                _log_maintenance_msg(f"[日志] 巡检异常: {e}")

    thread = threading.Thread(target=loop, daemon=True, name='log-maintenance')
    thread.start()
    _log_maintenance_msg(
        f"[启动] 日志巡检已开启（上限 {LOG_MAX_TOTAL_MB}MB / 保留 {LOG_MAX_AGE_DAYS} 天 / 每 {LOG_CHECK_INTERVAL}s 检查）")
    return thread


def start_background_workers():
    """启动 watchdog、切片清理与日志巡检线程（命令行运行与服务模式共用）"""
    try:
        observer = Observer()
        observer.schedule(FileChangeHandler(), app.config['UPLOAD_FOLDER'], recursive=False)
        observer.start()
        print("[启动] 文件变动监听已开启")
    except Exception as e:
        print(f"[启动] 文件变动监听启动失败（不影响上传下载）: {e}")

    cleanup_thread = threading.Thread(target=auto_cleanup_stale_chunks, daemon=True)
    cleanup_thread.start()
    print("[启动] 切片自动清理已开启")

    # 审计表只保留最近 5000 条
    try:
        db.prune_events(5000)
    except Exception as e:
        print(f"[审计] 清理历史事件失败: {e}")

    start_log_maintenance()


def create_listen_socket(host, port):
    """按配置创建监听 socket。

    Windows 上 IPv6 socket 默认 V6ONLY=1，绑定 '::' 只会监听 IPv6，
    局域网里的 IPv4 设备就完全连不上。这里显式关掉 V6ONLY，实现真正的双栈。
    """
    import socket as _socket

    sock = _socket.socket(_socket.AF_INET6, _socket.SOCK_STREAM)
    try:
        sock.setsockopt(_socket.IPPROTO_IPV6, _socket.IPV6_V6ONLY, 0)
    except OSError:
        pass
    if not hasattr(_socket, 'SO_EXCLUSIVEADDRUSE'):
        # POSIX 上打开 REUSEADDR 便于快速重启。
        # Windows 上不设这个选项：Windows 的 SO_REUSEADDR 会允许别的进程
        # 抢占同一端口，默认的独占行为才是正确的。
        sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(128)
    return sock


def create_http_server():
    """创建可关闭的 HTTP 服务器（同时承载 Socket.IO），返回 (server, socket)。

    host 为 '::' 时用双栈 socket；关闭 socket 由调用方负责（关机/停止时）。
    """
    from werkzeug.serving import make_server

    validate_bind_port()

    listen_sock = None
    kwargs = {}
    if HOST in ('::', '::0', '[::]'):
        listen_sock = create_listen_socket('::', PORT)
        kwargs['fd'] = listen_sock.fileno()

    httpd = make_server(HOST, PORT, app, threaded=True, **kwargs)
    return httpd, listen_sock


def print_runtime_summary():
    print("服务配置加载完成:")
    print(f" - VERSION: {version.VERSION}")
    print(f" - PYTHON: {sys.version.split()[0]}")
    print(f" - HOST: {HOST}")
    print(f" - PORT: {PORT}")
    print(f" - UPLOAD_DIR: {app.config['UPLOAD_FOLDER']}")
    print(f" - TEMP_DIR: {TEMP_DIR}")
    print(f" - DB: {DB_PATH}")


if __name__ == '__main__':
    import sys
    exit_code = run_cli(sys.argv[1:])
    if exit_code is not None:
        raise SystemExit(exit_code)

    # 命令行直接运行时也写文件日志（服务模式由 service.py 用 redirect=True 初始化）
    log_path = logutil.setup_logging(redirect=False)
    print(f"[启动] 日志文件: {log_path}")

    print_runtime_summary()
    start_background_workers()

    httpd, listen_sock = create_http_server()
    print(f"[启动] 正在监听 {HOST}:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n收到 Ctrl+C，正在退出...")
    finally:
        httpd.server_close()
        if listen_sock is not None:
            listen_sock.close()