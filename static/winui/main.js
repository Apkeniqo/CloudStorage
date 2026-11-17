// 应用入口：组装根组件、上传、拖拽、实时刷新

import { createApp, h, watch, onMounted, nextTick, Teleport } from 'vue';
import WinUIOnWeb from 'winuionweb';
import {
    state, init, reload, visibleFiles, formatTime,
    uploadBackgroundFile, toast
} from './store.js';
import { addFiles } from './upload.js';
import {
    Sidebar, Toolbar, Breadcrumb, FileList, SelectionBar,
    UploadPanel, ShareModal, BackgroundModal, ToastBar, WinIcon
} from './components.js';

const App = {
    setup() {
        // 视图变化时同步 body 类（回收站样式、管理后台布局）
        watch(() => state.view, (v) => {
            document.body.classList.toggle('trash-mode', v === 'trash');
            document.body.classList.toggle('admin-mode', v === 'admin');
            if (v === 'admin') {
                state.adminOpened = true;
                // iframe 首次才会真正加载，之后复用，不再白闪
                nextTick(() => {
                    const fr = document.getElementById('admin-frame');
                    if (fr && fr.getAttribute('src') !== '/admin?embed=1') {
                        fr.setAttribute('src', '/admin?embed=1');
                    }
                });
            }
        }, { immediate: true });

        watch(() => state.showBackground, (open) => {
            if (open) nextTick(() => {
                // 背景弹窗里的滑杆：值同步到 CSS 变量
                syncBlur();
            });
        });

        function syncBlur() {
            const panel = document.getElementById('blur-panel');
            const bg = document.getElementById('blur-bg');
            if (panel) panel.value = state.blurPanel;
            if (bg) bg.value = state.blurBg;
        }

        return () => h('div', { class: 'vue-main' }, [
            h('div', { class: 'title-row' }, [h(Breadcrumb)]),

            // 文件区域（切到后台时隐藏，但保留 DOM）
            h('div', {
                class: 'file-list-container '
                    + (state.viewMode === 'grid' ? 'view-grid' : 'view-list')
                    + (state.view === 'admin' ? ' is-hidden' : ''),
                id: 'file-container'
            }, [
                h(FileList),
                h(SelectionBar)
            ]),

            // 管理后台：占文件列表的位置，常驻 iframe（不重建，避免白闪）
            h('div', { class: 'admin-view' + (state.view === 'admin' ? ' show' : '') }, [
                h('iframe', {
                    id: 'admin-frame',
                    class: 'admin-frame',
                    src: state.adminOpened ? '/admin?embed=1' : 'about:blank',
                    title: '管理后台'
                })
            ]),

            state.view === 'admin'
                ? null
                : h('div', { class: 'status-bar' }, [
                    h('span', {}, state.loading ? '正在同步…' : '已同步'),
                    h('span', { class: 'status-right' }, [
                        h('span', {}, visibleFiles.value.length + ' 项'),
                        state.version ? h('span', { class: 'status-version' }, ' · ' + state.version) : null
                    ])
                ]),

            // 所有 fixed 浮层都 Teleport 到 body：
            // 祖先若有 backdrop-filter / transform / overflow 会成为 containing block，
            // 导致 position:fixed 被裁剪或压成 0 尺寸
            h(Teleport, { to: 'body' }, [h(UploadPanel)]),
            h(Teleport, { to: 'body' }, [h(ShareModal)]),
            h(Teleport, { to: 'body' }, [h(BackgroundModal)]),
            h(Teleport, { to: 'body' }, [h(ToastBar)])
        ]);
    }
};

// ---------------------------------------------------------------- 上传与拖拽

function bindFileInputs() {
    const fileInput = document.getElementById('file-input');
    if (fileInput) {
        fileInput.addEventListener('change', async () => {
            const files = Array.from(fileInput.files || []);
            fileInput.value = '';
            if (!files.length) return;
            await addFiles(files, state.path);
            await reload();
        });
    }
    const bgInput = document.getElementById('bg-input');
    if (bgInput) {
        bgInput.addEventListener('change', async () => {
            const file = (bgInput.files || [])[0];
            bgInput.value = '';
            if (!file) return;
            try {
                await uploadBackgroundFile(file);
            } catch (e) {
                toast('背景上传失败：' + e.message, 'error');
            }
        });
    }
}

function bindDragDrop() {
    let overlay = null;
    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.className = 'drop-overlay';
        overlay.innerHTML = '<div class="drop-card">'
            + '<div class="drop-title">松开鼠标即可上传</div>'
            + '<div class="drop-sub">支持多个文件，文件夹会被忽略</div></div>';
        document.body.appendChild(overlay);
        return overlay;
    }

    let depth = 0;
    window.addEventListener('dragenter', (e) => {
        if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
        e.preventDefault();
        depth++;
        ensureOverlay().classList.add('show');
    });
    window.addEventListener('dragover', (e) => {
        if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
        e.preventDefault();
    });
    window.addEventListener('dragleave', (e) => {
        if (!e.dataTransfer || Array.from(e.dataTransfer.types || []).indexOf('Files') < 0) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0 && overlay) overlay.classList.remove('show');
    });
    window.addEventListener('drop', async (e) => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        depth = 0;
        if (overlay) overlay.classList.remove('show');
        if (state.view === 'trash' || state.isGuest) return;
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        await addFiles(files, state.path);
        await reload();
    });
}

// ---------------------------------------------------------------- 实时刷新

function bindSocket() {
    if (typeof io !== 'function') return;
    let timer = null;
    try {
        const socket = io({ transports: ['polling'] });
        socket.on('files_changed', () => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                reload();
            }, 600);
        });
    } catch (e) { /* 离线时忽略 */ }
}

// ---------------------------------------------------------------- 启动

function mount() {
    const root = document.getElementById('winui-app');
    if (root) {
        const app = createApp(App);
        app.use(WinUIOnWeb, { locale: 'zh-CN' });
        app.mount(root);
    }

    const side = document.getElementById('winui-sidebar');
    if (side) {
        const app = createApp(Sidebar);
        app.use(WinUIOnWeb, { locale: 'zh-CN' });
        app.mount(side);
    }

    const bar = document.getElementById('winui-toolbar');
    if (bar) {
        const app = createApp(Toolbar);
        app.use(WinUIOnWeb, { locale: 'zh-CN' });
        app.mount(bar);
    }

    bindFileInputs();
    bindDragDrop();
    bindSocket();
    init();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}

// ?diag=1：右下角显示诊断信息，便于排查「页面看起来没变化」
if (new URLSearchParams(location.search).has('diag')) {
    const box = document.createElement('pre');
    box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99999;max-width:46vw;'
        + 'max-height:40vh;overflow:auto;margin:0;padding:8px 10px;border-radius:8px;'
        + 'background:rgba(0,0,0,.82);color:#7CFC00;font:11px/1.5 Consolas,monospace;'
        + 'white-space:pre-wrap;pointer-events:none';
    document.body.appendChild(box);
    setInterval(() => {
        const fr = document.getElementById('admin-frame');
        const rows = document.querySelectorAll('#winui-app .file-item').length;
        box.textContent = [
            'version   : ' + (state.version || '(未取到)'),
            'view      : ' + state.view,
            'role      : ' + (state.role || '-'),
            'isAdmin   : ' + state.isAdmin,
            'items     : ' + state.items.length + ' （可见 ' + visibleFiles.value.length + '，DOM 行 ' + rows + '）',
            'loading   : ' + state.loading,
            'error     : ' + (state.error || '-'),
            'viewMode  : ' + state.viewMode,
            'iframe    : ' + (fr ? '有 ' + fr.offsetWidth + 'x' + fr.offsetHeight : '无'),
            'window    : ' + window.innerWidth + 'x' + window.innerHeight,
            'sidebar   : ' + (document.getElementById('sidebar')
                ? getComputedStyle(document.getElementById('sidebar')).display : '-')
        ].join('\n');
    }, 400);
}

// 侧边栏：桌面折叠 / 移动端抽屉
window.toggleSidebar = function () {
    const narrow = window.innerWidth <= 900;
    const el = document.getElementById('sidebar');
    if (!el) return;

    if (narrow) {
        const open = el.classList.toggle('open');
        const mask = document.getElementById('sidebar-mask');
        if (mask) mask.classList.toggle('show', open);
        document.body.classList.toggle('sidebar-open', open);
        return;
    }

    // 桌面：整列收起/展开
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    try { localStorage.setItem('fluent_sidebar', collapsed ? '0' : '1'); } catch (e) {}
};

window.closeSidebar = function () {
    const el = document.getElementById('sidebar');
    const mask = document.getElementById('sidebar-mask');
    if (el) el.classList.remove('open');
    if (mask) mask.classList.remove('show');
    document.body.classList.remove('sidebar-open');
};

// 窄屏点击导航后自动收起抽屉
window.addEventListener('resize', function () {
    if (window.innerWidth > 900) {
        document.body.classList.remove('sidebar-open');
        const el = document.getElementById('sidebar');
        if (el) el.classList.remove('open');
        const mask = document.getElementById('sidebar-mask');
        if (mask) mask.classList.remove('show');
    }
});

// 恢复上次的折叠状态（桌面）
try {
    if (localStorage.getItem('fluent_sidebar') === '0' && window.innerWidth > 900) {
        document.body.classList.add('sidebar-collapsed');
    }
} catch (e) {}
