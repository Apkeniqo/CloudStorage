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