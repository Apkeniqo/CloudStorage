# 更新日志

本文件记录每次发布的改动，版本号与 `version.py` 保持一致。
格式：`beta 2026.MMDD.N`，同一天的第 N 次发布。

## beta 2026.1022.1 — 删除文件（回收站）

- 新增 `POST /files/delete`：删除时把文件移到回收站目录（带 `YYYYmmdd-HHMMSS_` 前缀），而不是直接抹掉
- 文件列表每行增加删除按钮；用事件委托绑定，文件名带引号也不会破坏 HTML
- 删除后写数据库 `deleted_at`，列表叠加的「上传者/上传时间」随之消失
- 新增配置 `[PATH] trash_dir`（默认 `Trash`），不可用时自动降级

## beta 2026.1022.2 — 回收站

- 新增 `/trash` 页面：列出被删除的文件（还原原始文件名、大小、删除时间）
- 新增 `GET /api/trash`、`POST /trash/restore`、`/trash/purge`、`/trash/empty`
- 恢复时自动改名避免与现有文件冲突，并复原数据库记录
- 首页工具栏新增回收站入口
## beta 2026.1022.3 — 重命名

- 新增 `POST /files/rename`：改名后同步数据库记录
- 目标名已存在时返回 409，不会覆盖
- 文件名统一走 `clean_filename` 清洗，../evil.txt 会被收敛成 evil.txt，不会越出存储目录
- 文件列表每行新增重命名按钮（铅笔图标），用事件委托绑定
## beta 2026.1022.4 — 用户管理

- 后台新增「用户」面板：列表、新建、改密、启用/禁用、改角色、删除
- 新增 `GET /admin/users` 与 `POST /admin/users/{create,password,update,delete}`
- `users` 表新增 `active` 列（老库启动时自动 ALTER 补列）
- 禁用与删除都会让该账号的现有会话立即失效
- 保护规则：不能禁用/降级/删除自己，且至少要保留一个启用的管理员