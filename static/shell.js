// WinUI 外壳：用 winuionweb 组件渲染工具栏（以及其他可独立挂载的控件）
// 通过 window.WinUIShell 暴露桥接方法，供 App.js 同步状态。

import { createApp, h, ref } from 'vue';
import WinUIOnWeb, { Button } from 'winuionweb';

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
    search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z'
};

function glyph(name, size) {
    const s = size || 18;
    return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'currentColor',
        'aria-hidden': 'true', style: 'pointer-events:none'
    }, [h('path', { d: ICONS[name] || '' })]);
}

const state = {
    view: ref('list'),
    dark: ref(false),
    trash: ref(false),
    hasSelection: ref(false),
    hasClipboard: ref(false)
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
            // 桌面端工具组（移动端由 .toolbar-extra 收起为二级菜单）
            h('div', { class: 'toolbar-extra', id: 'toolbar-extra' }, [
                iconButton({
                    id: 'new-folder-btn',
                    title: '新建文件夹'
                }, 'folderPlus', () => call('createFolder'), !state.trash.value),

                iconButton({
                    id: 'view-toggle',
                    title: state.view.value === 'list' ? '切换到图标视图' : '切换到列表视图'
                }, state.view.value === 'list' ? 'grid' : 'list', () => call('toggleViewMode')),

                iconButton({
                    id: 'copy-btn',
                    title: '复制'
                }, 'copy', () => call('copySelection', 'copy'),
                   state.hasSelection.value && !state.trash.value),

                iconButton({
                    id: 'cut-btn',
                    title: '剪切'
                }, 'cut', () => call('copySelection', 'cut'),
                   state.hasSelection.value && !state.trash.value),

                iconButton({
                    id: 'paste-btn',
                    title: '粘贴'
                }, 'paste', () => call('pasteSelection'),
                   state.hasClipboard.value && !state.trash.value),

                iconButton({
                    id: 'theme-btn',
                    title: '切换主题'
                }, state.dark.value ? 'sun' : 'moon', () => call('toggleTheme'))
            ]),

            // 移动端搜索入口
            iconButton({
                id: 'search-icon-btn',
                title: '搜索',
                class: 'search-icon-btn'
            }, 'search', () => call('focusSearch')),

            // 上传（AccentButton）
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

            // 回收站：清空
            h(Button, {
                id: 'trash-clear-btn',
                class: 'trash-only winui-icon-btn',
                title: '清空回收站',
                Style: state.trash.value ? '' : 'SubtleButtonStyle',
                IsEnabled: state.trash.value,
                onClick: () => call('emptyTrash')
            }, { default: () => glyph('trash') }),

            // 移动端更多
            iconButton({
                id: 'more-btn',
                class: 'mobile-more',
                title: '更多功能'
            }, 'more', (e) => call('toggleMoreMenu', e))
        ]);
    }
};

function mount() {
    const host = document.getElementById('winui-toolbar');
    if (!host) return;
    const app = createApp(Toolbar);
    if (WinUIOnWeb) app.use(WinUIOnWeb, { locale: 'zh-CN' });
    app.mount(host);

    window.WinUIShell = {
        setViewMode(mode) { state.view.value = mode; },
        setTheme(isDark) { state.dark.value = !!isDark; },
        setTrashMode(isTrash) { state.trash.value = !!isTrash; },
        setClipboard(opts) {
            const o = opts || {};
            state.hasSelection.value = !!o.hasSel;
            state.hasClipboard.value = !!o.hasClip;
        }
    };

    if (typeof window.syncShell === 'function') window.syncShell();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
