# CloudStorage

一个跑在 Windows 上的局域网文件存储服务：Flask + Socket.IO + SQLite，支持大文件分片上传、断点续传、实时刷新，可以作为 Windows 服务开机静默运行。

## 功能

- **上传**：小于 200MB 直接单流上传；大文件自动切片（最多 64 片，每片 ≥10MB），支持断点续传与失败重试
- **文件指纹**：按「大小 + 均匀分布的 16 段采样内容」生成，改名/换机器仍可续传，内容变了不会被误判
- **合并**：后台线程合并，写临时文件后原子重命名，同名文件自动改名为 `xxx (1).ext`，绝不覆盖
- **实时**：Socket.IO 推送文件列表，watchdog 监听磁盘变化
- **账号**：用户名 + 密码（SQLite 存 scrypt 哈希），会话 cookie，角色区分 admin / user
- **管理后台**：`/admin` 在线修改配置、查看运行状态、修改密码
- **Windows 服务**：`install_service.ps1` 一键注册，开机延迟自启，崩溃自动重启

## 快速开始

## 从零开始（克隆后直接装服务）

```powershell
git clone https://github.com/Apkeniqo/CloudStorage.git D:\Projects\CloudStorage
cd D:\Projects\CloudStorage

# 需要 Python 3.9 或更高（推荐 3.11 / 3.12 / 3.13，安装脚本会自动挑选可用版本）

# 一条命令：生成 config.ini、建虚拟环境、装依赖、注册并启动服务
.\install_service.cmd
```

`install_service.cmd` 会自动用 `-ExecutionPolicy Bypass` 调起 PowerShell，避免「无法加载文件，因为在此系统上禁止运行脚本」的报错；执行过程中会提示你设置 admin 初始密码。

非交互安装（远程 / 批处理）可以显式传密码：

```powershell
powershell -ExecutionPolicy Bypass -File .\install_service.ps1 -AdminPassword '你的密码'
```

不想装服务、只想先跑起来看看：

```powershell
powershell -ExecutionPolicy Bypass -File .\install_service.ps1 -PrepareOnly
.\.venv\Scripts\python.exe service.py --foreground
```

`config.ini` 不在仓库里（含密码和会话密钥），首次运行时会从 `config.example.ini` 自动生成。

## 手动部署

```powershell
# 需要 Python 3.9+（下面以 3.13 为例；任何 3.9 以上版本都可以）
py -3.13 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 复制配置模板，按需修改端口、目录、管理员密码
Copy-Item config.example.ini config.ini

# 前台运行（调试用）
.\.venv\Scripts\python.exe server.py
```

> 程序启动时会检查 Python 版本，低于 3.9 直接报错退出。安装脚本则会在
> `py -3.13 / -3.12 / -3.11 / -3.10 / -3.9 / -3` 以及 PATH 里的 `python`、`python3` 中
> 自动挑选第一个可用的版本。

首次启动会自动建库、建管理员账号，并把会话密钥写回 `config.ini`。

浏览器访问 `http://<本机IP>:5000`，用 `config.ini` 里的 `admin_user` / `admin_password` 登录。

> 端口 80 / 443 会被运营商封锁，程序启动时会直接拒绝这两个端口。

## 注册为 Windows 服务

项目必须放在**本机磁盘**上（Windows 服务不能从网络共享启动）。

```powershell
# 方式一：双击或命令行运行（自动绕过执行策略）
.\install_service.cmd

# 方式二：在「以管理员身份运行」的 PowerShell 里
powershell -ExecutionPolicy Bypass -File .\install_service.ps1
```

脚本会：生成 `config.ini`（若缺失）→ 提示设置 admin 密码 → 重建或复用 `.venv` → 安装依赖 → 注册 `CloudStorage` 服务 → 设置崩溃重启（5s/10s/30s）→ 开机延迟自启 → 放行防火墙 5000/TCP（仅域/专用网络）。

常用命令：

```powershell
Get-Service CloudStorage
Restart-Service CloudStorage
.\.venv\Scripts\python.exe service.py --foreground   # 前台运行，便于看日志
.\.venv\Scripts\python.exe service.py stop / start   # 手动控制
.\uninstall_service.cmd
```

日志：`logs\cloudstorage.log`（5MB × 5 轮转）。

## 配置

`config.ini` 各段含义见 `config.example.ini` 里的注释。在管理后台 `/admin` 也能改，保存时会**保留注释与顺序**，并标明哪些需要重启。

| 段 | 项 | 说明 |
|---|---|---|
| `SERVER` | `host` / `port` | `::` 表示 IPv4/IPv6 双栈（Windows 上已显式关闭 V6ONLY） |
| `PATH` | `upload_folder` / `temp_dir` | 相对路径基于 `server.py` 所在目录 |
| `LIMIT` | `max_content_length_mb` | 单次请求体上限 |
| `CLEANUP` | `chunk_expire_seconds` / `cleanup_interval_seconds` | 废弃切片回收 |
| `DB` | `path` | SQLite 文件位置 |
| `AUTH` | `enabled` / `admin_user` / `admin_password` / `secret` | 首次建库用的管理员账号与会话密钥 |

## 管理后台

`http://<IP>:5000/admin`（仅 admin 角色可进，其他账号 403）

- 运行状态：监听地址、运行时长、存储/临时目录、数据库大小、文件数与用户数、日志路径
- 配置编辑：服务 / 存储 / 限制 / 清理 / 认证，字段级校验（端口范围、禁止 80/443、拒绝 UNC 路径）
- 修改密码

## 账号管理（命令行）

```powershell
python server.py --list-users
python server.py --create-user alice --password 你的密码
python server.py --create-admin boss --password 你的密码
python server.py --set-password alice --password 新密码
```

## 目录结构

```
server.py               HTTP 路由、分片合并、鉴权、配置读写、CLI
db.py                   SQLite 数据层（users / files）
service.py              Windows 服务封装（pywin32）
install_service.ps1     一键安装服务
uninstall_service.ps1   卸载服务
templates/              index.html / login.html / admin.html
static/                 App.js / Style.css
```

## 安全说明

- `config.ini`、`CloudStorage/`、`logs/`、`.venv/` 都已在 `.gitignore` 中排除；`config.ini` 含明文初始密码与会话密钥，**不要提交**
- 数据库存的是 scrypt 哈希，不是明文密码
- 部署到公网前建议加一层 HTTPS 反向代理（80/443 被封时可用 8443 等端口）
- 服务默认以 LocalSystem 运行，注意项目目录与 `config.ini` 的文件权限
