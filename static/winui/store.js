// 应用状态与业务动作（全部响应式，无 DOM 操作）

import { reactive, computed } from 'vue';
import * as api from './api.js';

const LS = {
    theme: 'fluent_theme',
    view: 'fluent_view',
    sort: 'fluent_sort'
};

export const state = reactive({
    // 账号
    username: '',
    role: '',
    isAdmin: false,
    isGuest: false,
    ready: false,

    // 导航
    view: 'files',              // home | files | trash | admin
    path: '',
    crumbs: [{ name: '主页', path: '' }],

    // 数据
    items: [],
    loading: false,
    error: '',

    // 交互
    search: '',
    sortBy: localStorage.getItem(LS.sort) || 'mtime-desc',
    viewMode: localStorage.getItem(LS.view) || 'list',
    selected: [],               // 选中的相对路径数组

    // 剪贴板
    clipboard: { mode: '', paths: [] },

    // 外观
    theme: localStorage.getItem(LS.theme) || 'system',
    dark: false,
    hasBackground: false,
    blurPanel: 24,
    blurBg: 0,

    // 存储信息
    storage: { text: '', title: '', percent: 0 },
    version: '',

    // 后台 iframe 是否已加载过（避免每次切换都重建导致白闪）
    adminOpened: false,

    // 弹层
    showShares: false,
    shares: [],
    showBackground: false,

    // 提示
    toast: { show: false, text: '', kind: 'info' }
});

let toastTimer = null;
export function toast(text, kind) {
    state.toast = { show: true, text: text, kind: kind || 'info' };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { state.toast.show = false; }, 3200);
}

// ---------------------------------------------------------------- 派生数据

export const visibleFiles = computed(() => {
    let list = state.items.slice();
    const q = state.search.trim().toLowerCase();
    if (q) {
        list = list.filter(f => (f.name || '').toLowerCase().includes(q));
    }
    const dir = state.sortBy.endsWith('-desc') ? -1 : 1;
    const key = state.sortBy.split('-')[0];
    list.sort((a, b) => {
        if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        if (key === 'name') return a.name.localeCompare(b.name, 'zh-CN') * dir;
        if (key === 'size') return ((a.size || 0) - (b.size || 0)) * dir;
        return ((a.mtime || 0) - (b.mtime || 0)) * dir;
    });
    return list;
});

export const selectedCount = computed(() => state.selected.length);
export const allSelected = computed(() =>
    visibleFiles.value.length > 0 && state.selected.length >= visibleFiles.value.length);

// ---------------------------------------------------------------- 主题

export function applyTheme() {
    const saved = state.theme;
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = saved === 'dark' || (saved === 'system' && sysDark);
    state.dark = dark;
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.documentElement.classList.add('theme-switching');
    void document.documentElement.offsetWidth;
    requestAnimationFrame(() => {
        document.documentElement.classList.remove('theme-switching');
    });
}

export function toggleTheme() {
    if (state.theme === 'dark') state.theme = 'light';
    else if (state.theme === 'light') state.theme = 'dark';
    else state.theme = state.dark ? 'light' : 'dark';
    localStorage.setItem(LS.theme, state.theme);
    applyTheme();
}

// ---------------------------------------------------------------- 列表加载

function setItems(items, crumbs, path) {
    state.items = items || [];
    if (crumbs) state.crumbs = crumbs;
    if (typeof path === 'string') state.path = path;
    state.selected = state.selected.filter(p => state.items.some(f => (f.path || f.name) === p));
}

export async function loadFiles(path) {
    state.loading = true;
    state.error = '';
    try {
        const data = await api.getList(path || '');
        state.view = 'files';
        setItems(data.items, data.breadcrumb, data.path || '');
    } catch (e) {
        state.error = e.message || '加载失败';
    } finally {
        state.loading = false;
    }
}

export async function loadRecent() {
    state.loading = true;
    state.error = '';
    try {
        const data = await api.getRecent();
        state.view = 'home';
        setItems(data.items, [{ name: '主页', path: '' }], '');
    } catch (e) {
        state.error = e.message || '加载失败';
    } finally {
        state.loading = false;
    }
}

export async function loadTrash() {
    state.loading = true;
    state.error = '';
    try {
        const data = await api.getTrash();
        state.view = 'trash';
        state.path = '';
        state.crumbs = [{ name: '回收站', path: '' }];
        state.items = (data.items || []).map(it => ({
            name: it.name,
            path: it.trash,
            original: it.original,
            is_dir: !!it.is_dir,
            size: it.size || 0,
            mtime: it.mtime,
            is_trash: true
        }));
        state.selected = [];
    } catch (e) {
        state.error = e.message || '加载失败';
    } finally {
        state.loading = false;
    }
}

// 导航：先立刻切换视图状态（给出即时反馈），再去拉数据
export function navTo(view) {
    state.search = '';
    state.selected = [];
    state.error = '';
    state.items = [];      // 立即清空，让界面明确显示「正在加载」

    if (view === 'home') {
        state.view = 'home';
        state.path = '';
        state.crumbs = [{ name: '主页', path: '' }];
        return loadRecent();
    }
    if (view === 'trash') {
        state.view = 'trash';
        state.path = '';
        state.crumbs = [{ name: '回收站', path: '' }];
        return loadTrash();
    }
    if (view === 'admin') {
        state.view = 'admin';
        state.crumbs = [{ name: '管理后台', path: '' }];
        return Promise.resolve();
    }
    state.view = 'files';
    state.path = '';
    state.crumbs = [{ name: '主页', path: '' }];
    return loadFiles('');
}

export function navigateTo(path) {
    return loadFiles(path || '');
}

export function reload() {
    if (state.view === 'trash') return loadTrash();
    if (state.view === 'home') return loadRecent();
    return loadFiles(state.path);
}

// ---------------------------------------------------------------- 交互

export function setViewMode(mode) {
    state.viewMode = mode;
    localStorage.setItem(LS.view, mode);
}

export function toggleViewMode() {
    setViewMode(state.viewMode === 'list' ? 'grid' : 'list');
}

export function setSort(by) {
    const key = by;
    if (state.sortBy.startsWith(key + '-')) {
        state.sortBy = key + (state.sortBy.endsWith('asc') ? '-desc' : '-asc');
    } else {
        state.sortBy = key + '-asc';
    }
    localStorage.setItem(LS.sort, state.sortBy);
}

export function isSelected(path) {
    return state.selected.includes(path);
}

export function toggleSelect(path) {
    const i = state.selected.indexOf(path);
    if (i >= 0) state.selected.splice(i, 1);
    else state.selected.push(path);
}

export function selectAll(checked) {
    state.selected = checked ? visibleFiles.value.map(f => f.path || f.name) : [];
}

export function clearSelection() {
    state.selected = [];
}

export function setSearch(v) {
    state.search = v || '';
}

// ---------------------------------------------------------------- 文件操作

export async function createFolderAction(name) {
    await api.createFolder(state.path, name);
    await reload();
    toast('已创建文件夹');
}

export async function deleteOne(path) {
    await api.deletePath(path);
    toast('已移到回收站');
    await reload();
}

export async function deleteSelected() {
    const paths = state.selected.slice();
    if (!paths.length) return;
    const inTrash = state.view === 'trash';
    for (const p of paths) {
        try {
            if (inTrash) await api.purgeTrash(p);
            else await api.deletePath(p);
        } catch (e) { /* 单条失败继续 */ }
    }
    state.selected = [];
    await reload();
    toast(inTrash ? '已彻底删除' : '已移到回收站');
}

export async function renameAction(path, newName) {
    await api.renamePath(path, newName);
    await reload();
    toast('已重命名');
}

export async function copySelection(mode) {
    if (!state.selected.length) return;
    state.clipboard = { mode: mode, paths: state.selected.slice() };
    toast(mode === 'cut' ? '已剪切 ' + state.selected.length + ' 项' : '已复制 ' + state.selected.length + ' 项');
}

export async function pasteSelection() {
    const clip = state.clipboard;
    if (!clip.paths.length) return;
    if (clip.mode === 'cut') {
        await api.movePaths(clip.paths, state.path);
        state.clipboard = { mode: '', paths: [] };
        toast('已粘贴（移动）');
    } else {
        await api.copyPaths(clip.paths, state.path);
        toast('已粘贴（复制）');
    }
    await reload();
}

export async function toggleHidden(path, hidden) {
    await api.setHidden(path, hidden);
    await reload();
    toast(hidden ? '已隐藏（仅管理员可见）' : '已取消隐藏');
}

export async function restoreOne(trash) {
    await api.restoreTrash(trash);
    await reload();
    toast('已恢复');
}

export async function purgeOne(trash) {
    await api.purgeTrash(trash);
    await reload();
    toast('已彻底删除');
}

export async function emptyTrashAll() {
    await api.emptyTrash();
    await reload();
    toast('回收站已清空');
}

// ---------------------------------------------------------------- 分享

export async function openShares() {
    state.showShares = true;
    try {
        const data = await api.listShares();
        state.shares = data.shares || data.items || [];
    } catch (e) {
        state.shares = [];
    }
}

export async function shareOne(path) {
    const data = await api.createShare(path);
    if (data && data.url) {
        try { await navigator.clipboard.writeText(new URL(data.url, location.origin).href); } catch (e) {}
        toast('分享链接已复制');
    }
    await openShares();
}

export async function revokeOne(token) {
    await api.revokeShare(token);
    await openShares();
}

// ---------------------------------------------------------------- 外观

export function applyAppearance(me) {
    state.hasBackground = !!(me && me.background);
    state.blurPanel = (me && typeof me.blur_panel === 'number') ? me.blur_panel : 24;
    state.blurBg = (me && typeof me.blur_bg === 'number') ? me.blur_bg : 0;
    applyBackground(state.hasBackground);
    applyBlur(state.blurPanel, state.blurBg);
}

export function applyBackground(has) {
    document.body.classList.toggle('has-bg', !!has);
    if (has) {
        document.body.style.setProperty('--bg-image',
            "url('/prefs/background?v=" + Date.now() + "')");
    } else {
        document.body.style.removeProperty('--bg-image');
    }
}

export function applyBlur(panel, bg) {
    state.blurPanel = panel;
    state.blurBg = bg;
    document.documentElement.style.setProperty('--panel-blur', panel + 'px');
    document.documentElement.style.setProperty('--bg-blur', bg + 'px');
}

let blurTimer = null;
export function setBlur(panel, bg) {
    applyBlur(panel, bg);
    if (blurTimer) clearTimeout(blurTimer);
    blurTimer = setTimeout(() => { api.saveBlur(panel, bg).catch(() => {}); }, 400);
}

export async function uploadBackgroundFile(file) {
    await api.saveBackground(file);
    state.hasBackground = true;
    applyBackground(true);
    toast('背景已更新');
}

export async function clearBackgroundAction() {
    await api.clearBackground();
    state.hasBackground = false;
    applyBackground(false);
    toast('已恢复默认背景');
}

// ---------------------------------------------------------------- 初始化

export async function init() {
    applyTheme();
    try {
        const me = await api.getMe();
        if (me && me.authenticated) {
            state.username = me.username || '';
            state.role = me.role || '';
            state.isAdmin = me.role === 'admin';
            state.isGuest = me.role === 'guest';
            applyAppearance(me);
        }
    } catch (e) { /* 未登录时忽略 */ }

    refreshStorage();
    await loadFiles('');
    state.ready = true;
}

export async function refreshStorage() {
    try {
        const data = await api.getVersion();
        state.version = data.version || '';
        const info = data.storage || {};
        const used = typeof info.used === 'number' ? info.used : 0;
        const percent = typeof info.percent === 'number' ? info.percent : 0;
        let text = '已使用 ' + formatSize(used);
        let title = '';
        if (info.mode === 'quota') {
            text = '已用 ' + formatSize(used) + ' / ' + formatSize(info.limit || 0)
                + ' (' + Math.round(percent) + '%)';
            title = '剩余 ' + formatSize(info.remaining || 0);
        } else if (info.mode === 'disk') {
            text = '已用 ' + formatSize(used) + ' · 磁盘剩余 ' + formatSize(info.remaining || 0);
            title = '磁盘共 ' + formatSize(info.disk_total || 0) + '，剩余 ' + formatSize(info.remaining || 0);
        }
        state.storage = { text: text, title: title, percent: percent };
    } catch (e) { /* 忽略 */ }
}

// ---------------------------------------------------------------- 工具函数

export function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

export function formatTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate()
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
