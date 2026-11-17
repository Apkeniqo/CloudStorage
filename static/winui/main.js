// 应用入口：组装根组件、上传、拖拽、实时刷新

import { createApp, h, watch, onMounted, nextTick } from 'vue';
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

            h('div', {
                class: 'file-list-container ' + (state.viewMode === 'grid' ? 'view-grid' : 'view-list'),
                id: 'file-container'
            }, [
                state.view === 'admin'
                    ? h('iframe', {
                        id: 'admin-frame',
                        src: '/admin?embed=1',
                        title: '管理后台',
                        style: 'width:100%;height:100%;border:0;min-height:70vh'
                    })
                    : [
                        h(FileList),
                        h(SelectionBar)
                    ]
            ]),

            h('div', { class: 'status-bar' }, [
                h('span', {}, state.loading ? '正在同步…' : '已同步'),
                h('span', {}, visibleFiles.value.length + ' 项')
            ]),

            h(UploadPanel),
            h(ShareModal),
            h(BackgroundModal),
            h(ToastBar)
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

// 侧边栏抽屉（移动端）
window.toggleSidebar = function () {
    const el = document.getElementById('sidebar');
    const mask = document.getElementById('sidebar-mask');
    if (!el) return;
    const open = el.classList.toggle('open');
    if (mask) mask.classList.toggle('show', open);
    document.body.classList.toggle('sidebar-open', open);
};

window.closeSidebar = function () {
    const el = document.getElementById('sidebar');
    const mask = document.getElementById('sidebar-mask');
    if (el) el.classList.remove('open');
    if (mask) mask.classList.remove('show');
    document.body.classList.remove('sidebar-open');
};
