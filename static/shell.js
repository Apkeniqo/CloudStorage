// WinUI 外壳：用 winuionweb 组件渲染侧边栏与工具栏
// 通过 window.WinUIShell 暴露状态桥接，供 App.js 同步。

import { createApp, h, ref } from 'vue';
import WinUIOnWeb, { Button, TextBlock, TextBox } from 'winuionweb';

const ICONS = {
    folderPlus: 'M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z',
    list: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
    grid: 'M4 11h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1zm10 0h6a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1zM4 21h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1zm10 0h6a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    cut: 'M9.64 7.64a3 3 0 1 0-1.41 1.41L10.59 12l-2.36 2.36a3 3 0 1 0 1.41 1.41L12 13.41l7.59 7.59L21 19.59 13.41 12 21 4.41 19.59 3 12 10.59 9.64 7.64zM6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 12a2 2 0 1 1 0 4 2 2 0 0 1 0-4z',
    paste: 'M19 2h-4.18C14.4.84 13.3 0 12 0S9.6.84 9.18 2H5c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm7 18H5V4h2v3h10V4h2v16z',
    sun: 'M12 7c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5zM2 13h2c.55 0 1-.45 1-1s-.45-1-1-1H2c-.55 0-1 .45-1 1s.45 1 1 1zm18 0h2c.55 0 1-.45 1-1s-.45-1-1-1h-2c-.55 0-1 .45-1 1s.45 1 1 1zM11 2v2c0 .55.45 1 1 1s1-.45 1-1V2c0-.55-.45-1-1-1s-1 .45-1 1zm0 18v2c0 .55.45 1 1 1s1-.45 1-1v-2c0-.55-.45-1-1-1s-1 .45-1 1z',
    moon: 'M12.3 2a10 10 0 0 0-1.9 20 10 10 0 0 0 9.8-7.7 1 1 0 0 0-1.2-1.2 8 8 0 1 1-6.7-11.1 1 1 0 0 0 0-2z',
    upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
    trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    more: 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
    search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    cloud: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM19 18H6c-2.21 0-4-1.79-4-4 0-2.05 1.53-3.76 3.56-3.97l1.07-.11.5-.95C8.08 7.14 9.94 6 12 6c2.62 0 4.88 1.86 5.39 4.43l.3 1.5 1.53.11c1.56.1 2.78 1.41 2.78 2.96 0 1.65-1.35 3-3 3z',
    files: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    admin: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.07.63-.07.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
    background: 'M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z',
    logout: 'M10 17l1.41-1.41L8.83 13H20v-2H8.83l2.58-2.59L10 7l-5 5 5 5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z'
};

function glyph(name, size) {
    const s = size || 18;
    return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'currentColor',
        'aria-hidden': 'true', style: 'pointer-events:none;flex:none'
    }, [h('path', { d: ICONS[name] || '' })]);
}

const state = {
    view: ref('list'),
    dark: ref(false),
    trash: ref(false),
    hasSelection: ref(false),
    hasClipboard: ref(false),
    search: ref(''),
    activeNav: ref('files'),
    storageText: ref('统计中…'),
    storageTitle: ref(''),
    storagePercent: ref(0),
    username: ref('我的云盘'),
    isAdmin: ref(false)
};

function call(fn, ...args) {
    const f = window[fn];
    if (typeof f === 'function') return f(...args);
    return undefined;
}

function iconButton(props, iconName, onClick, enabled) {
    const isEnabled = enabled !== false;
    return h(Button, {
        Background: 'transparent',
        BorderBrush: 'transparent',
        BorderThickness: 0,
        Padding: 6,
        MinWidth: 36,
        MinHeight: 32,
        Width: 40,
        Height: 32,
        ...props,
        IsEnabled: true,
        class: 'winui-icon-btn ' + (isEnabled ? '' : 'winui-disabled ') + (props.class || ''),
        onClick: (e) => { if (isEnabled) onClick(e); },
        Content: null
    }, { default: () => glyph(iconName, props.iconSize) });
}

const Toolbar = {
    name: 'WinUIToolbar',
    setup() {
        return () => h('div', {
            class: 'win-theme-scope ' + (state.dark.value ? 'theme-dark' : 'theme-light'),
            style: 'display:contents'
        }, [
            h('div', { class: 'toolbar-extra', id: 'toolbar-extra' }, [
                iconButton({ id: 'new-folder-btn', title: '新建文件夹' }, 'folderPlus',
                    () => call('createFolder'), !state.trash.value),
                iconButton({
                    id: 'view-toggle',
                    title: state.view.value === 'list' ? '切换到图标视图' : '切换到列表视图'
                }, state.view.value === 'list' ? 'grid' : 'list', () => call('toggleViewMode')),
                iconButton({ id: 'copy-btn', title: '复制' }, 'copy',
                    () => call('copySelection', 'copy'),
                    state.hasSelection.value && !state.trash.value),
                iconButton({ id: 'cut-btn', title: '剪切' }, 'cut',
                    () => call('copySelection', 'cut'),
                    state.hasSelection.value && !state.trash.value),
                iconButton({ id: 'paste-btn', title: '粘贴' }, 'paste',
                    () => call('pasteSelection'),
                    state.hasClipboard.value && !state.trash.value),
                iconButton({ id: 'theme-btn', title: '切换主题' },
                    state.dark.value ? 'sun' : 'moon', () => call('toggleTheme'))
            ]),

            iconButton({ id: 'search-icon-btn', title: '搜索', class: 'search-icon-btn' },
                'search', () => call('focusSearch')),

            h(Button, {
                Style: 'AccentButtonStyle',
                Content: '上传',
                class: 'winui-upload-btn',
                IsEnabled: !state.trash.value,
                onClick: () => {
                    const input = document.getElementById('file-input');
                    if (input) input.click();
                }
            }),

            h(Button, {
                id: 'trash-clear-btn',
                class: 'trash-only winui-icon-btn',
                title: '清空回收站',
                IsEnabled: state.trash.value,
                onClick: () => call('emptyTrash')
            }, { default: () => glyph('trash') }),

            iconButton({ id: 'more-btn', class: 'mobile-more', title: '更多功能' },
                'more', (e) => call('toggleMoreMenu', e))
        ]);
    }
};

function navButton(nav, icon, label) {
    const active = state.activeNav.value === nav;
    return h(Button, {
        class: 'side-item' + (active ? ' active' : ''),
        'data-nav': nav,
        Content: null,
        Background: 'transparent',
        BorderThickness: 0,
        HorizontalContentAlignment: 'Left',
        Padding: '0 12px',
        MinHeight: 36,
        Height: 36,
        onClick: () => call('navTo', nav)
    }, () => h('span', { class: 'side-item-inner' }, [
        h('span', { class: 'side-item-icon' }, [glyph(icon, 18)]),
        h('span', { class: 'side-item-label' }, label)
    ]));
}

const Sidebar = {
    name: 'WinUISidebar',
    setup() {
        return () => h('div', {
            class: 'win-theme-scope ' + (state.dark.value ? 'theme-dark' : 'theme-light'),
            style: 'display:contents'
        }, [
            // 品牌
            h('div', { class: 'brand' }, [
                glyph('cloud', 22),
                h(TextBlock, { Text: state.username.value, class: 'brand-name' })
            ]),

            // 搜索
            h('div', { class: 'side-search' }, [
                h(TextBox, {
                    PlaceholderText: '搜索',
                    Text: state.search.value,
                    'onUpdate:Text': (v) => {
                        state.search.value = v;
                        call('handleSearch', v);
                    },
                    onKeydown: (e) => { if (e.key === 'Enter') call('handleSearch', state.search.value); }
                })
            ]),

            // 导航
            h('nav', { class: 'side-nav', id: 'side-nav' }, [
                navButton('home', 'home', '主页'),
                navButton('files', 'files', '我的文件'),
                navButton('trash', 'trash', '回收站'),
                state.isAdmin.value ? navButton('admin', 'admin', '管理后台') : null
            ]),

            // 存储
            h('div', { class: 'side-bottom' }, [
                h('div', { class: 'side-storage' }, [
                    h('div', { class: 'side-storage-title' }, '存储'),
                    h('div', { class: 'side-storage-bar' }, [
                        h('i', { style: 'width:' + state.storagePercent.value + '%' })
                    ]),
                    h('div', { class: 'side-storage-text', title: state.storageTitle.value },
                        state.storageText.value)
                ]),
                h(Button, {
                    class: 'side-item side-action',
                    Content: null,
                    Background: 'transparent',
                    BorderThickness: 0,
                    HorizontalContentAlignment: 'Left',
                    Padding: '0 12px',
                    MinHeight: 36,
                    Height: 36,
                    onClick: () => call('openBackground')
                }, () => h('span', { class: 'side-item-inner' }, [
                    h('span', { class: 'side-item-icon' }, [glyph('background', 18)]),
                    h('span', { class: 'side-item-label' }, '背景')
                ])),
                h(Button, {
                    class: 'side-item side-action',
                    Content: null,
                    Background: 'transparent',
                    BorderThickness: 0,
                    HorizontalContentAlignment: 'Left',
                    Padding: '0 12px',
                    MinHeight: 36,
                    Height: 36,
                    onClick: () => { window.location.href = '/logout'; }
                }, () => h('span', { class: 'side-item-inner' }, [
                    h('span', { class: 'side-item-icon' }, [glyph('logout', 18)]),
                    h('span', { class: 'side-item-label' }, '退出登录')
                ]))
            ])
        ]);
    }
};

function bootData() {
    const body = document.body;
    state.username.value = body.getAttribute('data-username') || '我的云盘';
    state.isAdmin.value = body.getAttribute('data-admin') === '1';
}

function mountOne(id, comp) {
    const host = document.getElementById(id);
    if (!host) return null;
    const app = createApp(comp);
    if (WinUIOnWeb) app.use(WinUIOnWeb, { locale: 'zh-CN' });
    app.mount(host);
    return app;
}

function mount() {
    bootData();
    mountOne('winui-sidebar', Sidebar);
    mountOne('winui-toolbar', Toolbar);

    window.WinUIShell = {
        setViewMode(mode) { state.view.value = mode; },
        setTheme(isDark) { state.dark.value = !!isDark; },
        setTrashMode(isTrash) { state.trash.value = !!isTrash; },
        setActiveNav(nav) { state.activeNav.value = nav; },
        setClipboard(opts) {
            const o = opts || {};
            state.hasSelection.value = !!o.hasSel;
            state.hasClipboard.value = !!o.hasClip;
        },
        setStorage(info) {
            const i = info || {};
            state.storageText.value = i.text || '';
            state.storageTitle.value = i.title || '';
            state.storagePercent.value = typeof i.percent === 'number' ? i.percent : 0;
        },
        getSearch() { return state.search.value; },
        setSearch(v) { state.search.value = v == null ? '' : String(v); },
        focusSearch() {
            const host = document.getElementById('winui-sidebar');
            const input = host && host.querySelector('input');
            if (input) { input.focus(); input.select && input.select(); }
        }
    };

    if (typeof window.syncShell === 'function') window.syncShell();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
