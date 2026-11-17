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
## beta 2026.1022.5 — 登录失败限流

- 同一 IP + 用户名 15 分钟内连续失败 5 次，锁定 10 分钟（返回 429）
- 锁定期内即使密码正确也会被拒绝
- 登录成功立即清除计数；表过大时自动清理过期条目
- 说明：这是按「IP + 用户名」计数的轻量防爆破，同一局域网内的恶意者仍可能把自己锁住
## beta 2026.1022.6 — 存储配额

- 新增配置 `[LIMIT] max_storage_mb`（默认 0 = 不限制），后台可改且热生效
- 单流上传按 `Content-Length` 提前判断，超限返回 413
- 分片上传在合并前按切片总大小判断，超限同样返回 413（切片本身仍留在临时目录，可清理后重试）
- 管理后台「运行状态」显示已用空间与上限
## beta 2026.1022.7 — 分享链接

- 新增 `shares` 表与 `/api/shares`：可为文件生成免登录下载链接
- 支持「有效期（小时，0=永久）」与「最多次数（0=不限）」，超期或超次返回 410
- 链接格式 `/s/<token>`，令牌随机 22 位；非法令牌 404
- 文件被删除时自动作废其所有分享链接
- 列表页每行新增分享按钮，生成后直接弹出可复制的完整链接
## beta 2026.1022.8 — 健康检查与版本接口

- 新增 `GET /healthz`（免登录）：检查数据库、临时目录可写、存储目录存在，任一失败返回 503
- 新增 `GET /api/version`（免登录）：返回版本、Python 版本、已运行秒数，便于监控与升级核对
## beta 2026.1022.9 — 审计日志

- 新增 `events` 表（时间 / 操作人 / 动作 / 目标 / 详情 / IP），启动时只保留最近 5000 条
- 记录：登录成功与失败、上传（单流与分片）、删除、改名、回收站恢复/彻底删除/清空、分享创建与撤销、用户增删改密、配置保存
- 后台新增「最近事件」面板（`GET /admin/events`，最多 500 条，按时间倒序）
- 修复：登录成功的事件原先在写入会话之前记录，操作人被记成了 anonymous
## beta 2026.1022.10 — 切片完整性校验（CRC32）

- 客户端为每个切片计算 CRC32（纯 JS 实现，任何源都可用，不依赖 crypto.subtle），放在 `X-Chunk-Crc32` 头里
- 服务端边写盘边算同一个 CRC，不一致就删掉 `.part` 并返回 400「切片校验失败，请重传」，前端按指数退避重试
- 不带该头的旧客户端行为不变（兼容）
- 实测：正确 CRC 200、错误 CRC 400、无头 200；JS 与 Python 的 CRC32 在 0/1/1KB/3MB/5MB 五种数据上结果一致
## beta 2026.1022.11 — 移动端适配

- 新增 640px 断点：容器全屏、工具栏换行、搜索框独占一行、按钮触摸目标 ≥40px
- 列表视图改为两行布局：第一行名称 + 大小，第二行操作按钮右对齐；隐藏表头与修改时间
- 图标视图卡片最小宽度降到 110px，并在 `(hover: none)` 设备上让操作按钮常驻（触屏没有 hover，原来根本点不到）
- 移除旧的 600px 断点（会覆盖新布局）
- `index.html` 补充 `theme-color`、`apple-mobile-web-app-capable`，viewport 允许 5 倍缩放
## beta 2026.1022.12 — 大列表分批渲染

- 文件列表改为分页渲染：首屏只画 200 条，滚动接近底部时再追加下一页（`PAGE_SIZE = 200`）
- 列表为空/搜索无结果时仍显示空状态；计数显示「共 N 项 · 已显示 M」直到全部加载
- 切换排序、搜索、视图、收到实时推送都会重置到第一页
- Node 桩测试：800 条数据首屏渲染 200 条，4 次滚动后渲染到 800 条，计数文案正确
## beta 2026.1022.13 — 用户文件隔离

- 新增配置 `[AUTH] isolate_files`（默认 false；开启后普通用户只能看到自己上传的文件）
- 列表按上传者过滤；回收站同样按归属过滤
- 删除 / 重命名 / 分享增加权限校验：非本人且非管理员返回 403
- 管理员不受限制；后台可热切换该开关
- 实测：管理员看到 2 个文件、普通用户看到 0 个；普通用户删除/改名/分享他人文件全部 403，操作自己的正常
## beta 2026.1022.14 — 统一错误处理

- 新增 `HTTPException` 与未捕获异常的统一处理：接口路径（/api、/upload、/files、/admin、/trash）返回 JSON，页面返回 `error.html` 错误页
- 413 提示改为「请求体超过上限（N MB）」；404 统一「页面或接口不存在」；405 提示「请求方法不允许」
- `/api/*` 加入受保护前缀：未登录直接 401 JSON，不再被 302 重定向成 HTML
- 修复：`/upload`、`/upload/chunk` 里的 `except Exception` 把 413 吞成了 500，改为先 `except HTTPException: raise`
## beta 2026.1022.15 — 自检脚本与文档收尾

- 新增 `selfcheck.py` / `selfcheck.cmd`：检查 Python 版本、依赖、配置文件、目录可写、数据库、鉴权开关，以及运行中服务的 `/healthz`、`/api/version`、`/login`
- `--offline` 只看本地环境，`--url` 可指向远端实例；失败项汇总后以退出码 1 返回
- README 补充接口一览、自检用法与常见问题；CHANGELOG 汇总到 15 个版本
- 自检实测：对着运行中的实例 15 项全部通过
## beta 2026.1022.16 — 网页初始化、自动重启、管理员改名

- 首次启动不再自动建随机密码账号，改为跳转 `/setup` 向导：选择存储路径、设置管理员用户名与密码，保存后自动重启生效
- 后台保存「需要重启」的配置后自动重启（服务模式走 `sc stop/start`，命令行模式用 `restart_helper.py` 拉起同一条命令），前端轮询 `/healthz` 后自动刷新
- 后台用户列表新增「改名」：改完立即生效，当前会话同步更新，历史文件记录的上传者名字一起改
- 安装脚本不再询问管理员密码（改由网页向导创建）
## beta 2026.1022.17 — 修复文件列表变形

- 列表视图操作列宽 60px → 128px，并把操作列设为 `white-space: nowrap`：下载/分享/重命名/删除四个按钮挤在 60px 里会换行，把行高撑成两行，看起来像列表错位
- 图标视图的操作按钮缩小内边距，避免在窄卡片上盖住文件名
- 其余样式与功能不变
## beta 2026.1022.18 — 操作按钮统一 + 移动端二级菜单

- 下载/分享/重命名/删除统一为同一套图标按钮：相同 30×30 尺寸、相同对齐、相同 hover，分享与重命名从文字符号换成 SVG 图标
- 操作列改为 flex 布局（`justify-content: flex-end`），四个按钮基线完全一致；图标视图内按钮缩到 26×26，避免超出卡片
- 移动端（≤640px）顶部只保留搜索框、上传按钮和「更多」入口，视图切换/主题/管理后台/回收站/退出登录收进下拉二级菜单
- 二级菜单带图标 + 文字标签，点空白处自动收起；桌面端布局与之前一致
## beta 2026.1022.19 — 访客（只读）

- 新增 `guest` 角色：可以登录、浏览列表、下载文件；上传/删除/重命名/分享/回收站操作一律 403「访客只能浏览和下载文件」
- 后台新建/编辑用户时可选择「访客（只读）」，也可随时把访客改回普通用户
- 新增配置 `[AUTH] guest_browse`（默认 false）：开启后登录页出现「以访客身份浏览（只读）」，无需账号密码即可进入；关闭时该地址直接跳回登录页
- 访客界面隐藏上传入口，文件列表只保留下载按钮，状态栏显示「访客（只读）」
- 访客不受 `isolate_files` 限制（访客没有上传者身份，用于「给别人看」的场景）
## beta 2026.1107.0 — 大文件上传卡顿排查与修复

- 客户端 CRC32 改到 Web Worker 里算：之前在主线程算 CRC 会阻塞页面，进度条和上传回调一起停住
- 新增切片卡死检测：单条连接 15 秒没有任何进度就主动断开重连，避免坏连接长期占着并发位（浏览器同源只有 6 条连接）
- 重试策略调整：退避 0.5s→4s（原 1s→8s）并加随机抖动；401/403/404/413 这类重试无意义的错误直接失败
- 进度条更新合并到每帧一次（requestAnimationFrame），不再被密集的 progress 事件拖慢
- 服务端：每片 `os.fsync` 改为可配置 `[UPLOAD] fsync_chunks`（默认关闭），只保留 `.part` → 正式名的原子改名
- 服务端：`os.replace` 遇到 `PermissionError`（Windows 上杀毒/索引器短暂占用文件）按指数退避重试 8 次
- 服务端：切片落盘超过 3 秒会写一条日志，方便判断是不是磁盘/杀毒在拖慢
- 修复：后台合并线程和文件监听里调用 `get_file_list()` 会抛 `Working outside of request context`，导致分片上传合并成功却被标记为失败、磁盘变动也不会自动刷新列表
## beta 2026.1107.1 — 上传速度显示改为真实采样

- 速度不再依赖 `progress` 事件里的增量计算：改为独立的 500ms 采样器，用最近 1 秒真正传输的字节算速度
- 没有数据流动时直接显示 `0 B/s`，不再停留在上一次的数值（之前卡住时速度会一直显示成固定值）
- 低于 512 B/s 统一按 0 处理，避免显示 "3 B/s" 这类噪声
- 单文件直传和分片上传共用同一套采样逻辑；上传成功/失败/取消时停掉计时器，不留后台定时任务
## beta 2026.1107.2 — 更新后自动重启服务

- `update.py` 默认在文件写完后**立刻重启 CloudStorage 服务**，不用再加 `--restart`（旧参数仍兼容）
- 重启改成等状态：`sc stop` 后轮询到 STOPPED 再 `sc start`，最后确认 RUNNING，单步超时 60 秒
- 重启前做两道保护：服务不存在就跳过并提示；服务可执行文件或 venv 基础解释器丢失时**拒绝重启**（避免停掉却起不来）
- `sc` 返回 5（权限不足）时明确提示用管理员身份运行
- 新增 `--no-restart`：只更新文件不重启；`--check` 行为不变
- 退出码：重启成功 0；文件已更新但重启失败 1（方便脚本判断）
## beta 2026.1107.3 — 更新器容错

- `update.cmd` 先验证 `.venv` 里的 python 能否真正运行；venv 坏了会退回系统 `py -3` / `python`，并提示怎么重建 venv
- 找不到任何可用 Python 时给出明确报错（退出码 1），不再是一串看不懂的 launcher 报错
## beta 2026.1107.4 — 拖拽上传

- 把文件拖进页面任意位置即可上传：拖动时显示「松开鼠标即可上传」提示层，松手后走原有的分片/断点续传流程
- 支持一次拖入多个文件；拖入文件夹会被忽略并在控制台提示（不做递归展开）
- 访客（只读）拖动时不会出现提示层，松手直接提示「访客只能浏览和下载文件」
- 拖入非文件内容（文本、链接）不触发上传，也不影响页面默认行为
- 上传入口拆成 `uploadFiles()`（选择框）和 `uploadFileList(files)`（拖拽复用），两条路径共用一套上传逻辑
## beta 2026.1108.0 — 侧边栏 + 文件夹

- 新增左侧导航栏（模仿 OneDrive 网页版）：我的文件 / 最近 / 共享 / 回收站 / 管理后台，底部显示存储用量与退出登录；窄屏下收成抽屉，由顶部按钮唤出
- 新增**文件夹**支持：可在任意层级新建、进入、重命名、删除文件夹，上传会落在当前目录
  - 新增 `GET /api/list?path=`（目录内容 + 面包屑）、`GET /api/recent`（跨目录最近文件）、`POST /folders/create`
  - 上传接口新增目标目录参数：单文件 `path` 字段、分片合并 `targetPath`
  - 删除/重命名改为按相对路径操作，文件夹改名会同步更新其下所有记录
- 回收站保留原始目录结构：删除 `docs/a.txt` 会进 `Trash/docs/`，恢复时回到原路径
- 存储用量改为递归统计（含子目录），配额判断也随之准确
- 分享链接支持子目录文件，列表新增「共享」弹窗（查看/复制/撤销）
- 文件列表排序文件夹永远在前
## beta 2026.1108.1 — 按 OneDrive 风格调整 + 修复登录页错位

- 顶栏重排：左侧标题「文件」，搜索框居中，右侧是新建文件夹 / 视图 / 上传 / 更多
- 面包屑独立成一行，位于顶栏下方，不再挤在工具栏里
- 侧边栏改成 OneDrive 的排布：顶部账号名，导航「主页 / 我的文件 / 已共享 / 回收站 / 管理后台」，底部「存储」进度条 + 「x 已使用 y (z%)」
- 「主页」展示最近修改的文件，「我的文件」回到根目录
- **修复**：登录页（以及回收站、管理后台、初始化页）被挤到左上角——上一版把 `body` 改成了 `display: block`，现在只对主页面 `body.app-body` 生效，其它页面恢复原来的居中布局
## beta 2026.1108.2 — 三区分离

- 外层不再是一张大卡片：页面背景直接透出，侧边栏、顶栏、文件区各自独立
- 侧边栏去掉右边框和底色；顶栏去掉下边框；面包屑也不再画线
- **只有文件列表**是卡片：圆角 + 1px 边框 + 阴影 + 毛玻璃背景，列表滚动区域自带裁切
- 状态栏（连接状态 / 项目数）改为透明，紧贴卡片下方
- 手机端把卡片左右边距收到 8px，顶栏和面包屑的上边距也一并收紧
## beta 2026.1108.3 — 窄屏布局收口

- 「新建文件夹」移进工具栏按钮组：桌面端在操作区，手机上收进「更多」菜单，不再挤占顶栏
- 顶栏在手机上强制单行（☰ / 搜索 / 上传 / ⋮），搜索框自适应剩余宽度
- 列表在窄屏统一为两行布局（名称+大小 / 操作右对齐），表头与修改时间隐藏
- 文件卡片在窄屏贴合边缘（左右 8px），修掉内容比视口宽、右侧按钮被截断的问题
## beta 2026.1108.4 — 整体放大到 120% + 去重

- 页面整体放大到 120%（`html { zoom: 1.2 }`），字号、图标、行高、控件一起放大
- 放大后 `vh` 会算错，改用 `height: 100%` 链式撑满，保证状态栏不会被挤出视口
- 侧边栏去掉「上传」按钮（顶栏已有）
- 去掉侧边栏和顶栏重复的功能：顶栏移除「回收站 / 管理后台 / 退出登录」，统一只保留在侧边栏；顶栏剩「新建文件夹 / 列表 / 图标 / 主题 / 上传 / 更多」
- 顺手修掉主题按钮图标在深色模式下几乎看不见的问题（图标颜色改为显式指定，深色白色、浅色深灰）
## beta 2026.1108.5 — 回收站改为视图切换

- 回收站不再是独立页面：点侧边栏「回收站」只在当前界面重新渲染列表（面包屑变成「回收站」，侧边栏对应项高亮）
- 顶栏功能栏随视图切换：文件视图显示「新建文件夹 / 列表 / 图标 / 主题 / 上传 / 更多」；回收站视图隐藏上传与新建，显示「清空回收站」
- 回收站每行操作为「恢复 / 彻底删除」，双击名称不跳转；搜索、排序照常可用
- `/trash` 旧地址 302 到 `/?view=trash`，书签仍可用；删除独立的 `trash.html` 模板
- 修复：回收站视图下侧边栏高亮偶尔不生效（异步渲染与时序竞争），改用 `body.trash-mode` 兜底
## beta 2026.1108.6 — 多选、动效与细节修正

- 文件列表加复选框：支持单选、全选（表头勾选框），选中后顶部出现「已选 N 项 / 删除 / 取消」操作条，可批量删除到回收站
- 110% 放大后登录页出现滚动条：`body` 的 `min-height: 100vh` 在 zoom 下会比视口高，改成 `100%`（实测 `scrollHeight == innerHeight`，无滚动）
- 侧边栏切换加过渡动效：背景/文字颜色 0.18s 渐变、按下时轻微位移；视图切换时文件区 0.22s 淡入上移
- 侧边栏移除「共享」入口（共享链接仍可从文件行的分享按钮进入）
## beta 2026.1108.7 — 侧边栏留白、Fluent 选中条、复制/剪切/粘贴、视图合并

- 侧边栏项目间距从 2px 放到 6px，内边距 9/10px → 10/14px，不再拥挤
- 选中项去掉蓝色底色，改成 Fluent 风格的白色/浅色条（深色模式下是 14% 白色蒙层），保留轻微投影和加粗
- 顶部工具栏新增「复制 / 剪切 / 粘贴」：复制剪切作用于勾选项，进入目标文件夹后粘贴；复制/剪切在未选中时置灰
- 新增后端 `POST /files/copy` 与 `POST /files/move`：支持文件夹递归复制、重名自动加 (1) 后缀、禁止把文件夹移进自身或子目录
- 「列表 / 图标」两个按钮合并成一个切换按钮，图标随当前视图变化（列表模式下显示图标视图的图标）
## beta 2026.1108.8 — 修复多选与空状态

- 修复：删除或切换视图后「已选 N 项」不消失——选择条现在会剔除当前列表里已不存在的条目，列表空了就自动收起
- 修复：回收站里的复选框没有作用到文件上；现在回收站行也可勾选，全选后「彻底删除」会直接清掉选中项（按钮文案随视图切换）
- 回收站里禁用复制/剪切/粘贴（没有意义）
- 修复：图标视图下「这个文件夹是空的」被挤成一列窄字，现在跨整行居中显示
- 删除/重命名后按当前视图（文件 / 主页 / 回收站）重新加载，不再跳回根目录
## beta 2026.1108.9 — 侧边栏竖条指示器

- 侧边栏选中项左侧加一条 3px 的竖向指示条（深色主题白色、浅色主题深灰），和 Windows 11 设置页一样
- 切换视图时竖条在项目之间平滑滑动（260ms 缓动），高度和位置一起过渡；窗口尺寸变化会重新定位
- 指示器由 `currentView_nav` 驱动，不依赖 class 时序，切换文件/主页/回收站都准确
## beta 2026.1108.10 — 指示条位置与配色

- 指示条从导航最左边（贴着胶囊外侧）移到**选中项内部**，左侧内缩 6px，和 Windows 11 的选中态一致
- 指示条改成主题蓝（`var(--accent-color)`），不再是无彩色白条
- 当前页面的标题文字（面包屑当前项，如「我的文件」「回收站」）也改成蓝色
## beta 2026.1108.11 — 管理后台并入主页面、侧边栏标题配色

- 管理后台不再是独立页面：点侧边栏「管理后台」在主区域直接展示（内嵌 `/admin?embed=1`），侧边栏与左侧导航保持不变，不用来回跳转
- 嵌入模式下隐藏管理页自带的页头（「返回文件 / 退出」），避免和侧边栏功能重复
- 选中项的**侧边栏标题文字**和图标改成主题蓝（之前改错了对象，误改成了面包屑）；面包屑恢复普通颜色
- 管理视图下实时推送不会把页面刷走；切回文件/主页/回收站会自动退出管理视图
## beta 2026.1108.12 — 修正指示条垂直位置

- 修复指示条不在每个选项卡里垂直居中的问题：页面整体有 `zoom: 1.2`，`getBoundingClientRect()` 返回的是缩放后的像素，而 `style.top` 用的是未缩放的 CSS 像素，两者混用导致越往下的项目偏移越大
- 现在按 `zoom` 换算成 CSS 像素再定位，实测选中项中心 167.9、指示条中心 167.9，完全对齐
- 定位方式从 `transform: translateY()` 改成 `top`（过渡也改为 `top`/`height`），避免个别环境下 transform 未生效导致竖条停在顶部
## beta 2026.1108.13 — 后台页面字号恢复 100%

- 管理后台（内嵌和独立访问）不再跟随主界面的 120% 缩放，`html { zoom: 1 }`，文字和控件回到原始大小；主界面其余部分保持 120%
- 顺带修两个问题：
  - socket 重连时会把管理视图刷回文件列表（`requestFileList` 现在会识别 admin 视图）
  - 侧边栏选中项的文字颜色在某些视图下解析成深色、几乎看不见；改为按主题显式指定（深色 #4cc2ff / 浅色 #0078d4），不再依赖变量在当前上下文里的继承
## beta 2026.1108.14 — 个人背景

- 每个账号可上传自己的页面背景图（jpg / png / webp / gif / bmp，≤ 8MB），背景只对本人可见
- 侧边栏底部新增「背景」入口：弹窗里「选择图片 / 恢复默认」
- 新增接口：`POST/GET /prefs/background`（上传 / 读取自己的背景）、`POST /prefs/background/clear`（恢复默认）
- 图片存放于数据库同目录的 `backgrounds/<用户id>.<扩展名>`；换图会先删旧文件，删除账号不影响他人
- `/auth/me` 增加 `background` 布尔值，页面加载时据此决定是否套用背景
- 背景图默认 cover 铺满，并压一层 42% 暗色蒙版保证文字可读
## beta 2026.1108.15 — 背景自动缩放 + 模糊程度可调

- 修复背景偏大：页面整体有 `zoom: 1.2`，固定背景层会被再放大 1.2 倍；改为 `inset: 6%` 抵消，背景始终按窗口尺寸 `cover` 自动缩放，改窗口大小实时适配
- 背景改用独立的 `::before` 图层 + `::after` 蒙版，图片模糊不会露出边缘透明缝
- 新增「模糊程度」设置（每人一份，随账号保存）：
  - 文件区域模糊 0–40px，默认 24px（对应面的 `backdrop-filter`）
  - 背景模糊 0–30px，默认 0px
  - 弹窗里两个滑块，拖动实时预览，停手 0.4s 自动保存
- 新增接口 `POST /prefs/blur`，`/auth/me` 返回 `blur_panel` / `blur_bg`
- 数据库 users 表新增 `blur_panel` / `blur_bg`（老库启动自动补列）
- 有自定义背景时文件面板底色加深，保证文字可读
## beta 2026.1108.16 — 背景铺满（低分辨率也自适应缩放）

- 修复背景四周留黑边：之前用 `inset: 6%` 抵消 zoom，导致图层比窗口小 12%，低分辨率图尤其明显
- 改为 `inset: -32px` 轻微溢出，任何尺寸的图（实测 240×160）都会 `cover` 铺满整个窗口，四周无缝隙
- 低分辨率图放大时使用平滑插值（`image-rendering: auto`），不再出现硬边马赛克
- 窗口缩放时背景实时自适应
## beta 2026.1108.17 — 容量限制（磁盘联动）

- 「存储总量上限 (MB)」设为 **0** 时跟随磁盘：读取存储目录所在磁盘的总容量与剩余容量，侧边栏显示「已用 X · 磁盘剩余 Y」，进度条按磁盘占用率
- 设为具体值时先与磁盘剩余空间比对：设定值超过磁盘当前剩余就**拒绝保存**并提示（实测设定 512000 MB，磁盘剩余 309815 MB → 报错不落盘）
- 未设配额时上传也会检查磁盘剩余，写满之前就返回 413，避免写爆磁盘
- 新增 `disk_space()` / `storage_info()`，`/api/version` 与 `/api/list` 返回统一的 `storage` 结构：`used / limit / remaining / mode / percent / disk_total / disk_free`
- 管理页「存储总量上限」的说明改为「0 = 跟随磁盘实际容量」，并给出无法保存的原因
## beta 2026.1108.18 — 超过剩余容量时全链路拦截

- 分片接口 `/upload/chunk` 在落盘前就校验容量：客户端新增 `X-File-Size` 头（整个文件大小），超出直接 413，**不会写任何临时切片**
- 分片接口额外检查磁盘剩余，写满前就返回 413，避免 `OSError: No space left`
- `/upload/check` 返回 `storage` 信息，前端可在上传前判断
- 前端：开始上传前取一次剩余容量，放不下的文件直接跳过并在任务卡片上红字提示（如「空间不足：需要 2 MB，剩余 224 KB」），不浪费带宽
- 单流上传失败时展示服务端返回的具体原因，不再只显示「上传失败」
## beta 2026.1108.19 — 搜索框上移、文件夹可点开、路径显示

- 搜索框移到标题行，和路径同一行右侧；工具栏那一行的「文件」标题去掉，工具栏改为右对齐
- 文件夹整行可点开（以前只有文件名能点）：列表和图标视图都支持，鼠标移上去有高亮，重命名/删除按钮不受影响
- 路径显示改为「主页 / 文件夹1 / 文件夹2 /」，根节点叫「主页」，末尾带斜杠，中间层级可点击回退
- 后端 `/api/list` 的根面包屑名称由「我的文件」改为「主页」
- 移动端标题行同步适配（路径最多占 46%，搜索占剩余宽度）
## beta 2026.1108.20 — 移动端抽屉、搜索框位置、后台设置搜索

- 移动端侧边栏改为真正的抽屉：打开时铺一层 45% 黑色遮罩，点遮罩关闭；抽屉本身改为不透明背景，不再和页面内容混在一起
- 抽屉里新增右上角 ✕ 关闭按钮；汉堡键浮在抽屉之上，点同一个图标即可再次收起；点任意菜单项后自动收起
- 搜索框移回工具栏那一行并居中（开关 / 搜索 / 工具按钮三段式），标题行只保留路径
- 管理后台「配置」卡片新增搜索框：按名称、说明或键名过滤设置项，自动隐藏没有匹配项的分组，无结果时显示「没有匹配的设置项」，带一键清空
## beta 2026.1108.21 — 指示条重做、搜索并入侧边栏、后台复用全局搜索

- 侧边栏竖条不再用 JS 计算坐标，改为每个菜单项自己的 `::before`，绝对居中，桌面/抽屉/任何缩放下都不会错位
- 桌面端搜索框移入侧边栏（品牌下方）；移动端顶部改为搜索图标，点击展开侧边栏并聚焦搜索框
- 管理后台去掉自己那套搜索框，直接复用全局搜索：在后台视图下输入会转发给 iframe 里的设置过滤，切换视图时也能带上当前关键词
- 移动端取消 120% 缩放（`html { zoom: 1 }`），布局不再比视口宽、右侧按钮不再被裁
- 窄屏（≤620px）顶栏收紧：上传按钮变纯图标，搜索/更多按钮都能完整显示
## beta 2026.1108.22 — 工具栏恢复靠右

- 上版为了给搜索框让位把顶栏改成了 `space-between`，搜索移进侧边栏后桌面端只剩工具栏，就被顶到了左边
- 改回 `justify-content: flex-end`：工具栏始终靠右，移动端汉堡键仍靠左（`margin-right: auto`）
## beta 2026.1108.23 — 隐藏文件（仅管理员） + 剪切半透明

- 管理员可以把文件/文件夹设为**隐藏**：普通用户和访客在列表里完全看不到，直接访问下载链接也是 404；管理员自己能看到，条目压暗 + 名称划线，右侧用「睁眼」图标一键取消隐藏
- 数据库新增 `hidden` 表记录被隐藏的路径；文件夹隐藏后其中所有内容一起不可见；重命名会同步隐藏记录
- 新增接口 `POST /files/hide`：`{path, hidden}`，仅管理员可用（普通用户 403）
- 剪切文件后，被选中的条目半透明显示（opacity 0.42），提示"待移动"；粘贴或重新复制后恢复
## beta 2026.1108.24 — 清理「更多」按钮、回收站名称与单击行为

- 桌面端去掉工具栏最右侧的「更多」按钮：桌面没有二级菜单，点了没有任何反应；移动端仍然保留（那里要靠它展开视图/主题等次级功能）
- 回收站条目只显示文件或文件夹**名称**，不再把原路径拼在名字里（如「文件夹1」而不是「文件夹1/子目录/深层.txt」）；完整原路径放在悬停提示里
- 回收站里单击整行改为**选中**（勾选），不再跳去原目录——原来的跳转是由 `folder-name` 类误触发的
## beta 2026.1108.25 — 后台事件分页

- 「最近事件」改成**分页**，每页 10 条，底部带「← 上一页 / 第 X / Y 页 · 共 N 条 / 下一页 →」，首页/末页按钮自动置灰
- `/admin/events` 支持 `page` 参数，返回 `{events, total, page, per_page, pages}`；越界页码自动夹到有效范围
- 数据层新增 `db.list_events(limit, offset)` 与 `db.count_events()`，不再一次拉 100 条
## beta 2026.1116.1 — 控件 UI 改造为 WinUI 3 风格

参考 [WinUIonWeb](https://github.com/Furry-Xiyi/WinUIonWeb)（Vue 实现的 WinUI 控件库）的设计 token 与控件形态，把界面控件统一到 WinUI 3 规范：

- **设计 token**：改用 WinUI 官方色值——`app-bg` #F3F3F3 / #202020、`card-bg` rgba(255,255,255,.70) / rgba(255,255,255,.0512)、文本四级灰度、`ControlCornerRadius` 4px、`OverlayCornerRadius` 8px、强调色 #0067C0 / #4CC2FF
- **字体与动效**：Segoe UI Variable 字体栈；过渡统一为 167ms `cubic-bezier(0,0,0,1)`；键盘聚焦为 WinUI 双色焦点圈
- **按钮**：工具栏按钮改为 CommandBar 的 Subtle 风格（32×32、4 圆角、悬停 SubtleFill）；上传/登录/保存为主色 AccentButton（无投影、按下变暗）；取消/分页为 SecondaryButton（CtrlFill + 上浅下深描边）
- **输入框**：TextBox/ComboBox 形态——CtrlFill 填充 + 1px 描边，聚焦时底边变 2px 强调色、填充变亮，下拉箭头改为自绘
- **复选框**：自绘 WinUI CheckBox（20×20、4 圆角、选中强调色填充 + 对勾、支持半选）
- **导航**：NavigationView 项 36 高、4 圆角、悬停 SubtleFill、选中 SubtleFill + 3×16 强调条
- **列表/卡片**：ListView 行 40 高、悬停 SubtleFill、选中细边框；卡片改为 CardBackground + CardStroke + 8 圆角、去掉重投影
- **对话框**：Flyout 亚克力背景（blur 30px + saturate 1.25）、8 圆角、1px 边框、20px 标题
- **滚动条**：WinUI 细滚动条（12px 轨道、圆角滑块、悬停变粗）
- 顺带修复：`color-scheme` 跟随主题，原生下拉/滚动条在深色下不再发白
## beta 2026.1116.2 — 修复搜索框样式、恢复 100% 缩放

- 修复搜索框「双层边框」问题：通用 TextBox 规则（`input[type="text"]`）在文件末尾，同优先级覆盖了 `.search-box input`，导致搜索框内部又套了一层填充与描边、高度被挤压。现在为搜索框内部输入框单独提高特异性并清空内层外观，外层容器只保留一层 WinUI TextBox 视觉
- 搜索框聚焦不再改变宽度（去掉 160→200 的跳动），聚焦时只改填充与底边强调线
- 界面缩放从 120% 恢复为 **100%**：移除 `html { zoom: 1.2 }` 与移动端的 zoom 覆盖，各控件按 WinUI 原始尺寸（32 高、14 字号）呈现
## beta 2026.1116.3 — 动画对齐 WinUI 3

按 WinUI 主题资源里的动效参数重做交互反馈，控件外观不变但动效统一：

- **时长/曲线**：`ControlFastAnimationDuration` 167ms、`ControlNormalAnimationDuration` 250ms、`ControlFasterAnimationDuration` 83ms；曲线统一 `cubic-bezier(0, 0, 0, 1)`（FastOutSlowIn），另备 decelerate / accelerate 两条
- **TextBox 聚焦**：底部强调线由 `::after` 从中心向两侧展开（250ms），不再是瞬间变色
- **CheckBox**：勾选时对勾从 0.4 倍放大淡入（167ms），背景同步过渡
- **Flyout / 对话框**：淡入 + 轻微下移收拢（167ms），遮罩层单独淡入，不再把对话框内容一起变透明
- **视图切换**：EntranceThemeTransition 风格——淡入 + 12px 上移（250ms）
- **导航指示条**：切换时 250ms 平滑过渡（原先 167ms）
- **按下反馈**：按钮按下用 83ms，比悬停（167ms）更快
- **主题切换**：瞬时切换（临时关闭过渡），与 WinUI 一致，不再整页渐变
- **拖拽遮罩 / 上传提示**：淡入淡出 167ms
- **减少动画**：遵循系统 `prefers-reduced-motion`，此时全部动画降为 1ms
- 滚动区域加 `scroll-behavior: smooth`（对齐 ScrollViewer 平滑滚动）
## beta 2026.1117.1 — 接入 WinUIonWeb 组件库（登录页首批迁移）

按需求改用 [winuionweb](https://www.npmjs.com/package/winuionweb)（WinUIonWeb 发布的 Vue 3 组件库）替代手写控件：

- **静态接入，无需构建**：把组件库与 Vue 运行时放进 `static/vendor/`，页面用 `importmap` 直接加载 ESM
  - `vue.esm-browser.prod.js`（165 KB）
  - `winuionweb/index.js`（2.3 MB）+ `winuionweb/style.css`（473 KB）
  - `mathlive-ssr-shim.js`：组件库只对数学公式控件用到 MathLive，用 10 行垫片替代 2 MB 运行时
- **登录页**改用组件渲染：`TextBlock` / `TextBox` / `PasswordBox` / `Button`（AccentButtonStyle）/ `InfoBar`
  - 提交仍走原生 `<form method="post">`（组件只负责界面，值写入隐藏域后原生提交），登录行为与之前完全一致（实测 302 → /）
  - 错误提示改为 `InfoBar`（Severity=Error），带图标与红色语义背景
  - 增加了 `<noscript>` 回退与「组件加载失败回退到基础表单」兜底
- 新增 `/static/winui-demo.html` 组件样例页，可直接查看 Button / TextBox / CheckBox / ToggleSwitch / ComboBox / Slider / ProgressBar / InfoBar 的实际渲染
- 说明：文件列表、工具栏、后台页面仍由现有实现渲染，后续可按页面逐步迁移（列表涉及上传/拖拽/多选，需单独排期）
## beta 2026.1117.2 — 工具栏改用 winuionweb 组件

主界面的工具栏从手写 HTML 改为 Vue + winuionweb 组件渲染，逻辑仍由原 App.js 驱动：

- 新增 `static/shell.js`：用组件库渲染 6 个图标按钮（新建文件夹 / 视图切换 / 复制 / 剪切 / 粘贴 / 主题）、上传 AccentButton、清空回收站、移动端「更多」
- 引入 `importmap`（vue / winuionweb / mathlive 垫片），首页免构建加载组件库
- **状态桥接**：`window.WinUIShell` 暴露 `setViewMode` / `setTheme` / `setTrashMode` / `setClipboard`，App.js 在切换视图、换主题、进出回收站、选择变化时同步过去；组件挂载后调用 `window.syncShell()` 回灌一次当前状态
- 按钮点击直接调用原有全局函数（`createFolder` / `toggleViewMode` / `copySelection` / `pasteSelection` / `toggleTheme` / `emptyTrash` / `toggleMoreMenu`），文件列表、上传、拖拽逻辑零改动
- 视图切换按钮的图标随当前视图变化（列表↔图标），主题按钮图标随明暗切换
- 实测：点击组件按钮后 `file-list-container` 的类正确切换到 `view-grid`，说明事件与桥接都生效
## beta 2026.1117.3 — 侧边栏改用 winuionweb 组件

侧边栏整体改为 Vue + 组件库渲染（`static/shell.js` 新增 Sidebar 组件）：

- **品牌**：组件图标 + `TextBlock`，用户名从 `body[data-username]` 注入
- **搜索**：`TextBox` 组件，onUpdate:Text 直接调 `handleSearch`；`WinUIShell` 暴露 `getSearch / setSearch / focusSearch`，App.js 里原 `#search-input` 的 5 处读写改为走桥接（保留原生 fallback）
- **导航**：4 个 `Button` 组件（主页 / 我的文件 / 回收站 / 管理后台），`setActiveNav` 驱动选中态与左侧 3×16 强调条；管理员项按 `body[data-admin]` 决定是否渲染
- **存储**：`setStorage` 桥接文字、tooltip 与进度百分比（原 `updateStorageInfo` 计算后同步）
- **底部**：背景 / 退出登录用 `Button` 组件，点击调用原全局函数
- `syncShell()` 在组件挂载后回灌导航、搜索关键词、视图模式、主题、剪贴板状态与存储用量

配合上一版的工具栏，**主界面的外壳（侧边栏 + 工具栏）已全部由组件库渲染**，文件列表与后台页仍为原生实现。
## beta 2026.1117.4 — 主界面重写为 Vue 应用（去掉桥接）

按需求不再用「原 DOM + 桥接」的混合模式，主界面整体重写为 Vue 3 应用，全部由 winuionweb 组件渲染：

**新结构（static/winui/）**
- `api.js`：后端接口封装（列表 / 文件操作 / 分享 / 背景 / 模糊 / 用量）
- `store.js`：响应式状态与业务动作（导航、排序、搜索、多选、剪贴板、回收站、分享、主题、背景）
- `upload.js`：上传逻辑移植（小文件直传 + 大文件分片、CRC Worker 校验、4 并发、断点续传、合并轮询、取消）
- `components.js`：Sidebar / Toolbar / Breadcrumb / FileList（列表 + 网格）/ SelectionBar / UploadPanel / ShareModal / BackgroundModal / ToastBar
- `main.js`：挂载、上传选择器、拖拽上传、Socket 实时刷新、移动端抽屉

**删除的旧实现**
- `static/App.js`（约 1400 行 DOM 操作）、`static/shell.js`（上一版的桥接外壳）、`static/App1.js`、`static/App2.js`
- `templates/index.html` 只剩骨架与挂载点，不再引用任何旧脚本

**行为说明**
- 文件操作全部走同一套 API，列表、排序、搜索、多选、复制/剪切/粘贴、重命名、删除、回收站、分享、隐藏与原版一致
- 大文件上传仍走分片 + 断点续传 + CRC 校验，进度与速度显示在右下角上传面板
- 拖拽上传、Socket 实时刷新保留
- 主题、背景图、模糊参数从 `/auth/me` 与 `/prefs/*` 读写，与之前一致
## beta 2026.1117.5 — 修复侧边栏开关

重写后侧边栏在桌面宽度下没有可见的开关（汉堡按钮只在窄屏显示），点上去自然"没反应"。现在两种模式都能切换：

- **桌面**：左上角汉堡按钮常显，点击整列收起/展开；收起后主内容区铺满（实测 paneLeft 246→16、paneW 1134→1364）
- **窄屏（≤900px）**：点击按钮打开/关闭抽屉，遮罩同步显示；点击导航项后抽屉自动收起
- 折叠状态记在 `localStorage.fluent_sidebar`，刷新后保持
- 窗口从窄变宽时自动清掉抽屉状态，避免遮罩残留
- 侧边栏导航本身的切换已实测正常（点击"回收站"会请求 `/api/trash` 并更新面包屑与选中态）
## beta 2026.1117.6 — 侧边栏开关加固 + 静态资源防缓存

- **汉堡按钮层级**：抽屉打开时按钮会被侧栏（z-index 1100）盖住导致点不到、关不上。现在按钮自身 `position:relative; z-index:1300`，抽屉打开时 `.header` 也提到 1200 之上，同一个按钮始终可点
- **静态资源防缓存**：`main.js` 引用加上 `?v=<版本号>`，避免浏览器继续使用旧的模块缓存；版本号由服务端渲染注入
- 修正 `render_template` 里版本变量名（应为 `version.VERSION`），否则首页会 500
## beta 2026.1117.7 — 修复「切换选项卡没反应」

根因有两个：

1. **视图状态要等接口返回才更新**：`loadTrash` / `loadRecent` 里是 `await` 之后才设 `state.view`，点击瞬间界面毫无变化；接口慢或失败时看起来就是「点了没反应」。现在 `navTo` 先同步切视图、清空列表、改面包屑，界面立刻显示「正在加载」，再拉数据
2. **面包屑名称写死**：第一级一律显示「主页」，所以点进回收站后面包屑仍是「主页」，视觉上完全没变化。现在按实际视图显示「回收站 / 管理后台」

顺带：

- 回收站/管理后台的面包屑点击可返回「我的文件」
- 汉堡按钮层级加固（抽屉打开时也能点）
- `main.js?v=<版本>` 防止浏览器继续用旧缓存
## beta 2026.1117.8 — 选项卡切换动画对齐 WinUI

上一版重写把视图切换动画弄丢了（内容直接瞬变）。现在按 WinUI 的动效参数补回：

- **内容区进入**：`EntranceThemeTransition` 风格——淡入 + 12px 上移，250ms `cubic-bezier(0,0,0,1)`
- **触发条件**：切换选项卡（主页/我的文件/回收站/管理后台）或进入文件夹时重建列表节点，动画自动重播；切换列表/网格视图同样触发
- **列表行**：逐行错峰出现（每行 +12ms 延迟，前 8 行），167ms FastOutSlowIn
- **导航选中指示条**：出现时从 20% 高度拉伸到满高 + 淡入（167ms），对齐 NavigationView 的 selection indicator
- **导航项文字/图标**：颜色变化加 167ms 过渡，不再是瞬间变色
- **面包屑**：当前项 4px 位移淡入
- 全部沿用 WinUI 时长 token：83 / 167 / 250ms，曲线 `cubic-bezier(0,0,0,1)`
## beta 2026.1117.9 — 侧栏选中指示条改为滑动

之前每条导航项各有一个 `::before` 指示条，切换时旧条消失、新条出现，没有"滑过去"的动作。现在改成**单一指示条元素**：

- 指示条绝对定位在 `.side-nav` 内，根据当前选中项的 `offsetTop`/`offsetHeight` 计算位置，用 `transform: translateY()` 过渡
- 切换时 250ms `cubic-bezier(0,0,0,1)` 从旧项滑到新项（对齐 WinUI NavigationView 的 SelectionIndicator）
- 首次渲染 / 窗口缩放 / 折叠展开时无动画直接落位，避免初始闪动
- 原有伪元素指示条停用

实测：初始 `translateY(52px)`（"我的文件"），点击"回收站"后滑到对应位置，过渡时长 0.25s。
## beta 2026.1117.10 — 四项修复

1. **搜索框聚焦蓝线溢出**：全局 `input:focus` 的 inset 阴影也作用到了组件库 TextBox 内部的 input 上，和组件自带的聚焦线叠成一条超出圆角边框的蓝线。现在挂载点内的 input 不再套用全局聚焦样式，只保留组件自己的强调线
2. **侧边栏折叠没有动画**：之前是 `display:none` 硬切。桌面宽度下改为宽度 / 透明度 / 内边距 250ms 过渡（`.sidebar` 宽度收到 0、透明度淡出），主内容区同时平滑变宽；窄屏抽屉仍用 `transform` 动画
3. **登录页宽度**：卡片 `max-width` 从 360px 改回原来的 340px，内边距收回到 30/26px
4. **管理后台看不到**：之前 iframe 塞在 `.file-list-container` 里，容器高度不确定时 iframe 会被压成 0 高。现在管理后台是独立的全高视图（`.admin-view` + `.admin-frame` flex 铺满，`min-height:70vh`），不再受列表容器布局影响
## beta 2026.1117.11 — 后台视图高度加固 + 状态栏显示版本号

- **管理后台**：`.admin-view` 与 iframe 改为显式高度（`calc(100vh - 132px)` / 最小 520px），彻底避免父容器 flex 塌陷导致 iframe 高 0 而"一片空白"；`admin-mode` 下隐藏列表容器
- **状态栏版本号**：右下角现在会显示当前运行版本（如 `beta 2026.1117.11`），可用来确认浏览器/服务是否已加载新代码
- 说明：`index.html` / `login.html` 是 Jinja 模板，**改模板后必须重启 CloudStorage 服务**才会生效（浏览器刷新不够）
## beta 2026.1117.12 — 后台改为直接跳转 + 诊断面板

- **管理后台**：点击后不再用 iframe，直接 `location.href = '/admin'` 进入后台页（后台自带返回文件列表），彻底避开 iframe 在复杂 flex 布局下被压成空白的问题
- **登录页**：卡片宽度 340px → **380px**，内边距 34/30，标题图标 24px；如果仍觉得不合适，告诉我具体期望宽度直接改数字
- **诊断面板**：访问 `/?diag=1` 会在右下角显示实时状态（版本 / 当前视图 / 角色 / 列表条数 / iframe 尺寸 / 侧栏 display），出现「看起来没变化」时用它一眼定位
## beta 2026.1117.13 — 登录卡片真正变宽 + 后台回到同页

**登录卡片为什么之前改宽度没效果**：Vue 渲染的根节点是主题作用域 `div`，它是 `#app`（flex 容器）的子项，宽度按内容收缩，所以 `.login-card` 的 `width:100%` 只能撑到内容宽（约 235px），`max-width` 调多大都没用。

- 给 `#app > div` 加 `width:100%; display:flex; justify-content:center`，卡片的 `max-width: 480px` 才真正生效
- 卡片内边距 40/36、标题图标 24px、间距加大；实测宽度 480px

**后台**：恢复同页 iframe（不再单独跳一页），但改成**整窗覆盖**的固定定位层：

- `.admin-view { position: fixed; inset: 0; z-index: 1400 }`，内部纵向排列「← 返回文件列表」+ iframe
- 不再依赖任何父容器高度，`iframe { flex:1; min-height:0 }` 所以在任何布局下都铺满
- 顶部返回按钮直接切回文件列表
## beta 2026.1117.14 — 定位根因：position:fixed 被祖先包含块吃掉

**根因（用 CDP 探针实测）**：管理后台视图渲染后 `offsetWidth/Height = 0`。

`.container` 上有 `backdrop-filter: blur()` / `overflow: hidden`，会为后代 `position: fixed` 元素建立 **包含块**，于是 `inset: 0` 不再相对视口，而是相对那个容器——容器在后台视图下高度为 0，整个覆盖层就被压成 0×0：DOM 里有、屏幕上什么都没有。

**修复**：所有 fixed 浮层统一用 Vue `<Teleport to="body">` 挂到 `body` 下，彻底脱离容器的包含块与裁剪：

- 管理后台 `.admin-view`（实测 1600×900，iframe 1576×830）
- 分享弹窗、背景弹窗（实测 mask 1600×900，父级 BODY）
- 上传面板、右下角提示

**登录卡片**：480px 收回到 **400px**（内边距 36/32），避免矫枉过正。

**探针工具**：新增 `tools/probe.mjs`（CDP 驱动，可登录、点击、读 DOM 尺寸、截图），以后能实测而非靠猜。
## beta 2026.1117.15 — 后台嵌回主内容区

不再整窗覆盖，也不再单独一页：管理后台**嵌在主内容区**显示，侧栏、搜索、工具栏都还在。

**第二个根因（又一条旧规则）**：`body.admin-mode .main-pane .container { display: none }` 是旧版 App.js 把后台铺满整页时留下的，它把整个内容容器隐藏了 —— 所以后台视图无论怎么定位都是 0×0。这条规则已删除。

实测（CDP 探针，登录态）：

`
#winui-app   : 1166×822
.vue-main    : 1166×822  (position: relative)
.admin-view  : 1166×822  (position: absolute, inset: 0)
#admin-frame : 1166×774
`

- `.vue-main` 设为 `position: relative`，`.admin-view` 用 `absolute; inset: 0` 填满内容区
- 顶部「← 返回文件列表」+ 标题，iframe 填满剩余高度
- 分享/背景弹窗、上传面板、右下角提示仍 Teleport 到 body（这些是真正的浮层，需要相对视口）
## beta 2026.1117.16 — 后台区域与文件区域统一

- **去掉额外的返回条**：不再有「← 返回文件列表」那一行，后台和普通选项卡一样只靠面包屑（显示「管理后台 /」）
- **位置一致**：后台占的是文件列表那一块（`flex: 1`），面包屑、工具栏、侧栏都在，不再覆盖标题行
- **进入动画一致**：`.admin-view.show` 用与列表相同的 `vueViewEnter`（淡入 + 12px 上移，250ms FastOutSlowIn）
- **白闪原因**：之前后台是条件渲染，每次切换都会重建 iframe → 重新请求 `/admin` → 页面白屏一瞬。现在 iframe **常驻**，首次进入才加载，之后只切换 `display`，再进入不再白闪
- 实测：进入 1166×786 + `vueViewEnter 0.25s`；离开后 src 保持；再次进入 display 切换且 src 不变
## beta 2026.1117.17 — 后台宽度对齐 + 弹窗按钮改用组件样式

- **后台宽度**：`.admin-view` 补上与 `.file-list-container` 相同的 `margin: 0 16px 4px`，后台内容不再比文件列表宽
- **弹窗按钮**：背景弹窗的「选择图片 / 恢复默认」、选择条的「删除 / 取消」不再套自定义 `.sel-btn` 样式，改用组件自身的 `AccentButtonStyle` / 默认样式——按钮的可点区域与视觉完全一致（实测 rect 80×32，内部承载层同为 80×32），颜色也走组件主题（深色主题下 Accent 为亮蓝底黑字）
## beta 2026.1117.18 — 上传按钮尺寸修正

上一版只修了弹窗按钮，上传按钮还留着自定义 `padding: 0 12px`：外层 `<button>` 被 padding 撑大，而组件内部的承载层保持自己的尺寸，于是出现「点击范围比蓝色块大」。

现在上传按钮和工具栏图标按钮都不再覆盖内边距，只锁高度：

`css
#winui-toolbar .winui-upload-btn { height: 32px; min-height: 32px; padding: 0; }
#winui-toolbar .winui-icon-btn   { width: 40px; height: 32px; padding: 0; }
`

实测（CDP 读 DOM，登录态）：

| 按钮 | 外层 rect | 内部承载层 | 是否一致 |
|---|---|---|---|
| 上传 | 52×32 | 52×32 | ✅ |
| 工具栏图标 | 40×32 | 40×32 | ✅ |
| 侧栏选中项 | 196×36 | 196×36 | ✅ |
| 文件行内操作 | 32×32 | 18×18（图标） | 图标按钮的正常留白，hover 有整块底色反馈 |
## beta 2026.1117.19 — 按钮悬浮对比加强、去掉底部边框、后台卡片圆角

**悬浮态**（深色 / 浅色分别取值）：

| 元素 | 之前 | 现在 |
|---|---|---|
| 工具栏图标按钮、行内操作 | 6% 白（很淡） | **10% 白** / 浅色 7.5% 黑 |
| 按下 | 4% | **16%** / 12% |
| 侧栏导航项 | 6% | 8% / 5% |
| Accent（上传 / 选择图片 / 删除） | 无变化 | 深色 `rgba(76,194,255,.92)`，浅色 `--accent-hover` |

**去掉按钮底部边框**：组件默认有一条更深的 `border-bottom`（`--ButtonBorderBrushBottomCurrent`）。今天统一把工具按钮、行内操作、弹窗按钮、选择条按钮的边框厚度与各方向画笔都设成透明，实测 `border-bottom-width = 0px`。

**后台卡片圆角**：`.admin-view` 之前是裸 iframe，没有卡片底色和圆角，滚动到中间时与文件列表的视觉不统一。现在补上与 `.file-list-container` 一致的 `background / border / border-radius / overflow: hidden`，iframe 整体是一张圆角卡片，滚动时边缘也不会破。
## beta 2026.1117.20 — 修正悬浮态：不再染灰 Accent、对比度回落、弹窗恢复主题

**「选择图片」悬浮变灰的原因**：上一版给普通按钮加 hover 规则时没有排除 Accent 按钮，而组件里 `--ButtonBackgroundPointerOver` 在 Accent 样式下本应映射到 `--AccentButtonBackgroundPointerOver`——被直接覆盖成白色半透明，于是蓝按钮一 hover 就变灰。现在普通按钮的规则全部加上 `:not(.AccentButtonStyle)`。

**Accent 悬停改成变亮**（而不是 WinUI 默认的略微变暗）：

| 主题 | 常态 | 悬停 | 按下 |
|---|---|---|---|
| 深色 | #4CC2FF | #7AD4FF | #38B4F0 |
| 浅色 | #0067C0 | #1A7FD0 | #005A9E |

**对比度回落**：普通按钮 hover 从 10% 降到 7%（浅色 5%），按下 12%（浅色 9%）。

**弹窗颜色错乱的根因**：分享/背景弹窗、上传面板被 Teleport 到 body 后脱离了 `win-theme-scope` 容器，组件读到的是浅色主题的默认变量（实测「恢复默认」按钮常态背景为 rgba(255,255,255,.7)）。现在这些浮层的根元素自带 `win-theme-scope theme-dark/theme-light`，实测恢复为 rgba(255,255,255,.06)。

实测（CDP 鼠标悬停）：

```
上传按钮   #4CC2FF -> #7AD4FF
图标按钮   透明 -> rgba(255,255,255,.07)
弹窗 Accent #4CC2FF -> #7AD4FF
弹窗默认   透明 -> hover 后 .07
```
## beta 2026.1117.21 — 后台分区层次修正

- **右侧圆角被吃掉**：`body.embed` 之前 `padding: 0`，卡片直接顶到容器边缘，卡片自己的圆角被容器裁成直角。现在 embed 模式四周留 **12px**，卡片与边缘之间有间隙，卡片圆角与容器圆角都能看到
- **块之间的间隙改成背景色**：`.admin-view` 外层背景从 `--card-bg`（半透明白，与卡片同色，层次糊在一起）改为 **`--bg-color`**（页面背景色），实测 `rgb(32,32,32)`
- **每块卡片**保持 `--card-bg` + `--card-stroke` + `OverlayCornerRadius`，与文件列表页的卡片一致
- 卡片之间补了 12px 间距（`body.embed .card + .card { margin-top: 12px }`）

实测：`.admin-view` 1166×782、`background rgb(32,32,32)`、`border-radius 8px`、`overflow hidden`
## beta 2026.1117.22 — 外观新增「背景不透明度」「主界面容器不透明度」

背景设置弹窗现在有四个滑块：

| 选项 | 范围 | 作用 |
|---|---|---|
| 背景不透明度 | 0–100% | 背景图的整体透明度（`body.has-bg::before { opacity }`） |
| 背景模糊 | 0–30px | 背景图的 `filter: blur()` |
| 主界面容器不透明度 | 0–100% | 列表卡片 / 弹窗 / 表头的底色浓度（`color-mix` 按比例淡化 `--card-bg`） |
| 文件区域模糊 | 0–40px | 卡片背后内容的毛玻璃强度 |

**存储**：`users` 表新增 `bg_opacity`、`panel_opacity` 两列（启动时自动 `ALTER TABLE` 迁移，默认 100），`/prefs/blur` 与 `/auth/me` 同步扩展，登出再登录仍保留。

**实现**：
- CSS 变量 `--bg-opacity`、`--panel-alpha`，由 store 写入 `document.documentElement`
- 卡片底色 `background: color-mix(in srgb, var(--card-bg) calc(var(--panel-alpha) * 100%), transparent)`，有背景图时同样处理深/浅两套底色
- 拖动滑块即时生效，400ms 防抖后写库

实测：
```
滑块 4 个：背景不透明度100% / 背景模糊0px / 主界面容器不透明度100% / 文件区域模糊24px
保存后 /auth/me 返回 bg_opacity=60, panel_opacity=50, blur_bg=6
--panel-alpha=0.5 时卡片背景 alpha 从 0.0512 降到 0.0256（oklab 计算值）
```
## beta 2026.1117.23 — 后台右圆角修复 + 存储块背景还原

**右圆角还是直角的原因**：`.admin-view` 同时写了 `width: 100%` 和 `margin: 0 16px`，实际宽度变成「容器宽 + 32px」，右侧溢出 16px 被容器 `overflow: hidden` 裁掉——圆角正好在被裁的那一侧。

改成 `align-self: stretch` + 去掉 `width: 100%`，实测：

```
.admin-view  left=346  right=1480  width=1134
.vue-main    left=330  right=1496  width=1166
右侧间隙 -16px（即留出 16px 边距，不再溢出）
```

**存储容量块背景不一样**：上一版给「容器不透明度」加 `color-mix` 规则时，选择器里误包含了 `.side-storage`，导致侧栏的存储区块多出一层卡片底色。已从该规则移除，并显式设为 `transparent`，实测背景回到 `rgba(0, 0, 0, 0)`。
## beta 2026.1117.24 — 后台「启用/关闭」改为开关，下拉改为自绘

- **布尔配置改成 WinUI ToggleSwitch**：40×20 圆角轨道 + 滑块，关闭态灰轨白点、开启态蓝轨黑点，滑块在开启时放大到 16px 并有 167ms FastOutSlowIn 过渡；右侧文字随状态在「已启用 / 已关闭」之间同步
- **下拉菜单全部替换**：新建用户的角色选择改成自绘 ComboBox（按钮 + 浮层列表，带展开箭头旋转、选中高亮、点击外部/Esc 收起）；配置里的 bool 项不再用 select，整页 `select` 数量为 0
- `saveConfig()` 收集逻辑照顾 checkbox：勾选写 `true`，未勾选写 `false`（原来是取 `.value`，checkbox 会被误读成 `on`）
- 角色下拉保留隐藏 input `#new-role`，`createUser()` 逻辑不用改

实测：后台页 4 个开关（已启用 1 个）、`.win-switch` 轨道 40×20、下拉默认值 `user`、残留 `select` 数 0
## beta 2026.1117.25 — 下拉浮层不再被遮挡 + 展开动画

**被挡住的原因**：`.card` 上有 `backdrop-filter`，每个卡片都会自成层叠上下文；后面的「修改密码」卡片按文档顺序压在「用户」卡片之上，于是角色下拉展开时被盖住一半。

修复两层：
- 浮层 `z-index: 900`
- 卡片展开时整体上浮：`.card:has(.win-combo.open) { position: relative; z-index: 30; }`（`:has()` 在 Edge 105+ 可用）

实测：浮层 rect 254×103 完整可见，`document.elementFromPoint` 命中的是 `combo-item`（不再是下面的卡片）。

**展开动画**：与 WinUI Flyout 一致——`opacity 0→1` + `translateY(-6px)→0` + `scale(0.98)→1`，167ms `cubic-bezier(0,0,0,1)`，`transform-origin: top center`；收起时同样 167ms 反向，`visibility` 延迟 167ms 切换（避免过渡被 display 打断）。
## beta 2026.1117.26 — 下拉浮层加亚克力模糊、菜单项拉开间距

- **模糊**：`.combo-list` 底色改成半透明 `rgba(44,44,44,.82)` 并加 `backdrop-filter: blur(30px) saturate(1.25)`，与主界面弹窗的亚克力质感一致
- **菜单项重叠**：原来 `.combo-item` 只有 `padding: 7px 10px`、相邻项背景直接贴合。现在浮层改用 `flex-direction: column` + `gap: 2px`、内边距 6px，单项 padding 提到 `8px 10px` 并加 `line-height: 1.35`，实测三项高度均 34px、间隔 2px，不再相互压边

实测：`backdrop-filter: blur(30px) saturate(1.25)`；底色 `rgba(44, 44, 44, 0.86)`；item rect 分别为 [596,34] [631,34] [667,34]
## beta 2026.1117.27 — 下拉模糊真正生效 + 后台输入框限宽

**模糊为什么没效果**：两层原因叠加——
1. `.combo-list` 用的是 `var(--flyout-bg)`，这个变量本身就是 `rgba(44,44,44,.86)`，86% 不透明，后面根本没多少东西可模糊
2. 打开态还留着 `transform: translateY(0) scale(1)`（非 none），部分浏览器会因此忽略 `backdrop-filter`

修复：
- 底色改用 `color-mix(in srgb, var(--flyout-bg) 55%, transparent)` 稀释到约 47% 不透明
- 打开态 `transform: none`
- 模糊强度 `blur(30px) saturate(1.6)`

实测 `background: color(srgb 0.1725 0.1725 0.1725 / 0.472)`，浮层下方内容明显透出并虚化。

**输入框变短**：`.field` 是 `220px 1fr` 两列，控件列会铺满整个剩余宽度。现在给控件列和输入框都加 `max-width: 380px`，13 个输入框实测宽度统一 380px，开关/下拉不受影响（开关 99px、下拉 254px）。
## beta 2026.1117.28 — 后台控件右对齐 + 下拉遮挡修正

- **控件居右**：`.field > div:last-child` 改为 `flex` + `align-items: flex-end` + `justify-self: end`，输入框 / 开关 / 下拉都贴右侧。实测输入框右缘 1227 与字段右缘 1227 完全对齐，宽度 380px
- **下拉遮挡**：上一版为了露出模糊把底色稀释到 47%，结果不支持 `backdrop-filter` 的环境（如禁用 GPU）下面板近乎透明，和下面的文字叠在一起。现在底色固定 `rgba(38,38,38,.90)` + `blur(24px) saturate(1.4)` + 阴影：支持模糊时是亚克力，不支持时也有 90% 遮挡
## beta 2026.1117.29 — 后台容器跟随「不透明度 / 模糊度」

之前只有主界面的文件容器吃 `--panel-alpha` / `--panel-blur`，后台 `.admin-view` 写死了底色和 `blur(24px)`，所以调滑块对后台没反应。

- `.admin-view.show` 改用 `color-mix(in srgb, var(--card-bg) var(--panel-alpha), transparent)` + `backdrop-filter: blur(var(--panel-blur))`，与文件容器同一套变量
- **iframe 内部**是独立文档，继承不到父页面变量：新增 `syncFrameVars()`，用 `iframe.contentDocument.documentElement.style` 把 `--panel-alpha / --panel-blur / --bg-opacity / --bg-blur` 写进去；`applyOpacity` / `applyBlur` 每次变更都会调用，iframe 加载完成时也同步一次
- `admin.html` 的 `.card` 背景改成 `color-mix(... var(--panel-alpha) ...)`、模糊改成 `var(--panel-blur)`

实测（把 `--panel-alpha` 设为 0.45、`--panel-blur` 设为 8px）：

```
.admin-view 背景  color(srgb 1 1 1 / 0.0510)
iframe .card 背景 color(srgb 1 1 1 / 0.0229)   ← 0.0512 × 0.45
iframe .card 模糊 blur(8px) saturate(1.25)
```
## beta 2026.1117.30 — 修复浅色主题下不透明度不生效

**根因**：`color-mix()` 里的百分比位置我写成了 `calc(var(--panel-alpha, 1) * 100%)`。这个写法在 Edge 里会让整条 `background` 声明失效，浏览器回退到更早的规则（固定值），所以滑块怎么拖都没反应；深色主题看起来"能动"其实是回退后碰巧是深色值。

**修法**：让变量直接就是百分比字符串，color-mix 里不再套 calc——

```css
background: color-mix(in srgb, var(--card-bg) var(--panel-alpha, 100%), transparent);
```

JS 端写变量时改成 `--panel-alpha: 40%`（原来是 `0.4`）。`--bg-opacity` 仍保持 0~1 数值（用于 `opacity`）。

实测（同一元素，切换主题 + 改变量）：

| 场景 | 容器 alpha |
|---|---|
| 深色 100% | 0.0510 |
| 深色 40% | 0.0205 |
| 浅色 100% | 0.6740 |
| 浅色 40% | 0.2852 |
| 浅色 模糊 6px | blur(6px) saturate(1.25) |
## beta 2026.1117.31 — 「管理后台」移到侧栏底部

- 导航区只保留「主页 / 我的文件 / 回收站」
- 底部区顺序变成：存储 → 背景 → **管理后台** → 退出登录
- 管理后台按钮沿用底部条目的样式与选中态（`.side-item.active` + 左侧指示条），窄屏点击后同样会自动收起抽屉
- 修掉一个连带错误：改成底部按钮时误用了不存在的 `navButton()` 函数，导致整个侧栏渲染中断（页面只剩主内容），已改为内联渲染

实测侧栏条目顺序：`主页 / 我的文件 / 回收站 / 背景 / 管理后台 / 退出登录`
## beta 2026.1117.32 — 切换主题时后台跟着换

**原因**：后台是 iframe，属于独立文档，只在**首次加载**时读过一次 `localStorage.fluent_theme`；之后主界面怎么切主题，iframe 里的 `data-theme` 都不会变，所以后台一直停在旧主题。

**修法**：`syncFrameVars()` 里同时写入 `data-theme`，并在 `applyTheme()` 末尾调用它——切换主题后立刻把 iframe 的 `data-theme`、`--panel-alpha`、`--panel-blur` 全量重灌一遍。

另外给 `theme-switching` 类加了 200ms 兜底移除（万一 `requestAnimationFrame` 没执行，过渡不会被永久禁用）。

实测：

```
切换前  主界面 dark   iframe dark
切换后  主界面 light  iframe light   卡片背景 color(srgb 1 1 1 / 0.702)
```
## beta 2026.1117.33 — 修复在线更新「能检测到新版本却下载不下来」

**原因**：`download_tree()` 先把远端 **37 个文件全部下载**再和本地对比，即使只有一个文件变了也要发 37 次 `git/blobs` 请求。网络稍慢或 API 限流时就会在中途失败，表现出来就是"版本能检测到，但一直下载不完"。

**改法**：

1. **本地 SHA 对比**：算出本地文件的 git blob SHA（`sha1("blob <len>\0" + 内容)`，CRLF 归一到 LF），和远端 tree 里的 sha 直接比较，**内容相同就跳过下载**。这样一次常规更新只下载真正变化的几个文件
2. **更长超时 + 重试**：单次请求 30s → 120s，遇到 5xx/429/网络错误自动重试 3 次（间隔 2/4 秒）
3. **限流提示**：403 时区分「rate limit」与「私有仓库未授权」，并显示额度重置时间、提示在 `config.ini` 的 `[UPDATE] token` 填令牌（60 次/时 → 5000 次/时）
4. **下载进度**：逐个打印 `下载 3/12  static/winui/main.js（7 KB）`

**实测**：

```
本地为最新     远端 37 个文件，36 个未变化（跳过），1 个需要下载   耗时 5.7s
改动 version.py 远端 37 个文件，35 个未变化（跳过），2 个需要下载  → ['update.py','version.py']
```

对比旧逻辑：同样场景要下载全部 37 个文件。
## beta 2026.1117.34 — 后台卡片颜色与主界面容器一致

**原因**：后台是「两层卡片」叠加——`.admin-view` 外层画了一层 `--card-bg`，iframe 里的 `.card` 又画了一层，两层各 5% 白叠起来约 10%，所以深色下后台明显比主界面亮一些、还发灰。

**修法**：外层只保留圆角裁剪，不再画背景。

```css
.admin-view.show {
    background: transparent;   /* 原来是 color-mix(--card-bg ...) */
    border-radius: var(--OverlayCornerRadius);
    overflow: hidden;
}
```

主界面是「页面背景 + 一层卡片」，后台现在是「页面背景（透过来）+ iframe 内一层卡片」，结构一致。

实测两者计算值完全相同：

```
主界面 .file-list-container  color(srgb 1 1 1 / 0.0510)  blur(24px) saturate(1.25)
后台   iframe .card          color(srgb 1 1 1 / 0.0510)  blur(24px) saturate(1.25)
后台   .admin-view           rgba(0, 0, 0, 0)（透明，只裁剪圆角）
```
## beta 2026.1117.35 — 有背景图时后台卡片底色跟主界面一致

**原因**：有背景图时，主界面容器会改用「更实的底」保证文字可读（深色 `rgba(18,20,26,.78)`、浅色 `rgba(255,255,255,.84)`），这套规则写在 `body.has-bg .file-list-container` 上。后台的 `.card` 没有对应规则，仍是 5% 白的 `--card-bg`——背景图直接透上来，两块区域一眼就能看出不一样。

**修法**：

1. `syncFrameVars()` 把 `has-bg` 类也同步进 iframe 的 `body`（`applyBackground()` 切换背景图时也会同步）
2. `admin.html` 补上对应规则：

```css
body.has-bg .card {
    background: color-mix(in srgb, rgba(18,20,26,.78) var(--panel-alpha,100%), transparent);
}
html:not([data-theme="dark"]) body.has-bg .card {
    background: color-mix(in srgb, rgba(255,255,255,.84) var(--panel-alpha,100%), transparent);
}
```

实测（深色 + 有背景图）：

```
主界面 .file-list-container  color(srgb 0.0706 0.0784 0.102 / 0.780)
后台   iframe .card          color(srgb 0.0706 0.0784 0.102 / 0.780)   ← 完全一致
iframe body class            "embed has-bg"
```
## beta 2026.1117.36 — 后台主题改为「自己跟随」，不再依赖父页面推送

之前后台主题靠父页面的 `syncFrameVars()` 推送，一旦父页面是旧缓存（模块没有版本号），iframe 就停在打开时的主题——表现就是「主界面深色、后台浅色、文字发暗」。

三层修复：

1. **iframe 自己跟随**：`admin.html` 在 `embed=1` 模式下每 600ms 读一次父窗口的 `data-theme` 和 `has-bg` 并同步（同源可直接访问）。即使父页面完全不推送，后台也会自己变
2. **静态资源不缓存**：`server.py` 给 `/static/*` 加 `Cache-Control: no-cache, must-revalidate`，升级后浏览器不会继续用旧 JS/CSS（这也解释了好几次「改了没效果」）
3. **进入后台时补一次同步**：`watch(state.view)` 里 `syncFrameVars()` + 300ms 后再补一次

实测（直接改父窗口主题，不走 store）：

```
浅色 + 背景图   frame=light  card=color(srgb 1 1 1 / 0.839)   文字 rgba(0,0,0,.89)
深色 + 背景图   frame=dark   card=color(srgb .0706 .0784 .102 / .780)  文字 rgb(255,255,255)
```
## beta 2026.1117.37 — 颜色回到 1117.33，主界面容器改成后台的样子

按需求把颜色相关的改动回退到 `1117.33`，然后反过来让**主界面**去对齐后台：

- **回退**：`.admin-view` 恢复成自己也画一层 `--card-bg`（后台 = 外层 + iframe 内卡片，两层叠加）；`admin.html` 去掉 `has-bg` 期间的卡片加深规则；主界面不再在背景图模式下单独加深
- **主界面对齐**：`.file-list-container` / `.file-header` / `.modal-card` / `.upload-toast` 改成「`background-color` + `background-image` 渐变」两层同色叠加，和后台的「外层 + 卡片」结构一致

实测（深色，两层 5% 白）：

```
主界面  background-color: color(srgb 1 1 1 / 0.0510)
        background-image: linear-gradient(同色, 同色)      ← 两层
后台    .admin-view: color(srgb 1 1 1 / 0.0510)
        .card     : color(srgb 1 1 1 / 0.0510)            ← 两层
```

**保留的功能改进**（不影响颜色）：静态资源 `no-cache`、iframe 自己跟随父窗口主题、进入后台时补一次外观同步。
## beta 2026.1117.38 — 更新脚本支持 GitHub 加速代理

`api.github.com` 能连、但 `raw.githubusercontent.com` / `codeload` 被拦，导致大文件下载容易断。现在文件内容改走加速代理。

**配置**（config.ini）：

```ini
[UPDATE]
repo   = Apkeniqo/CloudStorage
branch = main
token  = <可选>
proxy  = https://gh.dpik.top      # 默认值，可留空表示不用代理
```

> `https://github.akams.cn/` 是节点选择页面，实际加速节点是 `https://gh.dpik.top/`。格式为 `<代理>/https://raw.githubusercontent.com/<repo>/<branch>/<path>`。

**下载策略**：

1. 文件清单 / 哈希仍走 `api.github.com` 的 git tree（1 次请求）
2. 有变化的文件优先走**代理 raw**（带 3 次重试），失败自动回退 `git/blobs`
3. 版本检测先走 api，api 不通时改用代理读 `version.py`

**实测**：

```
代理直取 version.py            699 字节 ✓
改动本地文件后 download_tree   37 个文件，35 个未变化（跳过），2 个需要下载（8.9s）
                               update.py 15 KB / version.py 1 KB —— 都经代理下载成功
```
## beta 2026.1117.39 — 更新脚本抗断：代理熔断 + 断点续传

上一版代理请求被 `WinError 10054`（连接被重置）反复打断，每次要等 3 轮重试，卡在同一个文件上。

- **代理熔断**：代理对某个文件失败一次，立刻把本次运行的代理标记为不可用，**剩余文件全部改走 `api.github.com`**，不再逐个重试
- **边下边写**：每个文件下载成功立刻落盘（原来要全部下完才写），中断后重新执行会从断点继续（SHA 对比天然跳过已写入的）
- **失败不中断**：某个文件两条通道都失败时记录并在最后汇总，其余文件继续
- 修掉一个 `UnboundLocalError`：`download_tree` 里修改 `_PROXY_OK` 需要 `global` 声明

实测：

```
正常代理   3 个文件经代理下载成功           15.6s
坏代理     首个文件失败 -> 熔断 -> 剩余走 API  5.0s   3 个文件全部成功
```
## beta 2026.1117.40 — 更新脚本支持多加速节点

从 `https://github.akams.cn/` 页面抓到了它的节点池（页面会用每个节点探活一次 `raw.githubusercontent.com`，从网络请求里提取出节点域名）。

**实测可用性**（拉 `version.py`）：

| 节点 | 结果 | 耗时 |
|---|---|---|
| https://tvv.tw | ✓ 699 字节 | 1.25s |
| https://gh.dpik.top | ✓ 699 字节 | 1.32s |
| https://git.yylx.win | ✓ 699 字节 | 2.26s |
| https://ghproxy.net | ✓ 699 字节 | 4.23s |
| j.1lin.dpdns.org / gh.bugdey.us.kg / github.starrlzy.cn / j.1win.ggff.net | 连接失败 | — |
| cdn.gh-proxy.com | 302 跳转 | — |
| github-proxy.memory-echoes.cn | 429 限流 | — |

**改动**：

- `proxy` 支持**逗号分隔多节点**，内置默认值 `tvv.tw, gh.dpik.top, git.yylx.win, ghproxy.net`
- 逐个节点尝试，失败的节点本次运行内直接拉黑（`_BAD_NODES`），不会每个文件都重试一遍
- 单节点超时 60s → **20s**，坏节点不会拖住整体
- 全部节点失效才回退 `api.github.com`

**实测**（4 个文件）：

```
nodes = ['https://tvv.tw', 'https://gh.dpik.top', 'https://git.yylx.win', 'https://ghproxy.net']
下载 4/4 完成，15.7s，坏节点：set()   ← 第一个节点就成功
```
## beta 2026.1117.42 — 更新前节点测速，走最快的那个

- 新增 `probe_nodes()`：并发（最多 8 线程）让每个节点拉一次 `version.py`，记录耗时
- 结果按快慢排序，**选第一名作为本次更新的节点**；其余节点保留为后备（第一个中途失败会自动换下一个）
- 测不通的节点直接计入 `_BAD_NODES`，本次不再尝试
- 更新开始前打印测速表：

```
节点测速中（各拉一次 version.py）...
  1. https://ghproxy.net      2.08s
  2. https://git.yylx.win     2.14s
  3. https://tvv.tw           2.36s
选用节点：https://ghproxy.net（2.08s）
```

（`gh.dpik.top` 这一轮测速超时，被自动拉黑）

注意：节点快慢会随网络波动，所以每次都重新测，不缓存上一次的结果。
## beta 2026.1117.43 — 下载后校验内容，挡住代理缓存旧文件

**发现的问题**：代理有 CDN 缓存。`tvv.tw` 返回的 `update.py` 是 `1117.41` 的旧内容（18535 字节），而远端实际是 20371 字节——如果直接写盘，会把文件写回旧版本，而且因为远端 tree 的 SHA 没变，本地每次都会被判定为「需要更新」，陷入反复写入旧内容的循环。

**修法**：下载后立刻算 git blob SHA，与远端 tree 里的 SHA 比对：

```python
if expect_sha and git_blob_sha(data) != expect_sha:
    raise ValueError('内容校验不符（代理缓存了旧版本）')
```

- 代理通道：校验失败 → 该节点拉黑 → 换下一个节点
- API 通道：同样校验，不符则记为失败

**实测**（故意让 `tvv.tw` 先出手）：

```
节点 https://tvv.tw 不可用：内容校验不符（代理缓存了旧版本）
节点 https://gh.dpik.top 不可用：The read operation timed out
节点 https://git.yylx.win 不可用：The read operation timed out
下载 20371 字节，SHA 校验：True，含 probe_nodes：True   ← ghproxy.net 成功
```