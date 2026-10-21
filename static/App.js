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

// 核心状态管理
let rawFilesData = [];
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

    // 删除按钮用事件委托：文件名可能带引号，直接拼 onclick 会坏
    if (itemsWrapper) {
        itemsWrapper.addEventListener('click', (e) => {
            const target = e.target;
            if (!target || !target.closest) return;
            const del = target.closest('.delete-btn');
            if (del) {
                e.preventDefault();
                deleteFile(del.dataset.name);
                return;
            }
            const ren = target.closest('.rename-btn');
            if (ren) {
                e.preventDefault();
                renameFile(ren.dataset.name);
                return;
            }
            const share = target.closest('.share-btn');
            if (share) {
                e.preventDefault();
                shareFile(share.dataset.name);
            }
        });
    }

    // 取当前登录用户，用于状态栏显示
    fetch('/auth/me', { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
            if (data && data.username) {
                currentUsername = data.username;
                if (statusText && statusText.textContent.indexOf('已连接') === 0) {
                    statusText.textContent = `已连接（实时同步）· ${currentUsername}`;
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
    if (socket && socket.connected) {
        socket.emit('get_files');
    }
}

function setViewMode(mode, save = true) {
    currentView = mode;
    if (save) localStorage.setItem('fluent_view', mode);

    if (fileContainer) {
        fileContainer.className = `file-list-container view-${mode}`;
    }
    
    const btnList = document.getElementById('btn-view-list');
    const btnGrid = document.getElementById('btn-view-grid');
    if (btnList) btnList.classList.toggle('active', mode === 'list');
    if (btnGrid) btnGrid.classList.toggle('active', mode === 'grid');
    
    renderFileList();
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
        let res = 0;
        if (field === 'name') {
            res = a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' });
        } else if (field === 'size') {
            res = a.size - b.size;
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

socket.on('file_update', (files) => {
    rawFilesData = files || [];
    renderFileList();
});

function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
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

function handleSearch(query) {
    searchQuery = query.trim().toLowerCase();
    const clearBtn = document.getElementById('clear-search');
    if (clearBtn) clearBtn.style.display = searchQuery ? 'inline-block' : 'none';
    renderFileList();
}

function clearSearch() {
    const searchInput = document.getElementById('search-input');
    if (searchInput) {
        searchInput.value = '';
        handleSearch('');
        searchInput.focus();
    }
}

function renderFileList() {
    if (!itemsWrapper) return;
    let files = getSortedFiles();

    if (searchQuery) {
        files = files.filter(f => f.name.toLowerCase().includes(searchQuery));
    }

    if (fileCount) {
        if (searchQuery) {
            fileCount.textContent = `找到 ${files.length} 项 (共 ${rawFilesData.length} 项)`;
        } else {
            fileCount.textContent = `${files.length} 项`;
        }
    }

    updateHeaderSortIcons();

    if (files.length === 0) {
        const emptyMsg = searchQuery ? '未找到匹配的文件' : '暂无文件，点击上方上传';
        itemsWrapper.innerHTML = `<div class="empty-state">${emptyMsg}</div>`;
        return;
    }

    const downloadIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;

    itemsWrapper.innerHTML = files.map(file => {
        const downloadUrl = `/download/${encodeURIComponent(file.name)}`;
        const safeName = escapeHtml(file.name);
        return `
            <div class="file-item">
                <div class="file-name" title="${safeName}">
                    ${getFileIconSvg(file.name)}
                    <a href="${downloadUrl}" download="${safeName}" class="file-name-link">
                        ${safeName}
                    </a>
                </div>
                <div class="file-size">${formatSize(file.size)}</div>
                <div class="file-time" title="${file.uploader ? '上传者：' + escapeHtml(file.uploader) : ''}">${formatTime(file.mtime)}</div>
                <div class="file-action" style="text-align: right;">
                    <a href="${downloadUrl}" download="${file.name}" class="download-btn" title="下载">
                        ${downloadIconSvg}
                    </a>
                    <button class="share-btn" data-name="${safeName}" title="分享">⇱</button>
                    <button class="rename-btn" data-name="${safeName}" title="重命名">✎</button>
                    <button class="delete-btn" data-name="${safeName}" title="删除">✕</button>
                </div>
            </div>
        `;
    }).join('');
}

// 生成分享链接
async function shareFile(name) {
    if (!name) return;
    const hours = prompt(`生成「${name}」的分享链接\n有效期（小时，0 = 永久）：`, '24');
    if (hours === null) return;
    const maxDownloads = prompt('可下载次数（0 = 不限）：', '0');
    if (maxDownloads === null) return;

    try {
        const res = await fetch('/api/shares', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, expire_hours: hours, max_downloads: maxDownloads })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.message || `生成失败（${res.status}）`); return; }
        prompt('分享链接已生成（复制后发送给对方）：', location.origin + data.url);
    } catch (e) {
        alert('生成失败：' + e);
    }
}

// 重命名文件
async function renameFile(name) {
    if (!name) return;
    const input = prompt(`把「${name}」重命名为：`, name);
    if (input === null) return;
    const newName = input.trim();
    if (!newName || newName === name) return;

    try {
        const res = await fetch('/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, newName })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) alert(data.message || `重命名失败（${res.status}）`);
    } catch (e) {
        alert('重命名失败：' + e);
    }
}

// 删除文件（移到回收站）
async function deleteFile(name) {
    if (!name) return;
    if (!confirm(`确定删除「${name}」？\n文件会移到回收站，之后可以恢复。`)) return;
    try {
        const res = await fetch('/files/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            alert(data.message || `删除失败（${res.status}）`);
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

    const files = Array.from(input.files);
    totalFilesCount += files.length;
    updateToastTitle();

    const toast = document.getElementById('upload-toast');
    const container = document.getElementById('upload-list-container');
    if (toast) toast.classList.remove('hidden');

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

        // 根据文件大小进行智能路由分流
        const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024; // 200MB

        if (file.size < LARGE_FILE_THRESHOLD) {
            // 小文件：单流上传
            await uploadSingleFileStream(file, taskId);
        } else {
            // 大文件：分片并发上传
            await uploadLargeFileChunks(file, taskId);
        }
    }

    input.value = ''; // 清空选择
}

// 小文件单流上传处理
function uploadSingleFileStream(file, taskId) {
    return new Promise((resolve) => {
        const speedText = document.getElementById(`speed-${taskId}`);
        if (speedText) speedText.textContent = "极速通道传输中...";

        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append('file', file);

        // 注册到全局任务，支持单项取消
        uploadTasks.set(taskId, {
            isCancelled: false,
            activeXHRs: new Set([xhr]),
            file: file
        });

        let lastSampleTime = Date.now();
        let lastSampleBytes = 0;

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                // 更新进度条
                updateProgress(taskId, e.loaded, e.total);

                // 平滑计算实时网速
                const now = Date.now();
                const timeDiff = (now - lastSampleTime) / 1000;

                if (timeDiff >= 0.3 || e.loaded === e.total) {
                    const bytesDiff = e.loaded - lastSampleBytes;
                    if (bytesDiff > 0 && timeDiff > 0) {
                        const speed = bytesDiff / timeDiff;
                        if (speedText) speedText.textContent = formatSize(speed) + '/s';
                    }
                    lastSampleTime = now;
                    lastSampleBytes = e.loaded;
                }
            }
        };

        xhr.onload = () => {
            if (xhr.status === 200) {
                updateProgress(taskId, file.size, file.size);
                if (speedText) speedText.textContent = "已完成";
            } else {
                if (speedText) speedText.textContent = "上传失败";
            }
            finishTask(taskId);
            resolve();
        };

        xhr.onerror = () => {
            if (speedText) speedText.textContent = "网络错误";
            finishTask(taskId);
            resolve();
        };

        xhr.onabort = () => {
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
    
    let lastSampleTime = Date.now();
    let lastSampleBytes = initialUploadedBytes;
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
            const maxRetries = 3;

            const doUpload = () => {
                const task = uploadTasks.get(taskId);
                // 双重容错校验，防止 task 丢失
                if (!task || task.isCancelled) {
                    return reject(new Error('cancelled'));
                }

                const start = chunkIndex * chunkSize;
                const end = Math.min(file.size, start + chunkSize);
                const chunk = file.slice(start, end);

                const xhr = new XMLHttpRequest();
                task.activeXHRs.add(xhr);

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        loadedBytesMap[chunkIndex] = e.loaded;

                        const currentUploaded = initialUploadedBytes + 
                            Object.values(loadedBytesMap).reduce((a, b) => a + b, 0);

                        updateProgress(taskId, currentUploaded, file.size);

                        const now = Date.now();
                        const timeDiff = (now - lastSampleTime) / 1000;

                        if (timeDiff >= 0.3 || currentUploaded === file.size) {
                            const bytesDiff = currentUploaded - lastSampleBytes;
                            if (bytesDiff >= 0 && timeDiff > 0) {
                                const speed = bytesDiff / timeDiff;
                                if (speedText) speedText.textContent = formatSize(speed) + '/s';
                            }
                            lastSampleTime = now;
                            lastSampleBytes = currentUploaded;
                        }
                    }
                };

                xhr.onload = () => {
                    task.activeXHRs.delete(xhr);
                    if (xhr.status === 200) {
                        loadedBytesMap[chunkIndex] = chunk.size;
                        resolve();
                    } else if (retryCount < maxRetries) {
                        retryCount++;
                        // 指数退避：1s → 2s → 4s，避免服务端抖动时被连续重试打满
                        setTimeout(doUpload, Math.min(1000 * Math.pow(2, retryCount - 1), 8000));
                    } else {
                        reject(new Error(`Chunk error: ${xhr.status}`));
                    }
                };

                xhr.onerror = () => {
                    task.activeXHRs.delete(xhr);
                    if (retryCount < maxRetries) {
                        retryCount++;
                        setTimeout(doUpload, Math.min(1000 * Math.pow(2, retryCount - 1), 8000));
                    } else {
                        reject(new Error('Network error'));
                    }
                };

                // 裸二进制上传：请求体就是切片本身，服务端少一次临时文件落盘
                xhr.open('POST', '/upload/chunk', true);
                xhr.setRequestHeader('X-Upload-Mode', 'raw');
                xhr.setRequestHeader('X-File-Hash', fileHash);
                xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
                xhr.setRequestHeader('Content-Type', 'application/octet-stream');
                xhr.send(chunk);
            };

            doUpload();
        });
    };

    // 6. 控制并发池执行
    try {
        await poolExecuter(MAX_CONCURRENT_UPLOADS, pendingChunks, uploadChunkTask, () => {
            const task = uploadTasks.get(taskId);
            return !task || task.isCancelled;
        });
    } catch (err) {
        if (speedText) speedText.textContent = err.message === 'cancelled' ? "已取消" : "上传中断";
        finishTask(taskId);
        return;
    }

    // 7. 发起合并请求
    const task = uploadTasks.get(taskId);
    if (task && !task.isCancelled) {
        if (speedText) speedText.textContent = "提交合并请求...";
        try {
            const mergeRes = await fetch('/upload/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileHash, fileName: file.name, totalChunks })
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

function updateProgress(taskId, uploadedBytes, totalBytes) {
    const percent = Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
    const progressBar = document.getElementById(`progress-${taskId}`);
    const percentText = document.getElementById(`percent-${taskId}`);
    if (progressBar) progressBar.style.width = percent + '%';
    if (percentText) percentText.textContent = percent + '%';
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