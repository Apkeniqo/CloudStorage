// 后端 API 封装：统一 JSON 处理与错误提示

async function request(url, options) {
    const opts = options || {};
    const res = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        ...opts
    });

    const text = await res.text();
    let data = null;
    if (text) {
        try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    }

    if (!res.ok) {
        const err = new Error((data && data.message) || ('HTTP ' + res.status));
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

export function getJSON(url) {
    return request(url, { method: 'GET' });
}

export function postJSON(url, body) {
    return request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
    });
}

export function getList(path) {
    return getJSON('/api/list?path=' + encodeURIComponent(path || ''));
}

export function getRecent() {
    return getJSON('/api/recent');
}

export function getTrash() {
    return getJSON('/api/trash');
}

export function getVersion() {
    return getJSON('/api/version');
}

export function getMe() {
    return getJSON('/auth/me');
}

export function deletePath(path) {
    return postJSON('/files/delete', { path: path });
}

export function renamePath(path, newName) {
    return postJSON('/files/rename', { path: path, newName: newName });
}

export function createFolder(path, name) {
    return postJSON('/folders/create', { path: path, name: name });
}

export function copyPaths(paths, targetPath) {
    return postJSON('/files/copy', { paths: paths, targetPath: targetPath });
}

export function movePaths(paths, targetPath) {
    return postJSON('/files/move', { paths: paths, targetPath: targetPath });
}

export function setHidden(path, hidden) {
    return postJSON('/files/hide', { path: path, hidden: hidden });
}

export function restoreTrash(trash) {
    return postJSON('/trash/restore', { trash: trash });
}

export function purgeTrash(trash) {
    return postJSON('/trash/purge', { trash: trash });
}

export function emptyTrash() {
    return postJSON('/trash/empty', {});
}

export function listShares() {
    return getJSON('/api/shares');
}

export function createShare(path) {
    return postJSON('/api/shares', { name: path });
}

export function revokeShare(token) {
    return postJSON('/api/shares/revoke', { token: token });
}

export function saveBackground(file) {
    const fd = new FormData();
    fd.append('file', file);
    return request('/prefs/background', { method: 'POST', body: fd });
}

export function clearBackground() {
    return postJSON('/prefs/background/clear', {});
}

export function saveBlur(panel, bg) {
    return postJSON('/prefs/blur', { panel: panel, bg: bg });
}

export function setPassword(oldPw, newPw) {
    return postJSON('/admin/password', { old: oldPw, new: newPw });
}
