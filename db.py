"""SQLite 数据层：用户账号与文件记录。

只依赖标准库 sqlite3；每次操作单独开连接，配合 WAL 模式，多个上传线程并发读写不会互相阻塞。
"""

import os
import sqlite3
import time
from contextlib import closing

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    REAL NOT NULL,
    last_login_at REAL
);

CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    size          INTEGER NOT NULL,
    sha256        TEXT,
    uploader_id   INTEGER REFERENCES users(id),
    uploader_name TEXT,
    upload_method TEXT,
    created_at    REAL NOT NULL,
    deleted_at    REAL
);

CREATE INDEX IF NOT EXISTS idx_files_name    ON files(name);
CREATE INDEX IF NOT EXISTS idx_files_created ON files(created_at);

CREATE TABLE IF NOT EXISTS shares (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT NOT NULL UNIQUE,
    file_name     TEXT NOT NULL,
    created_by    TEXT,
    created_at    REAL NOT NULL,
    expires_at    REAL,
    max_downloads INTEGER NOT NULL DEFAULT 0,
    downloads     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_name);

CREATE TABLE IF NOT EXISTS events (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     REAL NOT NULL,
    actor  TEXT,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT,
    ip     TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
"""

_db_path = None


def init(path):
    """初始化数据库连接参数并建表"""
    global _db_path
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    _db_path = os.path.abspath(path)
    with closing(_connect()) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript(SCHEMA)
        # 老库补列：users.active（禁用账号）
        try:
            conn.execute("ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1")
        except sqlite3.OperationalError:
            pass
        conn.commit()
    return _db_path


def _connect():
    if not _db_path:
        raise RuntimeError("数据库尚未初始化，请先调用 db.init(path)")
    conn = sqlite3.connect(_db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _all(sql, params=()):
    with closing(_connect()) as conn:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]


def _one(sql, params=()):
    rows = _all(sql, params)
    return rows[0] if rows else None


def _write(sql, params=()):
    with closing(_connect()) as conn:
        cur = conn.execute(sql, params)
        conn.commit()
        return cur.lastrowid


# ---------------------------------------------------------------- 用户

def count_users():
    row = _one("SELECT COUNT(*) AS n FROM users")
    return row['n'] if row else 0


def get_user(username):
    if not username:
        return None
    return _one("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,))


def get_user_by_id(user_id):
    return _one("SELECT * FROM users WHERE id = ?", (user_id,))


def list_users():
    return _all(
        "SELECT id, username, role, active, created_at, last_login_at FROM users ORDER BY id"
    )


def set_active(user_id, active):
    """启用 / 禁用账号"""
    return _write("UPDATE users SET active = ? WHERE id = ?", (1 if active else 0, user_id))


def count_admins():
    row = _one("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1")
    return row['n'] if row else 0


def create_user(username, password_hash, role='user'):
    return _write(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
        (username, password_hash, role, time.time()),
    )


def set_password(user_id, password_hash):
    return _write("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def set_role(user_id, role):
    return _write("UPDATE users SET role = ? WHERE id = ?", (role, user_id))


def touch_login(user_id):
    return _write("UPDATE users SET last_login_at = ? WHERE id = ?", (time.time(), user_id))


def delete_user(user_id):
    return _write("DELETE FROM users WHERE id = ?", (user_id,))


# ---------------------------------------------------------------- 文件记录

def add_file(name, size, sha256=None, uploader_id=None, uploader_name=None, method=None):
    return _write(
        "INSERT INTO files (name, size, sha256, uploader_id, uploader_name, upload_method, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (name, int(size), sha256, uploader_id, uploader_name, method, time.time()),
    )


def latest_file_records():
    """返回 {文件名: 最新一条记录}，供文件列表叠加「上传者/上传时间」"""
    rows = _all(
        "SELECT * FROM files WHERE deleted_at IS NULL ORDER BY id ASC"
    )
    return {row['name']: row for row in rows}


def latest_record(name, include_deleted=True):
    """某个文件名的最新一条记录（默认含已删除的，回收站也要用它判断归属）"""
    if include_deleted:
        return _one("SELECT * FROM files WHERE name = ? ORDER BY id DESC LIMIT 1", (name,))
    return _one(
        "SELECT * FROM files WHERE name = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
        (name,),
    )


def mark_deleted(name, when=None):
    """把某个文件的所有活跃记录标记为已删除"""
    return _write(
        "UPDATE files SET deleted_at = ? WHERE name = ? AND deleted_at IS NULL",
        (when or time.time(), name),
    )


def restore_record(name):
    """恢复被标记删除的记录（还原文件时用）"""
    return _write(
        "UPDATE files SET deleted_at = NULL WHERE name = ? AND deleted_at IS NOT NULL",
        (name,),
    )


def rename_file(old_name, new_name):
    """文件改名后同步记录"""
    return _write(
        "UPDATE files SET name = ? WHERE name = ? AND deleted_at IS NULL",
        (new_name, old_name),
    )


def files_by_user(user_id, limit=200):
    return _all(
        "SELECT * FROM files WHERE uploader_id = ? AND deleted_at IS NULL"
        " ORDER BY id DESC LIMIT ?",
        (user_id, limit),
    )


def stats():
    row = _one(
        "SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files"
        " WHERE deleted_at IS NULL"
    )
    row['users'] = count_users()
    return row


# ---------------------------------------------------------------- 分享链接

def create_share(token, file_name, created_by, expires_at=None, max_downloads=0):
    return _write(
        "INSERT INTO shares (token, file_name, created_by, created_at, expires_at, max_downloads)"
        " VALUES (?, ?, ?, ?, ?, ?)",
        (token, file_name, created_by, time.time(), expires_at, int(max_downloads or 0)),
    )


def get_share(token):
    return _one("SELECT * FROM shares WHERE token = ?", (token,))


def list_shares(file_name=None):
    if file_name:
        return _all("SELECT * FROM shares WHERE file_name = ? ORDER BY id DESC", (file_name,))
    return _all("SELECT * FROM shares ORDER BY id DESC LIMIT 500")


def touch_share(token):
    return _write("UPDATE shares SET downloads = downloads + 1 WHERE token = ?", (token,))


def delete_share(token):
    return _write("DELETE FROM shares WHERE token = ?", (token,))


def delete_shares_for(file_name):
    return _write("DELETE FROM shares WHERE file_name = ?", (file_name,))


# ---------------------------------------------------------------- 审计日志

def add_event(action, actor='', target='', detail='', ip=''):
    return _write(
        "INSERT INTO events (ts, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
        (time.time(), actor, action, target, detail, ip),
    )


def list_events(limit=100):
    return _all("SELECT * FROM events ORDER BY id DESC LIMIT ?", (int(limit),))


def prune_events(keep=5000):
    """只保留最近 N 条审计记录，避免库无限增长"""
    return _write(
        "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)",
        (int(keep),),
    )


