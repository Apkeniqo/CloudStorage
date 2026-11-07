const socket = io();
const uploadTasks = new Map();

// 分片策略：目标 128 片，单片 8MB–64MB。
// 片太小网络往返开销占比高，片太大单请求失败重传代价高。
const TARGET_CHUNK_COUNT = 128;
const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

// 并发切片数：4 条连接在千兆局域网下基本能吃满带宽；
// 太大反而会让服务端线程和磁盘排队，4 是稳妥值。
const MAX_CONCURRENT_UPLOADS = 4;

// 单条切片连接超过这么久没有进度就主动断开重试（毫秒）。
// 浏览器对同源只有 6 条连接，卡住的请求会一直占着并发位，越传越慢。
const STALL_TIMEOUT_MS = 15000;

// 核心状态管理
let rawFilesData = [];
let currentPath = '';       // 当前所在目录（相对存储根）
let currentBreadcrumb = [];
let currentView_nav = 'files';
const selectedPaths = new Set();     // 多选的文件（相对路径）
let clipboard = { mode: '', paths: [] };  // 复制/剪切的待粘贴内容
let searchQuery = '';
let currentSort = localStorage.getItem('fluent_sort') || 'mtime-desc';
let currentView = localStorage.getItem('fluent_view') || 'list';
let currentTheme = localStorage.getItem('fluent_theme') || 'system';
let totalFilesCount = 0;
let completedFilesCount = 0;
let currentUsername = '';

// DOM 引用
let fileContainer, itemsWrapper, statusText, fileCount, progressBar, progressInner, sortSelect;

// --- 初始化配置 ---
function initApp() {
    fileContainer = document.getElementById('file-container');
    itemsWrapper = document.getElementById('file-items-wrapper');
    statusText = document.getElementById('status-text');
    fileCount = document.getElementById('file-count');
    progressBar = document.getElementById('progress-bar');
    progressInner = document.getElementById('progress-inner');
    sortSelect = document.getElementById('sort-select');

    initTheme();
    setViewMode(currentView, false);
    initDragDrop();

    // 删除/重命名/分享按钮用事件委托：文件名可能带引号，直接拼 onclick 会坏
    if (itemsWrapper) {
        itemsWrapper.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || !target.closest) return;
            const rowCheck = target.closest('.row-check');
            if (rowCheck) {
                const p = rowCheck.dataset.path;
                if (rowCheck.checked) selectedPaths.add(p); else selectedPaths.delete(p);
                updateSelectionBar();
                return;
            }

            // 文件夹整行都能点开（操作按钮和复选框除外）
            const dirRow = target.closest('.file-item.is-dir');
            if (dirRow && !target.closest('.file-action') && !target.closest('.col-check')) {
                e.preventDefault();
                navigateTo(dirRow.dataset.dirPath);
                return;
            }

            const restore = target.closest('.restore-btn');
            if (restore) {
                e.preventDefault();
                restoreTrash(restore.dataset.trash);
                return;
            }
            const purge = target.closest('.purge-btn');
            if (purge) {
                e.preventDefault();
                purgeTrash(purge.dataset.trash);
                return;
            }
            const folder = target.closest('.folder-name');
            if (folder) {
                e.preventDefault();
                navigateTo(folder.dataset.path);
                return;
            }
            const del = target.closest('.delete-btn');
            if (del) {
                e.preventDefault();
                deleteFile(del.dataset.path, del.dataset.dir === '1');
                return;
            }
            const ren = target.closest('.rename-btn');
            if (ren) {
                e.preventDefault();
                renameFile(ren.dataset.path, ren.dataset.dir === '1');
                return;
            }
            const share = target.closest('.share-btn');
            if (share) {
                e.preventDefault();
                shareFile(share.dataset.path);
            }
        });
    }

    // 共享弹窗里的复制/撤销
    const sharesBox = document.getElementById('shares-list');
    if (sharesBox) {
        sharesBox.addEventListener('click', (e) => {
            if (!e.target || !e.target.closest) return;
            const copy = e.target.closest('[data-copy]');
            if (copy) {
                const url = copy.dataset.copy;
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(
                        () => alert('链接已复制：\n' + url),
                        () => prompt('复制这个链接：', url)
                    );
                } else {
                    prompt('复制这个链接：', url);
                }
                return;
            }
            const revoke = e.target.closest('[data-revoke]');
            if (revoke) revokeShare(revoke.dataset.revoke);
        });
    }

    // 面包屑点击
    const crumbs = document.getElementById('breadcrumb');
    if (crumbs) {
        crumbs.addEventListener('click', (e) => {
            const c = e.target.closest('.crumb');
            if (c && !c.classList.contains('current')) navigateTo(c.dataset.path || '');
        });
    }

    window.addEventListener('resize', moveSideIndicator);

    // 全选
    const selectAll = document.getElementById('select-all');
    if (selectAll) {
        selectAll.addEventListener('change', () => toggleSelectAll(selectAll.checked));
    }

    // 滚到底自动加载下一页
    if (fileContainer) {
        fileContainer.addEventListener('scroll', maybeAppendMore, { passive: true });
    }

    // 取当前登录用户，用于状态栏显示
    if (new URLSearchParams(location.search).get('view') === 'trash') {
        currentView_nav = 'trash';
        loadTrash();
    }

    fetch('/auth/me', { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
            if (data && data.authenticated) {
                applyBackground(!!data.background);
                applyBlur(
                    typeof data.blur_panel === 'number' ? data.blur_panel : 24,
                    typeof data.blur_bg === 'number' ? data.blur_bg : 0
                );
            }
            if (data && data.username) {
                currentUsername = data.username;
                isGuest = data.role === 'guest';
                if (isGuest) {
                    document.body.classList.add('guest-mode');
                    renderFileList();
                }
                if (statusText) {
                    const suffix = isGuest ? '（访客，只读）' : '';
                    if (statusText.textContent.indexOf('已连接') === 0) {
                        statusText.textContent = `已连接（实时同步）· ${currentUsername}${suffix}`;
                    } else {
                        statusText.textContent = `${currentUsername}${suffix}`;
                    }
                }
            }
        })
        .catch(() => { /* 状态栏信息不是关键路径，失败就算了 */ });

    setTimeout(() => {
        if (rawFilesData.length === 0) {
            requestFileList();
        }
    }, 1000);
}

// 初始化主题
function initTheme() {
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (currentTheme === 'system') {
            applyTheme();
        }
    });
}

// 应用主题到 DOM
function applyTheme() {
    let activeTheme = currentTheme;
    if (currentTheme === 'system') {
        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        activeTheme = isSystemDark ? 'dark' : 'light';
    }

    document.documentElement.setAttribute('data-theme', activeTheme);

    const sunIcon = document.getElementById('theme-icon-sun');
    const moonIcon = document.getElementById('theme-icon-moon');
    if (sunIcon && moonIcon) {
        sunIcon.style.display = activeTheme === 'dark' ? 'inline-block' : 'none';
        moonIcon.style.display = activeTheme === 'dark' ? 'none' : 'inline-block';
    }
}

function toggleTheme() {
    if (currentTheme === 'dark') {
        currentTheme = 'light';
    } else if (currentTheme === 'light') {
        currentTheme = 'dark';
    } else {
        const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        currentTheme = isSystemDark ? 'light' : 'dark';
    }

    localStorage.setItem('fluent_theme', currentTheme);
    applyTheme();
}

function requestFileList() {
    if (currentView_nav === 'admin') return;      // 管理视图是 iframe，不要被重连刷掉
    if (currentView_nav === 'trash') return loadTrash();
    loadFiles(currentPath);
}

// 拉取某个目录的内容
async function loadFiles(path, opts) {
    opts = opts || {};
    try {
        const url = path === null || path === undefined
            ? '/api/recent'
            : '/api/list?path=' + encodeURIComponent(path);
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (res.status === 404 && path) {
                currentPath = '';
                return loadFiles('');
            }
            if (statusText) statusText.textContent = data.message || '加载失败';
            return;
        }

        if (path === null) {
            currentPath = '';
            currentBreadcrumb = [{ name: '主页', path: '' }];
            currentView_nav = 'home';
        } else {
            currentPath = data.path || '';
            currentBreadcrumb = data.breadcrumb || [];
            currentView_nav = 'files';
        }
        setMode('files');

        rawFilesData = data.items || [];
        if (!opts.keepSearch) {
            searchQuery = '';
            const s = document.getElementById('search-input');
            if (s) s.value = '';
        }
        selectedPaths.clear();
        renderBreadcrumb();
        renderFileList();
        updateActiveNav();
        playViewAnimation();
    } catch (e) {
        if (statusText) statusText.textContent = '加载失败：' + e;
    }
}

function navigateTo(path) {
    loadFiles(path || '');
}

function renderBreadcrumb() {
    const el = document.getElementById('breadcrumb');
    if (!el) return;
    const crumbs = currentBreadcrumb.length ? currentBreadcrumb : [{ name: '主页', path: '' }];
    el.innerHTML = crumbs.map((c, i) => {
        const sep = i ? '<span class="crumb-sep">/</span>' : '';
        const cls = i === crumbs.length - 1 ? 'crumb current' : 'crumb';
        const name = i === 0 && !c.path ? '主页' : c.name;
        return sep + '<span class="' + cls + '" data-path="' + escapeHtml(c.path) + '">'
            + escapeHtml(name) + '</span>';
    }).join('') + '<span class="crumb-sep crumb-trail">/</span>';
}

function updateActiveNav() {
    document.querySelectorAll('.side-item[data-nav]').forEach(el => {
        el.classList.toggle('active', el.dataset.nav === currentView_nav);
    });
    moveSideIndicator();
}

// 左侧竖条：跟随当前视图移动（带过渡动画）
function moveSideIndicator() {
    // 竖条已经画在 .side-item::before 上，这里不再需要计算位置
}

function navTo(view) {
    if (view === 'files') {
        return loadFiles('');
    }
    if (view === 'home' || view === 'recent') {
        return loadFiles(null);
    }
    closeSidebar();
    if (view === 'trash') {
        return loadTrash();
    }
    if (view === 'admin') {
        return showAdmin();
    }
}

// 管理后台在同页展示（iframe），不跳转
function showAdmin() {
    currentView_nav = 'admin';
    document.body.classList.add('admin-mode');
    document.body.classList.remove('trash-mode');
    const frame = document.getElementById('admin-frame');
    if (frame && !frame.getAttribute('src')) frame.src = '/admin?embed=1';
    updateActiveNav();
    playViewAnimation();

    const input = document.getElementById('search-input');
    if (input && input.value) {
        const frame = document.getElementById('admin-frame');
        if (frame) {
            frame.addEventListener('load', function once() {
                frame.removeEventListener('load', once);
                const win = adminFrameWindow();
                if (win && typeof win.filterConfig === 'function') {
                    setTimeout(() => win.filterConfig(input.value), 60);
                }
            });
        }
    }
}

// 切换「文件 / 回收站」两种视图
function setMode(mode) {
    const isTrash = mode === 'trash';
    document.body.classList.toggle('trash-mode', isTrash);
    document.body.classList.toggle('admin-mode', mode === 'admin');
    const delBtn = document.getElementById('sel-delete');
    if (delBtn) delBtn.textContent = isTrash ? '彻底删除' : '删除';
    updateClipboardButtons && updateClipboardButtons();
    const uploadLabel = document.querySelector('.upload-btn-label');
    if (uploadLabel) uploadLabel.style.display = isTrash ? 'none' : '';
}

// 加载回收站（不再跳独立页面，直接复用文件列表）
async function loadTrash() {
    currentView_nav = 'trash';
    setMode('trash');
    try {
        const res = await fetch('/api/trash', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            if (statusText) statusText.textContent = data.message || '加载失败';
            return;
        }
        const items = data.items || [];
        currentView_nav = 'trash';
        currentPath = '';
        currentBreadcrumb = [{ name: '回收站', path: '' }];
        setMode('trash');
        rawFilesData = items.map(it => ({
            name: it.name,
            path: it.trash,
            is_dir: !!it.is_dir,
            size: it.size || 0,
            mtime: it.mtime,
            is_trash: true
        }));
        searchQuery = '';
        const s = document.getElementById('search-input');
        if (s) s.value = '';
        selectedPaths.clear();
        renderBreadcrumb();
        renderFileList();
        updateActiveNav();
        playViewAnimation();
    } catch (e) {
        if (statusText) statusText.textContent = '加载失败：' + e;
    }
}

async function restoreTrash(trashPath) {
    try {
        const res = await fetch('/trash/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trash: trashPath })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || '恢复失败');
            return;
        }
        loadTrash();
    } catch (e) {
        alert('恢复失败：' + e);
    }
}

async function purgeTrash(trashPath) {
    const name = trashPath.split('/').pop().replace(/^\d{8}-\d{6}_/, '');
    if (!confirm('彻底删除「' + name + '」？此操作不可恢复。')) return;
    try {
        const res = await fetch('/trash/purge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trash: trashPath })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || '删除失败');
            return;
        }
        loadTrash();
    } catch (e) {
        alert('删除失败：' + e);
    }
}

async function emptyTrash() {
    const count = rawFilesData.length;
    if (!count) {
        alert('回收站已经是空的');
        return;
    }
    if (!confirm('清空回收站里的 ' + count + ' 项？此操作不可恢复。')) return;
    try {
        const res = await fetch('/trash/empty', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || '清空失败');
            return;
        }
        loadTrash();
    } catch (e) {
        alert('清空失败：' + e);
    }
}

function toggleSidebar() {
    const el = document.getElementById('sidebar');
    if (!el) return;
    const open = !el.classList.contains('open');
    el.classList.toggle('open', open);
    document.body.classList.toggle('sidebar-open', open);
    const mask = document.getElementById('sidebar-mask');
    if (mask) mask.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function closeSidebar() {
    const el = document.getElementById('sidebar');
    if (!el) return;
    el.classList.remove('open');
    document.body.classList.remove('sidebar-open');
}

// 新建文件夹
async function createFolder() {
    if (isGuest) {
        alert('访客只能浏览和下载文件');
        return;
    }
    const name = prompt('新建文件夹，输入名称：', '新建文件夹');
    if (name === null) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
        const res = await fetch('/folders/create', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: currentPath, name: trimmed })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || ('创建失败（' + res.status + '）'));
            return;
        }
        loadFiles(currentPath);
    } catch (e) {
        alert('创建失败：' + e);
    }
}

// 共享链接弹窗
function openShares() {
    const modal = document.getElementById('shares-modal');
    if (modal) modal.classList.add('show');
    loadShares();
}

function closeShares() {
    const modal = document.getElementById('shares-modal');
    if (modal) modal.classList.remove('show');
}

async function loadShares() {
    const box = document.getElementById('shares-list');
    if (!box) return;
    box.textContent = '加载中…';
    try {
        const res = await fetch('/api/shares', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        const items = data.items || [];
        if (!items.length) {
            box.innerHTML = '<div class="empty-state">还没有共享链接</div>';
            return;
        }
        box.innerHTML = items.map(s => {
            const state = s.active ? '有效' : (s.reason === 'expired' ? '已过期' : '次数用尽');
            const url = location.origin + s.url;
            return '<div class="share-row">'
                + '<div class="share-name" title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</div>'
                + '<div class="share-ops">'
                + '<button data-copy="' + escapeHtml(url) + '">复制</button>'
                + '<button data-revoke="' + escapeHtml(s.token) + '">撤销</button>'
                + '</div>'
                + '<div class="share-meta">' + state + ' · 已下载 ' + s.downloads
                + (s.max_downloads ? ' / ' + s.max_downloads : '') + ' 次</div>'
                + '</div>';
        }).join('');
    } catch (e) {
        box.textContent = '加载失败：' + e;
    }
}

async function revokeShare(token) {
    try {
        await fetch('/api/shares/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: token })
        });
        loadShares();
    } catch (e) {
        alert('撤销失败：' + e);
    }
}

// 侧边栏的存储用量
async function updateStorageInfo() {
    try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        const info = data.storage || {};
        const fill = document.getElementById('storage-fill');
        const text = document.getElementById('storage-text');
        const used = typeof info.used === 'number' ? info.used : (data.storage_used || 0);
        const percent = typeof info.percent === 'number' ? info.percent : 0;

        if (fill) {
            fill.style.width = Math.min(100, percent).toFixed(1) + '%';
        }
        if (text) {
            if (info.mode === 'quota') {
                text.textContent = '已用 ' + formatSize(used) + ' / ' + formatSize(info.limit || 0)
                    + ' (' + Math.round(percent) + '%)';
                text.title = '剩余 ' + formatSize(info.remaining || 0);
            } else if (info.mode === 'disk') {
                text.textContent = '已用 ' + formatSize(used) + ' · 磁盘剩余 '
                    + formatSize(info.remaining || 0);
                text.title = '磁盘共 ' + formatSize(info.disk_total || 0)
                    + '，剩余 ' + formatSize(info.remaining || 0);
            } else {
                text.textContent = '已使用 ' + formatSize(used) + ' · 不限容量';
            }
        }
    } catch (e) { /* 用量展示失败不影响主流程 */ }
}

function setViewMode(mode, save = true) {
    currentView = mode;
    if (save) localStorage.setItem('fluent_view', mode);

    if (fileContainer) {
        fileContainer.className = `file-list-container view-${mode}`;
    }

    // 单个切换按钮：显示「将要切换到的视图」的图标
    const iconList = document.getElementById('view-icon-list');
    const iconGrid = document.getElementById('view-icon-grid');
    const toggle = document.getElementById('view-toggle');
    if (iconList) iconList.style.display = mode === 'list' ? 'none' : 'inline-block';
    if (iconGrid) iconGrid.style.display = mode === 'list' ? 'inline-block' : 'none';
    if (toggle) toggle.title = mode === 'list' ? '切换到图标视图' : '切换到列表视图';

    renderFileList();
}

function toggleViewMode() {
    setViewMode(currentView === 'list' ? 'grid' : 'list');
}

function getFileIconSvg(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    
    if (['iso', 'img', 'vcd', 'dmg', 'nrg', 'mdf', 'cue', 'bin'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#0078D4"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-10c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 3c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z"/></svg>`;
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'raw'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#0078D4"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
    }
    if (ext === 'pdf') {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#D13438"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm-2.5-3.5h1v2.5h-1V7.5zM9 8.5h1v1H9v-1z"/></svg>`;
    }
    if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#107C41"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
    }
    if (['xls', 'xlsx', 'csv'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#107C41"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 14H7v-2h3v2zm0-4H7v-2h3v2zm0-4H7V7h3v2zm7 8h-5v-2h5v2zm0-4h-5v-2h5v2zm0-4h-5V7h5v2z"/></svg>`;
    }
    if (['ppt', 'pptx'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#C43E1C"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 13c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm1-5h-2v2h2v-2z"/></svg>`;
    }
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#797775"><path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-2 6h-2v2h2v2h-2v2h-2v-2h2v-2h-2v-2h2v-2h-2V8h2v4z"/></svg>`;
    }
    if (['html', 'css', 'js', 'py', 'c', 'cpp', 'java', 'json', 'sh'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#5C2D91"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>`;
    }
    if (['mp3', 'wav', 'flac', 'mp4', 'mkv', 'avi', 'mov', 'wmv'].includes(ext)) {
        return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="#0078D4"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
    }
    return `<svg class="file-icon" width="20" height="20" viewBox="0 0 24 24" fill="var(--text-secondary)"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>`;
}

function handleHeaderClick(field) {
    const [currentField, currentOrder] = currentSort.split('-');
    let newOrder;
    if (currentField === field) {
        newOrder = currentOrder === 'asc' ? 'desc' : 'asc';
    } else {
        newOrder = (field === 'name') ? 'asc' : 'desc';
    }

    currentSort = `${field}-${newOrder}`;
    localStorage.setItem('fluent_sort', currentSort);
    renderFileList();
}

function updateHeaderSortIcons() {
    const [currentField, currentOrder] = currentSort.split('-');
    const arrow = currentOrder === 'asc' ? '▲' : '▼';

    ['name', 'size', 'mtime'].forEach(f => {
        const el = document.getElementById(`sort-icon-${f}`);
        if (el) el.textContent = '';
    });

    const activeEl = document.getElementById(`sort-icon-${currentField}`);
    if (activeEl) {
        activeEl.textContent = arrow;
    }
}

function getSortedFiles() {
    const files = [...rawFilesData];
    const [field, order] = currentSort.split('-');

    return files.sort((a, b) => {
        // 文件夹永远排在文件前面
        if (!!a.is_dir !== !!b.is_dir) return a.is_dir ? -1 : 1;

        let res = 0;
        if (field === 'name') {
            res = a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
        } else if (field === 'size') {
            res = (a.size || 0) - (b.size || 0);
        } else if (field === 'mtime') {
            res = a.mtime - b.mtime;
        }
        return order === 'asc' ? res : -res;
    });
}

// WebSocket 监听
socket.on('connect', () => { 
    if (statusText) statusText.textContent = currentUsername
        ? `已连接（实时同步）· ${currentUsername}`
        : "已连接（实时同步）";
    requestFileList();
    updateStorageInfo();
});

socket.on('disconnect', () => {
    if (statusText) statusText.textContent = "连接断开，尝试重连...";
});

socket.on('connect_error', async () => {
    // 会话过期时后端会拒绝握手：先确认登录状态，确实是未登录才跳登录页
    if (statusText) statusText.textContent = "连接失败，正在检查登录状态...";
    try {
        const res = await fetch('/auth/me', { cache: 'no-store' });
        const data = await res.json();
        if (!data.authenticated) {
            window.location.href = '/login';
            return;
        }
    } catch (e) { /* 服务不可达，保持重试即可 */ }
    if (statusText) statusText.textContent = "实时连接失败，正在重试...";
});

socket.on('file_update', () => {
    // 服务端只发一个"有变化"的信号，具体内容按当前目录重新拉取
    if (currentView_nav === 'admin') {
        return;       // 管理后台是 iframe，不要被文件变动刷新打断
    }
    if (currentView_nav === 'trash') {
        loadTrash();
    } else {
        loadFiles(currentView_nav === 'home' ? null : currentPath, { keepSearch: true });
    }
    updateStorageInfo();
});

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// 速度采样器：每 500ms 用最近 1 秒真正走过的字节算一次速度。
// 没有数据流动时直接显示 0 B/s，而不是停在上一次的数值上。
function createSpeedMeter(speedEl, windowMs = 1000) {
    let total = 0;
    let samples = [{ t: Date.now(), bytes: 0 }];

    const timer = setInterval(() => {
        const now = Date.now();
        samples.push({ t: now, bytes: total });
        while (samples.length > 2 && now - samples[0].t > windowMs) samples.shift();

        const first = samples[0];
        const dt = (now - first.t) / 1000;
        const moved = total - first.bytes;

        let speed = dt > 0 ? moved / dt : 0;
        if (!isFinite(speed) || speed < 0) speed = 0;
        // 低于 512 B/s 一律当 0，避免显示 3 B/s 这种噪声
        if (speed < 512) speed = 0;

        if (speedEl) speedEl.textContent = formatSize(speed) + '/s';
    }, 500);

    return {
        set(bytes) {
            if (typeof bytes === 'number' && bytes > total) total = bytes;
        },
        reset(bytes) {
            total = Math.max(0, bytes || 0);
            samples = [{ t: Date.now(), bytes: total }];
        },
        stop() {
            clearInterval(timer);
        }
    };
}

function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

// 文件名来自服务端，拼进 HTML 前必须转义，避免文件名里的标签被执行
function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
}

// 移动端「更多」二级菜单
function toggleMoreMenu(e) {
    if (e && e.stopPropagation) e.stopPropagation();
    const box = document.getElementById('toolbar-extra');
    if (!box) return;
    box.classList.toggle('open');
}

document.addEventListener('click', (e) => {
    const box = document.getElementById('toolbar-extra');
    if (!box || !box.classList.contains('open')) return;
    if (e.target.closest && e.target.closest('#more-btn')) return;
    if (box.contains(e.target)) {
        // 只收起不跳转的按钮；跳转类点了就离开页面了
        if (e.target.closest('#theme-btn')) box.classList.remove('open');
        return;
    }
    box.classList.remove('open');
});


function adminFrameWindow() {
    const fr = document.getElementById('admin-frame');
    try {
        return (fr && fr.contentWindow && fr.contentWindow.document) ? fr.contentWindow : null;
    } catch (e) {
        return null;
    }
}

function handleSearch(query) {
    const clearBtn = document.getElementById('clear-search');
    const hasText = !!(query && query.trim());
    if (clearBtn) clearBtn.style.display = hasText ? 'inline-block' : 'none';

    // 管理后台：搜索框直接过滤设置项
    if (currentView_nav === 'admin') {
        const win = adminFrameWindow();
        if (win && typeof win.filterConfig === 'function') {
            win.filterConfig(query || '');
        }
        return;
    }

    searchQuery = query.trim().toLowerCase();
    renderFileList();
}

// 移动端：点搜索图标 → 打开侧边栏并聚焦搜索框
function focusSearch() {
    const el = document.getElementById('sidebar');
    if (el && !el.classList.contains('open') && window.innerWidth <= 900) {
        el.classList.add('open');
        document.body.classList.add('sidebar-open');
    }
    const input = document.getElementById('search-input');
    if (input) input.focus();
}

function clearSearch() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = '';
        if (currentView_nav === 'admin') {
            const win = adminFrameWindow();
            if (win && typeof win.clearConfigSearch === 'function') win.clearConfigSearch();
        }
        handleSearch('');
        searchInput.focus();
    }
}

// 大列表分批渲染：一次只画一页，滚到底再追加，避免几千个文件卡住页面
const PAGE_SIZE = 200;
let isGuest = false;
let renderedFiles = [];
let renderedCount = 0;
const downloadIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
const shareIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>`;
const renameIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
const restoreIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3a9 9 0 1 0 8.94 10h-2.02A7 7 0 1 1 13 5v3l4-4-4-4v3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/></svg>`;
const deleteIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

const folderIconSvg = `<svg class="folder-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;

function trashItemHtml(file) {
    const trashPath = escapeHtml(file.path || file.name);
    const trashed = selectedPaths.has(file.path || file.name) ? '1' : '';
    const safeName = escapeHtml(file.name);
    const icon = file.is_dir ? folderIconSvg : getFileIconSvg(file.name);
    const sizeText = file.is_dir ? '—' : formatSize(file.size);
    return `
        <div class="file-item trash-row">
            <div class="col-check"><input type="checkbox" class="row-check" data-path="${trashPath}"${trashed ? ' checked' : ''}></div>
            <div class="file-name" title="${safeName}">
                ${icon}
                <span class="folder-name">${safeName}</span>
            </div>
            <div class="file-size">${sizeText}</div>
            <div class="file-time">${formatTime(file.mtime)}</div>
            <div class="file-action">
                <button class="action-btn restore-btn" data-trash="${trashPath}" title="恢复">${restoreIconSvg}</button>
                <button class="action-btn delete-btn purge-btn" data-trash="${trashPath}" title="彻底删除">${deleteIconSvg}</button>
            </div>
        </div>
    `;
}

function fileItemHtml(file) {
    if (file.is_trash) return trashItemHtml(file);

    const itemPath = file.path || file.name;
    const safeName = escapeHtml(file.name);
    const safePath = escapeHtml(itemPath);
    const isDir = !!file.is_dir;
    const downloadUrl = isDir ? '' : '/download/' + encodeURIComponent(itemPath);

    const nameCell = isDir
        ? `<div class="file-name folder" title="${safeName}">
                ${folderIconSvg}
                <a href="javascript:void(0)" class="file-name-link folder-name" data-path="${safePath}">${safeName}</a>
           </div>`
        : `<div class="file-name" title="${safeName}">
                ${getFileIconSvg(file.name)}
                <a href="${downloadUrl}" download="${safeName}" class="file-name-link">${safeName}</a>
           </div>`;

    const actions = isGuest ? (isDir ? '' : `<a href="${downloadUrl}" download="${safeName}" class="action-btn download-btn" title="下载">${downloadIconSvg}</a>`)
        : (isDir
            ? `<button class="action-btn rename-btn" data-path="${safePath}" data-dir="1" title="重命名">${renameIconSvg}</button>
               <button class="action-btn delete-btn" data-path="${safePath}" data-dir="1" title="删除">${deleteIconSvg}</button>`
            : `<a href="${downloadUrl}" download="${safeName}" class="action-btn download-btn" title="下载">${downloadIconSvg}</a>
               <button class="action-btn share-btn" data-path="${safePath}" title="分享">${shareIconSvg}</button>
               <button class="action-btn rename-btn" data-path="${safePath}" title="重命名">${renameIconSvg}</button>
               <button class="action-btn delete-btn" data-path="${safePath}" title="删除">${deleteIconSvg}</button>`);

    const checked = selectedPaths.has(itemPath) ? ' checked' : '';
    const checkCell = isGuest
        ? '<div class="col-check"></div>'
        : `<div class="col-check"><input type="checkbox" class="row-check" data-path="${safePath}"${checked}></div>`;

    return `
        <div class="file-item${isDir ? ' is-dir' : ''}"${isDir ? ` data-dir-path="${safePath}"` : ''}>
            ${checkCell}
            ${nameCell}
            <div class="file-size">${isDir ? '—' : formatSize(file.size)}</div>
            <div class="file-time" title="${file.uploader ? '上传者：' + escapeHtml(file.uploader) : ''}">${formatTime(file.mtime)}</div>
            <div class="file-action">${actions}</div>
        </div>
    `;
}

function appendFilePage() {
    if (!itemsWrapper) return;
    const next = renderedFiles.slice(renderedCount, renderedCount + PAGE_SIZE);
    if (!next.length) return;
    itemsWrapper.insertAdjacentHTML('beforeend', next.map(fileItemHtml).join(''));
    renderedCount += next.length;

    if (fileCount) {
        const total = renderedFiles.length;
        const text = searchQuery
            ? `找到 ${total} 项 (共 ${rawFilesData.length} 项)`
            : `${total} 项`;
        fileCount.textContent = renderedCount < total
            ? `${text} · 已显示 ${renderedCount}`
            : text;
    }
}

function maybeAppendMore() {
    if (!fileContainer) return;
    const nearBottom = fileContainer.scrollTop + fileContainer.clientHeight
        >= fileContainer.scrollHeight - 200;
    if (nearBottom && renderedCount < renderedFiles.length) {
        appendFilePage();
    }
}

function renderFileList() {
    if (!itemsWrapper) return;
    let files = getSortedFiles();

    if (searchQuery) {
        files = files.filter(f => f.name.toLowerCase().includes(searchQuery));
    }

    updateHeaderSortIcons();

    renderedFiles = files;
    renderedCount = 0;
    itemsWrapper.innerHTML = '';

    if (files.length === 0) {
        let emptyMsg;
        if (searchQuery) {
            emptyMsg = '未找到匹配的文件';
        } else if (currentView_nav === 'trash') {
            emptyMsg = '回收站是空的';
        } else if (isGuest) {
            emptyMsg = '这个文件夹是空的';
        } else {
            emptyMsg = '这个文件夹是空的，点击上传或拖入文件';
        }
        itemsWrapper.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
        if (fileCount) fileCount.textContent = '0 项';
        return;
    }

    appendFilePage();
    updateSelectionBar();
}

// ---------------- 多选 ----------------
function updateSelectionBar() {
    // 当前视图里已经不存在的条目（被删掉/切走了）要从选中集合里剔除，避免"已选 N 项"残留
    const visible = new Set(renderedFiles.map(f => f.path || f.name));
    if (selectedPaths.size) {
        for (const p of Array.from(selectedPaths)) {
            if (!visible.has(p)) selectedPaths.delete(p);
        }
    }

    const bar = document.getElementById('selection-bar');
    const num = document.getElementById('selection-num');
    const all = document.getElementById('select-all');
    if (num) num.textContent = String(selectedPaths.size);
    updateClipboardButtons();
    if (bar) bar.classList.toggle('show', selectedPaths.size > 0);

    if (all) {
        const total = renderedFiles.length;
        all.checked = total > 0 && selectedPaths.size >= total;
        all.indeterminate = selectedPaths.size > 0 && selectedPaths.size < total;
    }
}

function clearSelection() {
    if (!selectedPaths.size) return;
    selectedPaths.clear();
    renderFileList();
}

function toggleSelectAll(checked) {
    if (checked) {
        renderedFiles.forEach(f => { if (f.path || f.name) selectedPaths.add(f.path || f.name); });
    } else {
        selectedPaths.clear();
    }
    renderFileList();
}

// 重新加载当前视图（文件 / 主页 / 回收站）
function reloadCurrentView() {
    if (currentView_nav === 'trash') return loadTrash();
    if (currentView_nav === 'home') return loadFiles(null);
    return loadFiles(currentPath);
}

async function deleteSelected() {
    const paths = Array.from(selectedPaths);
    if (!paths.length) return;

    const inTrash = currentView_nav === 'trash';
    const tip = inTrash
        ? `彻底删除选中的 ${paths.length} 项？\n此操作不可恢复。`
        : `删除选中的 ${paths.length} 项？\n会移到回收站，之后可以恢复。`;
    if (!confirm(tip)) return;

    let ok = 0;
    for (const p of paths) {
        try {
            const res = await fetch(inTrash ? '/trash/purge' : '/files/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(inTrash ? { trash: p } : { path: p })
            });
            if (res.ok) ok++;
        } catch (e) { /* 单条失败继续 */ }
    }
    selectedPaths.clear();
    reloadCurrentView();
    updateSelectionBar();
    if (ok < paths.length) {
        alert(`完成 ${ok} 项，${paths.length - ok} 项失败`);
    }
}

// ---------------- 个人背景 ----------------
function openBackground() {
    const modal = document.getElementById('bg-modal');
    if (modal) modal.classList.add('show');
}

function closeBackground() {
    const modal = document.getElementById('bg-modal');
    if (modal) modal.classList.remove('show');
}

function applyBackground(has) {
    document.body.classList.toggle('has-bg', !!has);
    if (has) {
        // 加时间戳，换图后立即刷新，避免浏览器缓存
        document.body.style.setProperty('--bg-image',
            "url('/prefs/background?v=" + Date.now() + "')");
    } else {
        document.body.style.removeProperty('--bg-image');
    }
}

// 模糊程度：文件面板 / 背景
let blurPanel = 24;
let blurBg = 0;
let blurTimer = null;

function applyBlur(panel, bg) {
    blurPanel = panel;
    blurBg = bg;
    const root = document.documentElement;
    root.style.setProperty('--panel-blur', panel + 'px');
    root.style.setProperty('--bg-blur', bg + 'px');

    const panelVal = document.getElementById('val-panel');
    const bgVal = document.getElementById('val-bg');
    const panelInput = document.getElementById('blur-panel');
    const bgInput = document.getElementById('blur-bg');
    if (panelVal) panelVal.textContent = panel + 'px';
    if (bgVal) bgVal.textContent = bg + 'px';
    if (panelInput && document.activeElement !== panelInput) panelInput.value = panel;
    if (bgInput && document.activeElement !== bgInput) bgInput.value = bg;
}

function onBlurInput(which, value) {
    const v = Math.max(0, Math.min(which === 'panel' ? 40 : 30, parseInt(value, 10) || 0));
    if (which === 'panel') {
        applyBlur(v, blurBg);
    } else {
        applyBlur(blurPanel, v);
    }
    // 拖动时先本地预览，松手一小会儿后再保存
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(saveBlur, 400);
}

async function saveBlur() {
    try {
        await fetch('/prefs/blur', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ panel: blurPanel, bg: blurBg })
        });
    } catch (e) { /* 保存失败不影响当前预览 */ }
}

async function uploadBackground(input) {
    const file = input.files && input.files[0];
    input.value = '';                 // 允许重复选同一张
    if (!file) return;

    if (file.size > 8 * 1024 * 1024) {
        alert('图片不能超过 8MB');
        return;
    }

    const fd = new FormData();
    fd.append('file', file);
    try {
        const res = await fetch('/prefs/background', { method: 'POST', body: fd });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || '上传失败');
            return;
        }
        applyBackground(true);
        closeBackground();
    } catch (e) {
        alert('上传失败：' + e);
    }
}

async function clearBackground() {
    try {
        const res = await fetch('/prefs/background/clear', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || '操作失败');
            return;
        }
        applyBackground(false);
        closeBackground();
    } catch (e) {
        alert('操作失败：' + e);
    }
}

// ---------------- 复制 / 剪切 / 粘贴 ----------------
function copySelection(mode) {
    const paths = Array.from(selectedPaths);
    if (!paths.length) {
        alert('先在左侧勾选要' + (mode === 'cut' ? '剪切' : '复制') + '的文件');
        return;
    }
    clipboard = { mode: mode, paths: paths };
    updateClipboardButtons();
    if (statusText) {
        statusText.textContent = (mode === 'cut' ? '已剪切 ' : '已复制 ')
            + paths.length + ' 项，进入目标文件夹后点「粘贴」';
    }
}

function updateClipboardButtons() {
    const copyBtn = document.getElementById('copy-btn');
    const cutBtn = document.getElementById('cut-btn');
    const pasteBtn = document.getElementById('paste-btn');
    const inTrash = currentView_nav === 'trash';
    const hasSel = selectedPaths.size > 0 && !inTrash;
    const hasClip = clipboard.paths.length > 0 && !inTrash;
    if (copyBtn) copyBtn.disabled = !hasSel;
    if (cutBtn) cutBtn.disabled = !hasSel;
    if (pasteBtn) {
        pasteBtn.disabled = !hasClip;
        pasteBtn.title = hasClip
            ? (clipboard.mode === 'cut' ? '粘贴（移动到这里）' : '粘贴（复制到这里）')
            : '粘贴';
    }
}

async function pasteSelection() {
    if (!clipboard.paths.length) return;
    const url = clipboard.mode === 'cut' ? '/files/move' : '/files/copy';
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: clipboard.paths, targetPath: currentPath })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || '粘贴失败');
            return;
        }
        const failed = data.failed || 0;
        if (failed) alert(`完成 ${data.copied || data.moved} 项，${failed} 项跳过（重名或位置非法）`);
        if (clipboard.mode === 'cut') clipboard = { mode: '', paths: [] };
        selectedPaths.clear();
        updateClipboardButtons();
        loadFiles(currentPath);
    } catch (e) {
        alert('粘贴失败：' + e);
    }
}

// 视图切换动效
function playViewAnimation() {
    if (!fileContainer) return;
    fileContainer.classList.remove('animate');
    void fileContainer.offsetWidth;
    fileContainer.classList.add('animate');
}

// 生成分享链接
async function shareFile(path) {
    if (!path) return;
    const name = path.split('/').pop();
    const hours = prompt(`生成「${name}」的分享链接\n有效期（小时，0 = 永久）：`, '24');
    if (hours === null) return;
    const maxDownloads = prompt('可下载次数（0 = 不限）：', '0');
    if (maxDownloads === null) return;

    try {
        const res = await fetch('/api/shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: path, expire_hours: hours, max_downloads: maxDownloads })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.message || `生成失败（${res.status}）`); return; }
        prompt('分享链接已生成（复制后发送给对方）：', location.origin + data.url);
    } catch (e) {
        alert('生成失败：' + e);
    }
}

// ---- 切片 CRC32（传输完整性校验）----
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
})();

const crcWorker = (() => {
    if (typeof Worker === 'undefined') return null;
    try {
        const worker = new Worker('/static/crc-worker.js');
        const pending = new Map();
        let seq = 0;
        worker.onmessage = (e) => {
            const { id, crc, error } = e.data || {};
            const task = pending.get(id);
            if (!task) return;
            pending.delete(id);
            if (error) task.reject(new Error(error)); else task.resolve(crc);
        };
        worker.onerror = () => { pending.forEach(t => t.reject(new Error('worker error'))); pending.clear(); };
        return {
            compute(blob) {
                return new Promise((resolve, reject) => {
                    const id = ++seq;
                    pending.set(id, { resolve, reject });
                    worker.postMessage({ id, blob });
                });
            }
        };
    } catch (e) {
        return null;
    }
})();

async function chunkCrc32(blob) {
    // 优先用 Worker：大切片在主线程算 CRC 会卡住页面，进度条就"停住"了
    if (crcWorker) {
        try {
            return await crcWorker.compute(blob);
        } catch (e) {
            console.warn('CRC Worker 失败，退回主线程计算:', e);
        }
    }

    // 分片读，避免一次性把大切片读进内存
    const SLICE = 4 * 1024 * 1024;
    let crc = 0xFFFFFFFF;
    for (let offset = 0; offset < blob.size; offset += SLICE) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + SLICE).arrayBuffer());
        for (let i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
        }
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    return crc.toString(16).padStart(8, '0');
}

// 重命名文件
async function renameFile(itemPath, isDir) {
    if (!itemPath) return;
    const name = itemPath.split('/').pop();
    const input = prompt(`把「${name}」重命名为：`, name);
    if (input === null) return;
    const newName = input.trim();
    if (!newName || newName === name) return;

    try {
        const res = await fetch('/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: itemPath, newName: newName })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || `重命名失败（${res.status}）`);
        } else {
            reloadCurrentView();
        }
    } catch (e) {
        alert('重命名失败：' + e);
    }
}

// 删除文件 / 文件夹（移到回收站）
async function deleteFile(itemPath, isDir) {
    if (!itemPath) return;
    const name = itemPath.split('/').pop();
    const what = isDir ? '文件夹及其全部内容' : '文件';
    if (!confirm(`确定删除${what}「${name}」？\n会移到回收站，之后可以恢复。`)) return;

    try {
        const res = await fetch('/files/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: itemPath })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || `删除失败（${res.status}）`);
        } else {
            reloadCurrentView();
        }
    } catch (e) {
        alert('删除失败：' + e);
    }
}

// ---- 文件指纹 ----
// 旧方案用「名称-大小-修改时间」，同名同大小的不同文件会被误判成同一个文件。
// 现在改用「文件大小 + 均匀分布的多段采样内容」计算指纹：
// 改名、换机器仍能续传；内容变了指纹基本都会变。
// 注意：这是「采样」指纹（最多读 16 × 256KB = 4MB），不是全文件校验和；
//       巨型文件里未被采样到的区段改动理论上检测不到。
const FINGERPRINT_SLICES = 16;
const FINGERPRINT_SLICE_SIZE = 256 * 1024; // 每段 256KB

function fnv1a32(bytes, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function readFileSlice(file, start, end) {
    return file.slice(start, end).arrayBuffer().then(buf => new Uint8Array(buf));
}

async function sampleFile(file) {
    const slices = [];
    if (file.size <= FINGERPRINT_SLICE_SIZE) {
        slices.push(await readFileSlice(file, 0, file.size));
    } else {
        const lastStart = file.size - FINGERPRINT_SLICE_SIZE;
        const step = lastStart / (FINGERPRINT_SLICES - 1);
        for (let i = 0; i < FINGERPRINT_SLICES; i++) {
            const start = i === FINGERPRINT_SLICES - 1 ? lastStart : Math.floor(step * i);
            slices.push(await readFileSlice(file, start, start + FINGERPRINT_SLICE_SIZE));
        }
    }
    return slices;
}

async function computeFileHash(file) {
    const slices = await sampleFile(file);

    // 两条不同种子的链，拼成 64 位指纹，降低碰撞概率
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (const slice of slices) {
        h1 = fnv1a32(slice, h1);
        h2 = fnv1a32(slice, h2);
    }
    const sizeBytes = new TextEncoder().encode(String(file.size));
    h1 = fnv1a32(sizeBytes, h1);
    h2 = fnv1a32(sizeBytes, h2);

    const hex = n => n.toString(16).padStart(8, '0');
    return `v2-${hex(h1)}${hex(h2)}`;
}

// 主上传函数 (切片/断点续传)
async function uploadFiles() {
    const input = document.getElementById('file-input');
    if (!input || !input.files.length) return;
    return uploadFileList(Array.from(input.files));
}

// 真正的上传逻辑：选文件、拖拽都走这里
async function uploadFileList(files) {
    if (!files || !files.length) return;
    totalFilesCount += files.length;
    updateToastTitle();

    const toast = document.getElementById('upload-toast');
    const container = document.getElementById('upload-list-container');
    if (toast) toast.classList.remove('hidden');

    // 先问一次剩余容量，超出的文件直接拦下，避免白传
    let remainingBytes = -1;
    try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (res.ok) {
            const d = await res.json();
            if (d.storage && typeof d.storage.remaining === 'number') {
                remainingBytes = d.storage.remaining;
            }
        }
    } catch (e) { /* 拿不到就交给服务端拦截 */ }

    for (const file of files) {
        const taskId = 'task-' + Math.random().toString(36).substring(2, 9);
        
        // 1. 创建 UI 卡片
        const itemCard = document.createElement('div');
        itemCard.className = 'upload-item-card';
        itemCard.id = taskId;
        itemCard.innerHTML = `
            <div class="item-header">
                <span class="item-name" title="${file.name}">${file.name}</span>
                <button class="item-cancel-btn" onclick="cancelSingleUpload('${taskId}')" title="取消上传">✕</button>
            </div>
            <div class="toast-progress-bar">
                <div class="toast-progress-inner" id="progress-${taskId}" style="width: 0%;"></div>
            </div>
            <div class="toast-meta">
                <span id="percent-${taskId}">0%</span>
                <span id="speed-${taskId}">准备上传...</span>
            </div>
        `;
        if (container) container.appendChild(itemCard);

        // 容量预检：放不下就不传
        if (remainingBytes >= 0 && file.size > remainingBytes) {
            const st = document.getElementById('speed-' + taskId);
            if (st) {
                st.textContent = '空间不足：需要 ' + formatSize(file.size)
                    + '，剩余 ' + formatSize(remainingBytes);
                st.style.color = '#ff6b6b';
            }
            finishTask(taskId);
            continue;
        }

        // 根据文件大小进行智能路由分流
        const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024; // 200MB

        try {
            if (file.size < LARGE_FILE_THRESHOLD) {
                // 小文件：单流上传
                await uploadSingleFileStream(file, taskId);
            } else {
                // 大文件：分片并发上传
                await uploadLargeFileChunks(file, taskId);
            }
        } catch (e) {
            const st = document.getElementById('speed-' + taskId);
            if (st) {
                st.textContent = (e && e.message) ? e.message : '上传失败';
                st.style.color = '#ff6b6b';
            }
            finishTask(taskId);
            continue;
        }

        if (remainingBytes >= 0) remainingBytes -= file.size;
    }

    input.value = ''; // 清空选择
}

// ---------------- 拖拽上传 ----------------
let dragDepth = 0;

// 从 DataTransfer 里取文件，忽略文件夹
function collectDroppedFiles(dt) {
    const out = [];
    if (!dt) return out;

    if (dt.items && dt.items.length) {
        for (const item of dt.items) {
            if (item.kind !== 'file') continue;
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            if (entry && entry.isDirectory) {
                console.warn('[上传] 忽略文件夹：' + entry.name);
                continue;
            }
            const file = item.getAsFile();
            if (file) out.push(file);
        }
    }

    if (!out.length && dt.files) {
        for (const file of dt.files) out.push(file);
    }
    return out;
}

function initDragDrop() {
    const overlay = document.getElementById('drop-overlay');
    const hasFiles = (e) => {
        const types = e.dataTransfer && e.dataTransfer.types;
        return types ? Array.from(types).indexOf('Files') !== -1 : false;
    };

    const hide = () => {
        dragDepth = 0;
        if (overlay) overlay.classList.remove('show');
    };

    window.addEventListener('dragenter', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth++;
        // 访客只读，不给上传入口
        if (isGuest) return;
        if (overlay) overlay.classList.add('show');
    });

    window.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) {
            e.dataTransfer.dropEffect = isGuest ? 'none' : 'copy';
        }
    });

    window.addEventListener('dragleave', (e) => {
        if (!hasFiles(e)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hide();
    });

    window.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        hide();

        if (isGuest) {
            alert('访客只能浏览和下载文件，不能上传');
            return;
        }

        const files = collectDroppedFiles(e.dataTransfer);
        if (!files.length) {
            alert('没有识别到文件（文件夹暂不支持，请拖入具体文件）');
            return;
        }
        uploadFileList(files);
    });
}

// 小文件单流上传处理
function uploadSingleFileStream(file, taskId) {
    return new Promise((resolve) => {
        const speedText = document.getElementById(`speed-${taskId}`);
        if (speedText) speedText.textContent = "极速通道传输中...";

        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);
        formData.append('path', currentPath || '');

        // 注册到全局任务，支持单项取消
        uploadTasks.set(taskId, {
            isCancelled: false,
            activeXHRs: new Set([xhr]),
            file: file
        });

        const speedMeter = createSpeedMeter(speedText);

        xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            updateProgress(taskId, e.loaded, e.total);
            speedMeter.set(e.loaded);
        };

        xhr.onload = () => {
            speedMeter.stop();
            if (xhr.status === 200) {
                updateProgress(taskId, file.size, file.size);
                if (speedText) speedText.textContent = "已完成";
            } else {
                let msg = '上传失败 (' + xhr.status + ')';
                try {
                    const info = JSON.parse(xhr.responseText || '{}');
                    if (info && info.message) msg = info.message;
                } catch (e) { /* 不是 JSON 就用默认文案 */ }
                if (speedText) {
                    speedText.textContent = msg;
                    speedText.style.color = '#ff6b6b';
                }
            }
            finishTask(taskId);
            resolve();
        };

        xhr.onerror = () => {
            speedMeter.stop();
            if (speedText) speedText.textContent = "网络错误";
            finishTask(taskId);
            resolve();
        };

        xhr.onabort = () => {
            speedMeter.stop();
            if (speedText) speedText.textContent = "已取消";
            finishTask(taskId);
            resolve();
        };

        xhr.open('POST', '/upload', true);
        xhr.send(formData);
    });
}

async function uploadLargeFileChunks(file, taskId) {
    const speedText = document.getElementById(`speed-${taskId}`);
    if (speedText) speedText.textContent = "正在计算文件指纹...";
    const fileHash = await computeFileHash(file);

    // 在最开始将任务注册到 uploadTasks 中！
    uploadTasks.set(taskId, {
        isCancelled: false,
        activeXHRs: new Set(),
        file: file
    });

    // 动态计算切片大小：目标 128 片，限制在 8MB–64MB 之间
    const calculatedChunkSize = Math.ceil(file.size / TARGET_CHUNK_COUNT);
    const chunkSize = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, calculatedChunkSize));
    const totalChunks = Math.ceil(file.size / chunkSize);

    if (speedText) speedText.textContent = "检查已接收切片...";

    // 1. 查询服务器断点信息
    let uploadedChunks = [];
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        const checkRes = await fetch(`/upload/check?fileHash=${encodeURIComponent(fileHash)}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (checkRes.ok) {
            const checkData = await checkRes.json();
            uploadedChunks = checkData.uploadedChunks || [];

            // 剩余容量不够就直接拦下，不用白传
            const info = checkData.storage || {};
            const remaining = typeof info.remaining === 'number' ? info.remaining : -1;
            if (remaining >= 0 && file.size > remaining) {
                throw new Error('剩余空间不足：需要 ' + formatSize(file.size)
                    + '，只剩 ' + formatSize(remaining));
            }
        }
    } catch (e) {
        console.warn("检查切片失败，默认从头上传:", e);
        uploadedChunks = [];
    }

    // 2. 检查在此期间任务是否被用户中途取消
    const currentTask = uploadTasks.get(taskId);
    if (!currentTask || currentTask.isCancelled) {
        if (speedText) speedText.textContent = "已取消";
        finishTask(taskId);
        return;
    }

    // 3. 计算未完成的切片
    const pendingChunks = [];
    for (let i = 0; i < totalChunks; i++) {
        if (!uploadedChunks.includes(i)) {
            pendingChunks.push(i);
        }
    }

    // 4. 计算已上传基础字节与初始化
    // 计算单个切片大小
    const getChunkSize = (index) => {
        return (index === totalChunks - 1) ? (file.size - index * chunkSize) : chunkSize;
    };

    // 累加所有已存在切片大小
    const uploadedChunkIndices = Array.from({length: totalChunks}, (_, i) => i)
        .filter(i => !pendingChunks.includes(i));

    const initialUploadedBytes = uploadedChunkIndices.reduce((sum, idx) => sum + getChunkSize(idx), 0);
    
    const speedMeter = createSpeedMeter(speedText);
    speedMeter.reset(initialUploadedBytes);
    let loadedBytesMap = {};

    updateProgress(taskId, initialUploadedBytes, file.size);

    if (pendingChunks.length > 0) {
        if (speedText) speedText.textContent = `分块传输中 (${pendingChunks.length}/${totalChunks} 片，${MAX_CONCURRENT_UPLOADS} 并发)...`;
    } else {
        if (speedText) speedText.textContent = "秒传完成，正在合并...";
    }

    // 5. 单切片上传 Promise
    const uploadChunkTask = (chunkIndex) => {
        return new Promise((resolve, reject) => {
            let retryCount = 0;
            const maxRetries = 4;
            const start = chunkIndex * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const chunk = file.slice(start, end);

            // 每片只算一次 CRC（重试时复用），算不出来就不带校验头
            let crcPromise = null;
            const getCrc = () => {
                if (!crcPromise) crcPromise = chunkCrc32(chunk).catch(() => null);
                return crcPromise;
            };

            const doUpload = async () => {
                const task = uploadTasks.get(taskId);
                if (!task || task.isCancelled) return reject(new Error('cancelled'));

                const crc = await getCrc();
                if (!task || task.isCancelled) return reject(new Error('cancelled'));

                const xhr = new XMLHttpRequest();
                task.activeXHRs.add(xhr);

                // 卡死检测：一段时间没有任何进度就主动断开，交给重试
                let stallTimer = null;
                const armStall = () => {
                    if (stallTimer) clearTimeout(stallTimer);
                    stallTimer = setTimeout(() => {
                        console.warn(`[上传] 切片 ${chunkIndex} 超过 ${STALL_TIMEOUT_MS / 1000}s 无进度，断开重试`);
                        try { xhr.abort(); } catch (e) { /* 已结束 */ }
                    }, STALL_TIMEOUT_MS);
                };
                const disarmStall = () => {
                    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
                };

                const scheduleRetry = (reason) => {
                    disarmStall();
                    task.activeXHRs.delete(xhr);
                    if (retryCount >= maxRetries) {
                        return reject(new Error(`Chunk ${chunkIndex}: ${reason}`));
                    }
                    retryCount++;
                    const delay = Math.min(500 * Math.pow(2, retryCount - 1), 4000) + Math.random() * 300;
                    console.warn(`[上传] 切片 ${chunkIndex} 重试 ${retryCount}/${maxRetries}（${reason}），${Math.round(delay)}ms 后`);
                    setTimeout(() => { doUpload().catch(() => {}); }, delay);
                };

                xhr.upload.onprogress = (e) => {
                    if (!e.lengthComputable) return;
                    armStall();
                    loadedBytesMap[chunkIndex] = e.loaded;

                    const currentUploaded = initialUploadedBytes +
                        Object.values(loadedBytesMap).reduce((a, b) => a + b, 0);

                    updateProgress(taskId, currentUploaded, file.size);
                    speedMeter.set(currentUploaded);
                };

                xhr.onload = () => {
                    disarmStall();
                    task.activeXHRs.delete(xhr);
                    if (xhr.status === 200) {
                        loadedBytesMap[chunkIndex] = chunk.size;
                        resolve();
                        return;
                    }
                    // 4xx（除 400 切片校验失败）重试也没用
                    if (xhr.status >= 400 && xhr.status < 500 && xhr.status !== 400) {
                        return reject(new Error(`Chunk ${chunkIndex} failed: HTTP ${xhr.status}`));
                    }
                    scheduleRetry(`HTTP ${xhr.status}`);
                };

                xhr.onerror = () => scheduleRetry('网络错误');

                xhr.onabort = () => {
                    const current = uploadTasks.get(taskId);
                    if (!current || current.isCancelled) {
                        disarmStall();
                        task.activeXHRs.delete(xhr);
                        return reject(new Error('cancelled'));
                    }
                    scheduleRetry('连接卡住');
                };

                armStall();
                // 裸二进制上传：请求体就是切片本身，服务端少一次临时文件落盘
                xhr.open('POST', '/upload/chunk', true);
                xhr.setRequestHeader('X-Upload-Mode', 'raw');
                xhr.setRequestHeader('X-File-Hash', fileHash);
                xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
                xhr.setRequestHeader('X-File-Size', String(file.size));
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                if (crc) {
                    xhr.setRequestHeader('X-Chunk-Crc32', crc);
                }
                xhr.send(chunk);
            };

            doUpload().catch((e) => reject(e instanceof Error ? e : new Error('Network error')));
        });
    };

    // 6. 控制并发池执行
    try {
        await poolExecuter(MAX_CONCURRENT_UPLOADS, pendingChunks, uploadChunkTask, () => {
            const task = uploadTasks.get(taskId);
            return !task || task.isCancelled;
        });
    } catch (err) {
        speedMeter.stop();
        if (speedText) speedText.textContent = err.message === 'cancelled' ? "已取消" : "上传中断";
        finishTask(taskId);
        return;
    }

    speedMeter.stop();

    // 7. 发起合并请求
    const task = uploadTasks.get(taskId);
    if (task && !task.isCancelled) {
        if (speedText) speedText.textContent = "提交合并请求...";
        try {
            const mergeRes = await fetch('/upload/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileHash, fileName: file.name, totalChunks,
                                       targetPath: currentPath || '' })
            });

            if (mergeRes.status === 202 || mergeRes.ok) {
                if (speedText) speedText.textContent = "后台合并中...";

                let isMerged = false;
                let attempts = 0;
                let notFoundCount = 0;
                const MAX_POLL_ATTEMPTS = 300; // 前 60 次 1s/次，之后 2s/次，最多约 10 分钟

                while (!isMerged && attempts < MAX_POLL_ATTEMPTS) {
                    const currentTask = uploadTasks.get(taskId);
                    if (!currentTask || currentTask.isCancelled) break;

                    await new Promise(r => setTimeout(r, attempts < 60 ? 1000 : 2000));
                    attempts++;

                    let statusData;
                    try {
                        const statusRes = await fetch(`/upload/merge_status?fileHash=${encodeURIComponent(fileHash)}`);
                        if (!statusRes.ok) continue;      // 服务端临时异常：继续重试
                        statusData = await statusRes.json();
                    } catch (e) {
                        continue;                          // 网络抖动：继续重试，直到次数用完
                    }

                    if (statusData.status === 'success') {
                        isMerged = true;
                        updateProgress(taskId, file.size, file.size);
                        if (speedText) {
                            speedText.textContent = (statusData.name && statusData.name !== file.name)
                                ? `已完成（服务端保存为 ${statusData.name}）`
                                : "已完成";
                        }
                    } else if (statusData.status === 'error') {
                        throw new Error(statusData.message || '合并失败');
                    } else if (statusData.status === 'processing') {
                        if (speedText) speedText.textContent = `后台合并中 ${statusData.progress || 0}%...`;
                    } else if (statusData.status === 'not_found') {
                        // 任务被清理或服务重启过：连续几次都查不到就别再空转
                        notFoundCount++;
                        if (notFoundCount >= 5) {
                            throw new Error('合并任务丢失（服务可能重启过），请刷新页面确认结果');
                        }
                    }
                }

                if (!isMerged) {
                    if (speedText) speedText.textContent = "合并等待超时，请刷新页面查看结果";
                }
            } else {
                let msg = '合并请求失败';
                try {
                    const errData = await mergeRes.json();
                    if (errData && errData.message) msg = errData.message;
                } catch (e) { /* 响应不是 JSON，用默认文案 */ }
                throw new Error(msg);
            }
        } catch (e) {
            if (speedText) {
                speedText.textContent = (e && e.message) ? `合并失败：${e.message}` : "合并过程出错";
            }
        }
        finishTask(taskId);
    }
}

const pendingProgress = new Map();
let progressFrame = null;

function updateProgress(taskId, uploadedBytes, totalBytes) {
    pendingProgress.set(taskId, [uploadedBytes, totalBytes]);
    if (progressFrame) return;
    // 进度事件很密集，合并到每帧一次，避免 DOM 操作抢占上传线程
    progressFrame = requestAnimationFrame(() => {
        progressFrame = null;
        pendingProgress.forEach(([uploaded, total], id) => {
            const percent = Math.min(100, Math.round((uploaded / total) * 100));
            const bar = document.getElementById('progress-' + id);
            const text = document.getElementById('percent-' + id);
            if (bar) bar.style.width = percent + '%';
            if (text) text.textContent = percent + '%';
        });
        pendingProgress.clear();
    });
}

async function poolExecuter(poolLimit, array, iteratorFn, checkCancelledFn) {
    const ret = [];
    const executing = [];
    for (const item of array) {
        if (checkCancelledFn && checkCancelledFn()) break;
        const p = Promise.resolve().then(() => iteratorFn(item));
        ret.push(p);

        if (poolLimit <= array.length) {
            const e = p.then(() => executing.splice(executing.indexOf(e), 1)).catch(() => {});
            executing.push(e);
            if (executing.length >= poolLimit) {
                await Promise.race(executing);
            }
        }
    }
    return Promise.all(ret);
}

function updateToastTitle() {
    const titleEl = document.getElementById('toast-title');
    if (titleEl) {
        if (uploadTasks.size === 0 && completedFilesCount > 0) {
            titleEl.textContent = `上传完成 (${completedFilesCount}/${totalFilesCount})`;
        } else {
            titleEl.textContent = `正在上传 (${completedFilesCount}/${totalFilesCount})`;
        }
    }
}

function finishTask(taskId) {
    uploadTasks.delete(taskId);
    completedFilesCount++;
    updateToastTitle();

    if (uploadTasks.size === 0) {
        setTimeout(() => {
            if (uploadTasks.size === 0) {
                const toast = document.getElementById('upload-toast');
                const container = document.getElementById('upload-list-container');
                
                if (toast) toast.classList.add('hidden');
                if (container) container.innerHTML = '';
                
                totalFilesCount = 0;
                completedFilesCount = 0;
            }
        }, 2000);
    }
}

function cancelSingleUpload(taskId) {
    const task = uploadTasks.get(taskId);
    if (task) {
        task.isCancelled = true;
        if (task.activeXHRs) {
            task.activeXHRs.forEach(xhr => xhr.abort());
        }
    }
    
    const card = document.getElementById(taskId);
    if (card) {
        card.style.transition = 'all 0.2s ease';
        card.style.opacity = '0';
        setTimeout(() => card.remove(), 200);
    }
}

function cancelAllUploads() {
    uploadTasks.forEach((task, taskId) => {
        task.isCancelled = true;
        if (task.activeXHRs) {
            task.activeXHRs.forEach(xhr => xhr.abort());
        }
    });

    const toast = document.getElementById('upload-toast');
    const container = document.getElementById('upload-list-container');
    
    if (toast) toast.classList.add('hidden');
    if (container) container.innerHTML = '';
    
    uploadTasks.clear();
    totalFilesCount = 0;
    completedFilesCount = 0;
}

document.addEventListener('DOMContentLoaded', initApp);
