// 组件：图标、侧边栏、工具栏、面包屑、文件列表、选择条、上传面板

import { computed, h, ref, watch, onMounted, nextTick } from 'vue';
import { Button, TextBlock, TextBox, CheckBox, ProgressBar } from 'winuionweb';
import {
    state, visibleFiles, selectedCount, allSelected,
    navTo, navigateTo, setViewMode, toggleViewMode, setSort, setSearch,
    toggleSelect, selectAll, clearSelection, deleteSelected, deleteOne,
    renameAction, createFolderAction, copySelection, pasteSelection,
    toggleHidden, restoreOne, purgeOne, emptyTrashAll, shareOne,
    openShares, formatSize, formatTime, toast, setBlur, setOpacity
} from './store.js';
import { uploads, addFiles, cancelTask, cancelAll, clearFinished } from './upload.js';

const PATHS = {
    cloud: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    files: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    admin: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    background: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
    logout: 'M10 17l1.41-1.41L8.83 13H20v-2H8.83l2.58-2.59L10 7l-5 5 5 5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
    folderPlus: 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    grid: 'M4 11h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1zm10 0h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1zM4 21h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1zm10 0h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    cut: 'M9.64 7.64a3 3 0 1 0-1.41 1.41L10.59 12l-2.36 2.36a3 3 0 1 0 1.41 1.41L12 13.41l7.59 7.59L21 19.59 13.41 12 21 4.41 19.59 3 12 10.59 9.64 7.64zM6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 12a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
    paste: 'M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z',
    sun: 'M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z',
    moon: 'M12.3 2a10 10 0 0 0-1.9 20 10 10 0 0 0 9.8-7.7 1 1 0 0 0-1.2-1.2 8 8 0 1 1-6.7-11.1 1 1 0 0 0 0-2z',
    upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
    search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    share: 'M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z',
    rename: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    restore: 'M13 3a9 9 0 1 0 8.94 10h-2.02A7 7 0 1 1 13 5v3l4-4-4-4v3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
    eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    eyeOff: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27z',
    file: 'M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z',
    image: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
    doc: 'M6 2c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6H6zm7 7V3.5L18.5 9H13z',
    sheet: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM8 12h8v2H8v-2zm0 4h8v2H8v-2z',
    ppt: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM8 13h3a2 2 0 0 1 0 4H9v3H8v-7z'
};

export const WinIcon = {
    props: { name: { type: String, default: 'file' }, size: { type: [Number, String], default: 18 } },
    setup(props) {
        return () => {
            const d = PATHS[props.name] || PATHS.file;
            const s = Number(props.size) || 18;
            const out = { width: s, height: s, viewBox: '0 0 24 24', fill: 'currentColor' };
            return h('svg', out, [h('path', { d: d })]);
        };
    }
};


function fileIconName(file) {
    if (file.is_dir) return 'files';
    const n = (file.name || '').toLowerCase();
    if (/\.(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(n)) return 'image';
    if (/\.(xlsx?|csv)$/.test(n)) return 'sheet';
    if (/\.(pptx?)$/.test(n)) return 'ppt';
    if (/\.(docx?|txt|md|pdf)$/.test(n)) return 'doc';
    return 'file';
}

// ---------------------------------------------------------------- 侧边栏

export const Sidebar = {
    name: 'WinUISidebar',
    setup() {
        const navs = computed(() => {
            return [
                { key: 'home', icon: 'home', label: '主页' },
                { key: 'files', icon: 'files', label: '我的文件' },
                { key: 'trash', icon: 'trash', label: '回收站' }
            ];
        });

        const navRef = ref(null);
        const indRef = ref(null);
        const INDICATOR_H = 16;

        // 把指示条移到当前选中项（animate=false 时直接落位，用于首次渲染）
        function placeIndicator(animate) {
            const nav = navRef.value;
            const ind = indRef.value;
            if (!nav || !ind) return;
            const active = nav.querySelector('.side-item.active');
            if (!active) {
                ind.style.opacity = '0';
                return;
            }
            const top = active.offsetTop + Math.max(0, (active.offsetHeight - INDICATOR_H) / 2);
            if (!animate) ind.style.transition = 'none';
            ind.style.transform = 'translateY(' + Math.round(top) + 'px)';
            ind.style.opacity = '1';
            if (!animate) {
                void ind.offsetWidth;
                requestAnimationFrame(() => { ind.style.transition = ''; });
            }
        }

        onMounted(() => {
            placeIndicator(false);
            window.addEventListener('resize', () => placeIndicator(false));
        });

        watch(() => state.view, () => {
            nextTick(() => placeIndicator(true));
        });

        watch(navs, () => {
            nextTick(() => placeIndicator(false));
        });

        return () => h('div', { class: 'win-theme-scope ' + (state.dark ? 'theme-dark' : 'theme-light'), style: 'display:contents' }, [
            h('div', { class: 'brand' }, [
                h(WinIcon, { name: 'cloud', size: 22 }),
                h('span', { class: 'brand-name' }, state.username || '我的云盘')
            ]),
            h('div', { class: 'side-search' }, [
                h(TextBox, {
                    PlaceholderText: '搜索',
                    Text: state.search,
                    'onUpdate:Text': (v) => setSearch(v)
                })
            ]),
            h('nav', { class: 'side-nav', ref: navRef }, [
                ...navs.value.map(n => h(Button, {
                    class: 'side-item' + (state.view === n.key ? ' active' : ''),
                    Background: 'transparent',
                    BorderThickness: 0,
                    Padding: '0 12px',
                    Height: 36,
                    MinHeight: 36,
                    onClick: () => {
                        navTo(n.key);
                        if (window.innerWidth <= 900 && typeof window.closeSidebar === 'function') {
                            window.closeSidebar();
                        }
                    }
                }, () => h('span', { class: 'side-item-inner' }, [
                    h('span', { class: 'side-item-icon' }, [h(WinIcon, { name: n.icon, size: 18 })]),
                    h('span', { class: 'side-item-label' }, n.label)
                ]))),
                // 单一指示条：切换时在选项之间滑动
                h('i', { class: 'side-indicator', ref: indRef })
            ]),
            h('div', { class: 'side-bottom' }, [
                h('div', { class: 'side-storage' }, [
                    h('div', { class: 'side-storage-title' }, '存储'),
                    h('div', { class: 'side-storage-bar' }, [
                        h('i', { style: 'width:' + state.storage.percent + '%' })
                    ]),
                    h('div', { class: 'side-storage-text', title: state.storage.title }, state.storage.text)
                ]),
                h(Button, {
                    class: 'side-item side-action',
                    Background: 'transparent', BorderThickness: 0, Height: 36, MinHeight: 36,
                    onClick: () => { state.showBackground = true; }
                }, () => h('span', { class: 'side-item-inner' }, [
                    h('span', { class: 'side-item-icon' }, [h(WinIcon, { name: 'background', size: 18 })]),
                    h('span', { class: 'side-item-label' }, '背景')
                ])),
                state.isAdmin ? h(Button, {
                    class: 'side-item side-action' + (state.view === 'admin' ? ' active' : ''),
                    Background: 'transparent', BorderThickness: 0, Height: 36, MinHeight: 36,
                    onClick: () => {
                        navTo('admin');
                        if (window.innerWidth <= 900 && typeof window.closeSidebar === 'function') {
                            window.closeSidebar();
                        }
                    }
                }, () => h('span', { class: 'side-item-inner' }, [
                    h('span', { class: 'side-item-icon' }, [h(WinIcon, { name: 'admin', size: 18 })]),
                    h('span', { class: 'side-item-label' }, '管理后台')
                ])) : null,
                h(Button, {
                    class: 'side-item side-action',
                    Background: 'transparent', BorderThickness: 0, Height: 36, MinHeight: 36,
                    onClick: () => { window.location.href = '/logout'; }
                }, () => h('span', { class: 'side-item-inner' }, [
                    h('span', { class: 'side-item-icon' }, [h(WinIcon, { name: 'logout', size: 18 })]),
                    h('span', { class: 'side-item-label' }, '退出登录')
                ]))
            ])
        ]);
    }
};

// ---------------------------------------------------------------- 工具栏

function iconBtn(props, icon, onClick, enabled) {
    const on = enabled !== false;
    return h(Button, {
        Background: 'transparent', BorderBrush: 'transparent', BorderThickness: 0,
        Padding: 6, Width: 40, Height: 32, MinWidth: 36, MinHeight: 32,
        ...props,
        IsEnabled: true,
        class: 'winui-icon-btn ' + (on ? '' : 'winui-disabled ') + (props.class || ''),
        onClick: (e) => {
            // winuionweb 的 Button 可能不带事件参数回调，这里必须防御性判断，
            // 否则 e 为 undefined 时 e.stopPropagation() 抛错，整个回调都不会执行
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            if (on) onClick(e);
        }
    }, () => h(WinIcon, { name: icon, size: 18 }));
}

export const Toolbar = {
    name: 'WinUIToolbar',
    setup() {
        return () => h('div', { class: 'win-theme-scope ' + (state.dark ? 'theme-dark' : 'theme-light'), style: 'display:contents' }, [
            h('div', { class: 'toolbar-extra' }, [
                iconBtn({ title: '新建文件夹' }, 'folderPlus', () => {
                    const name = window.prompt('新建文件夹，输入名称：', '新建文件夹');
                    if (name && name.trim()) createFolderAction(name.trim()).catch(e => toast(e.message, 'error'));
                }, state.view !== 'trash'),
                iconBtn({ title: state.viewMode === 'list' ? '切换到图标视图' : '切换到列表视图' },
                    state.viewMode === 'list' ? 'grid' : 'list', toggleViewMode),
                iconBtn({ title: '复制' }, 'copy', () => copySelection('copy'),
                    selectedCount.value > 0 && state.view !== 'trash'),
                iconBtn({ title: '剪切' }, 'cut', () => copySelection('cut'),
                    selectedCount.value > 0 && state.view !== 'trash'),
                iconBtn({ title: '粘贴' }, 'paste', () => pasteSelection().catch(e => toast(e.message, 'error')),
                    state.clipboard.paths.length > 0 && state.view !== 'trash'),
                iconBtn({ title: '切换主题' }, state.dark ? 'sun' : 'moon', () => {
                    import('./store.js').then(m => m.toggleTheme());
                })
            ]),
            h(Button, {
                Style: 'AccentButtonStyle', Content: '上传', class: 'winui-upload-btn',
                IsEnabled: state.view !== 'trash',
                onClick: () => {
                    const input = document.getElementById('file-input');
                    if (input) input.click();
                }
            }),
            iconBtn({ title: '清空回收站', class: 'trash-only' }, 'trash',
                () => emptyTrashAll().catch(e => toast(e.message, 'error')), state.view === 'trash')
        ]);
    }
};

// ---------------------------------------------------------------- 面包屑

export const Breadcrumb = {
    setup() {
        return () => h('nav', { class: 'breadcrumb' }, state.crumbs.map((c, i) => {
            const last = i === state.crumbs.length - 1;
            const nodes = [];
            if (i) nodes.push(h('span', { class: 'crumb-sep' }, '/'));
            nodes.push(h('span', {
                class: 'crumb' + (last ? ' current' : ''),
                onClick: () => {
                    if (last) return;
                    if (state.view === 'trash' || state.view === 'admin') { navTo('files'); return; }
                    navigateTo(c.path);
                }
            }, c.name || '主页'));
            return nodes;
        }).concat([h('span', { class: 'crumb-sep crumb-trail' }, '/')]));
    }
};

// ---------------------------------------------------------------- 行操作

function rowActions(file) {
    const path = file.path || file.name;
    const isDir = !!file.is_dir;
    const nodes = [];

    if (state.isGuest) {
        if (!isDir) nodes.push(iconBtn({ title: '下载', class: 'action-btn' }, 'download',
            () => { window.location.href = '/download/' + encodeURIComponent(path); }));
        return nodes;
    }

    if (state.view === 'trash') {
        nodes.push(iconBtn({ title: '恢复', class: 'action-btn' }, 'restore',
            () => restoreOne(path).catch(e => toast(e.message, 'error'))));
        nodes.push(iconBtn({ title: '彻底删除', class: 'action-btn' }, 'delete',
            () => purgeOne(path).catch(e => toast(e.message, 'error'))));
        return nodes;
    }

    if (!isDir) {
        nodes.push(iconBtn({ title: '下载', class: 'action-btn' }, 'download',
            () => { window.location.href = '/download/' + encodeURIComponent(path); }));
        nodes.push(iconBtn({ title: '分享', class: 'action-btn' }, 'share',
            () => shareOne(path).catch(e => toast(e.message, 'error'))));
    }
    nodes.push(iconBtn({ title: '重命名', class: 'action-btn' }, 'rename', () => {
        const old = file.name;
        const name = window.prompt('重命名为：', old);
        if (name === null) return;
        const trimmed = name.trim();
        if (!trimmed || trimmed === old) return;
        renameAction(path, trimmed).catch(e => toast(e.message, 'error'));
    }));
    if (state.isAdmin) {
        nodes.push(iconBtn({ title: file.hidden ? '取消隐藏' : '隐藏（仅管理员可见）', class: 'action-btn' },
            file.hidden ? 'eye' : 'eyeOff',
            () => toggleHidden(path, !file.hidden).catch(e => toast(e.message, 'error'))));
    }
    nodes.push(iconBtn({ title: '删除', class: 'action-btn' }, 'delete',
        () => deleteOne(path).catch(e => toast(e.message, 'error'))));
    return nodes;
}

// ---------------------------------------------------------------- 文件列表

export const FileList = {
    setup() {
        return () => {
            if (state.loading && !visibleFiles.value.length) {
                return h('div', { class: 'empty-state' }, '正在加载…');
            }
            if (state.error) {
                return h('div', { class: 'empty-state' }, '加载失败：' + state.error);
            }
            const files = visibleFiles.value;
            if (!files.length) {
                return h('div', { class: 'empty-state' },
                    state.search ? '没有匹配的文件' : '这个文件夹是空的，点击上传或拖入文件');
            }

            // 视图/路径变化时重建内容，触发 WinUI Entrance 动画
            const viewKey = state.view + '|' + state.path;

            if (state.viewMode === 'grid') {
                return h('div', { class: 'grid-wrap', key: 'g:' + viewKey }, files.map(f => {
                    const path = f.path || f.name;
                    return h('div', {
                        class: 'file-item' + (f.is_dir ? ' is-dir' : '') + (state.selected.includes(path) ? ' selected' : ''),
                        onClick: () => { if (f.is_dir && !state.isTrash) navigateTo(path); }
                    }, [
                        h('input', {
                            type: 'checkbox', class: 'row-check',
                            checked: state.selected.includes(path),
                            onClick: (e) => { e.stopPropagation(); toggleSelect(path); }
                        }),
                        h('div', { class: 'grid-icon' }, [h(WinIcon, { name: fileIconName(f), size: 40 })]),
                        h('div', { class: 'grid-name', title: f.name }, f.name),
                        h('div', { class: 'grid-meta' }, (f.is_dir ? '—' : formatSize(f.size))
                            + ' · ' + formatTime(f.mtime)),
                        h('div', { class: 'grid-actions' }, rowActions(f))
                    ]);
                }));
            }

            return h('div', { class: 'list-wrap', key: 'l:' + viewKey }, [
                h('div', { class: 'file-header' }, [
                    h('div', { class: 'col-check' }, [
                        h('input', {
                            type: 'checkbox', id: 'select-all',
                            checked: allSelected.value,
                            onClick: (e) => selectAll(e.target.checked)
                        })
                    ]),
                    h('div', { onClick: () => setSort('name') }, '名称'),
                    h('div', { onClick: () => setSort('size') }, '大小'),
                    h('div', { onClick: () => setSort('mtime') }, '修改时间'),
                    h('div', {}, '操作')
                ]),
                files.map(f => {
                    const path = f.path || f.name;
                    const cut = state.clipboard.mode === 'cut' && state.clipboard.paths.includes(path);
                    return h('div', {
                        class: 'file-item'
                            + (f.is_dir ? ' is-dir' : '')
                            + (state.selected.includes(path) ? ' selected' : '')
                            + (f.hidden ? ' is-hidden' : '')
                            + (cut ? ' cutting' : ''),
                        // 整行可点：文件夹点哪都能进去（回收站除外）
                        onClick: () => {
                            if (f.is_dir && state.view !== 'trash') navigateTo(path);
                        }
                    }, [
                        h('div', { class: 'col-check' }, [
                            h('input', {
                                type: 'checkbox', class: 'row-check',
                                checked: state.selected.includes(path),
                                onClick: (e) => { e.stopPropagation(); toggleSelect(path); }
                            })
                        ]),
                        h('div', { class: 'file-name', title: f.name },
                            [h(WinIcon, { name: fileIconName(f), size: 16 }),
                             h(state.view === 'trash' ? 'span' : 'a', {
                                 class: 'file-name-link',
                                 onClick: (e) => {
                                     if (f.is_dir && state.view !== 'trash') {
                                         e.preventDefault();
                                         e.stopPropagation();
                                         navigateTo(path);
                                     }
                                 }
                             }, f.name)]),
                        h('div', { class: 'file-size' }, f.is_dir ? '—' : formatSize(f.size)),
                        h('div', { class: 'file-time' }, formatTime(f.mtime)),
                        h('div', { class: 'file-action' }, rowActions(f))
                    ]);
                })
            ]);
        };
    }
};

// ---------------------------------------------------------------- 选择条

export const SelectionBar = {
    setup() {
        return () => selectedCount.value > 0
            ? h('div', {
                class: 'selection-bar show win-theme-scope ' + (state.dark ? 'theme-dark' : 'theme-light')
            }, [
                h('span', { class: 'selection-count' }, ['已选 ', h('b', {}, String(selectedCount.value)), ' 项']),
                h('div', { class: 'selection-actions' }, [
                    h(Button, {
                        Content: '删除',
                        MinHeight: 32,
                        onClick: () => deleteSelected().catch(e => toast(e.message, 'error'))
                    }),
                    h(Button, {
                        Content: '取消',
                        MinHeight: 32,
                        onClick: clearSelection
                    })
                ])
            ])
            : null;
    }
};

// ---------------------------------------------------------------- 上传面板

export const UploadPanel = {
    setup() {
        return () => uploads.tasks.length
            ? h('div', { class: 'upload-toast win-theme-scope ' + (state.dark ? 'theme-dark' : 'theme-light') }, [
                h('div', { class: 'upload-head' }, [
                    h('span', {}, '上传 ' + uploads.tasks.filter(t => t.status === 'done').length
                        + '/' + uploads.tasks.length),
                    h(Button, { class: 'upload-close', Content: '✕', onClick: clearFinished })
                ]),
                h('div', { class: 'upload-list' }, uploads.tasks.map(t => h('div', { class: 'upload-item' }, [
                    h('div', { class: 'upload-name' }, t.name),
                    h('div', { class: 'upload-bar' }, [
                        h('i', { style: 'width:' + t.percent + '%' })
                    ]),
                    h('div', { class: 'upload-meta' }, [
                        h('span', {}, t.percent + '%'),
                        h('span', {}, t.status === 'uploading' || t.status === 'merging'
                            ? (formatSize(t.speed) + '/s · ' + t.message)
                            : t.message)
                    ])
                ])))
            ])
            : null;
    }
};

// ---------------------------------------------------------------- 弹层

export const ShareModal = {
    setup() {
        return () => state.showShares
            ? h('div', {
                class: 'modal-mask show win-theme-scope ' + (state.dark ? 'theme-dark' : 'theme-light'),
                onClick: (e) => { if (e.target === e.currentTarget) state.showShares = false; }
            }, [
                h('div', { class: 'modal-card' }, [
                    h('div', { class: 'modal-head' }, [
                        h('span', {}, '分享链接'),
                        h('button', { class: 'modal-close', onClick: () => { state.showShares = false; } }, '✕')
                    ]),
                    h('div', { class: 'modal-body' }, state.shares.length
                        ? state.shares.map(s => h('div', { class: 'share-row' }, [
                            h('div', { class: 'share-name' }, s.file_name || s.name || ''),
                            h('div', { class: 'share-meta' }, '下载 ' + (s.downloads || 0) + ' 次'),
                            h('div', { class: 'share-ops' }, [
                                h('button', {
                                    onClick: () => {
                                        const url = new URL('/s/' + s.token, location.origin).href;
                                        navigator.clipboard.writeText(url).then(() => toast('已复制'));
                                    }
                                }, '复制'),
                                h('button', {
                                    onClick: () => import('./store.js').then(m => m.revokeOne(s.token))
                                }, '撤销')
                            ])
                        ]))
                        : h('div', { class: 'empty-state' }, '还没有分享链接'))
                ])
            ])
            : null;
    }
};

function sliderRow(label, value, unit, min, max, onInput) {
    const safe = typeof value === 'number' ? value : 0;
    return h('div', { class: 'bg-slider-row' }, [
        h('label', {}, [
            label,
            h('span', { class: 'val' }, safe + unit)
        ]),
        h('input', {
            type: 'range',
            min: min,
            max: max,
            step: 1,
            value: safe,
            onInput: (e) => onInput(Number(e.target.value))
        })
    ]);
}

export const BackgroundModal = {
    setup() {
        return () => state.showBackground
            ? h('div', {
                class: 'modal-mask show win-theme-scope ' + (state.dark ? 'theme-dark' : 'theme-light'),
                onClick: (e) => { if (e.target === e.currentTarget) state.showBackground = false; }
            }, [
                h('div', { class: 'modal-card bg-card' }, [
                    h('div', { class: 'modal-head' }, [
                        h('span', {}, '个人背景'),
                        h('button', { class: 'modal-close', onClick: () => { state.showBackground = false; } }, '✕')
                    ]),
                    h('div', { class: 'modal-body' }, [
                        h('p', { class: 'bg-tip' }, '上传一张图片作为你的页面背景。这张背景只对你自己可见，其他账号看不到。'),
                        h('div', { class: 'bg-actions' }, [
                            h(Button, {
                                Style: 'AccentButtonStyle',
                                Content: '选择图片',
                                MinHeight: 32,
                                onClick: () => document.getElementById('bg-input').click()
                            }),
                            h(Button, {
                                Content: '恢复默认',
                                MinHeight: 32,
                                onClick: () => import('./store.js').then(m => m.clearBackgroundAction())
                            })
                        ]),

                        // 背景不透明度
                        sliderRow('背景不透明度', state.bgOpacity, '%', 0, 100,
                            (v) => setOpacity(v, state.panelOpacity)),

                        // 背景模糊
                        sliderRow('背景模糊', state.blurBg, 'px', 0, 30,
                            (v) => setBlur(state.blurPanel, v)),

                        // 主界面容器不透明度
                        sliderRow('主界面容器不透明度', state.panelOpacity, '%', 0, 100,
                            (v) => setOpacity(state.bgOpacity, v)),

                        // 文件区域模糊
                        sliderRow('文件区域模糊', state.blurPanel, 'px', 0, 40,
                            (v) => setBlur(v, state.blurBg))
                    ])
                ])
            ])
            : null;
    }
};

export const ToastBar = {
    setup() {
        return () => state.toast.show
            ? h('div', { class: 'toast-bar ' + state.toast.kind }, state.toast.text)
            : null;
    }
};

export { WinIcon as Icon };
