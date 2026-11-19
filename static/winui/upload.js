// 上传：小文件直传 + 大文件分片（断点续传、CRC 校验、并发、合并轮询）

import { reactive } from 'vue';
import { formatSize, refreshStorage } from './store.js';

const MIN_CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;
const TARGET_CHUNK_COUNT = 128;
const MAX_CONCURRENT_UPLOADS = 4;
const LARGE_FILE_THRESHOLD = 200 * 1024 * 1024;
const FINGERPRINT_SLICE_SIZE = 256 * 1024;
const FINGERPRINT_SLICES = 4;

export const uploads = reactive({
    tasks: [],
    visible: false
});

let seq = 0;

// ---------------------------------------------------------------- CRC32

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();

const crcWorker = (() => {
    if (typeof Worker === 'undefined') return null;
    try {
        const worker = new Worker('/static/crc-worker.js');
        const pending = new Map();
        let id = 0;
        worker.onmessage = (e) => {
            const data = e.data || {};
            const task = pending.get(data.id);
            if (!task) return;
            pending.delete(data.id);
            if (data.error) task.reject(new Error(data.error));
            else task.resolve(data.crc);
        };
        worker.onerror = () => {
            pending.forEach(t => t.reject(new Error('worker error')));
            pending.clear();
        };
        return {
            compute(blob) {
                return new Promise((resolve, reject) => {
                    const msgId = ++id;
                    pending.set(msgId, { resolve, reject });
                    worker.postMessage({ id: msgId, blob });
                });
            }
        };
    } catch (e) {
        return null;
    }
})();

async function chunkCrc32(blob) {
    if (crcWorker) {
        try {
            return await crcWorker.compute(blob);
        } catch (e) { /* 退回主线程 */ }
    }
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

// ---------------------------------------------------------------- 指纹

function fnv1a32(bytes, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function readSlice(file, start, end) {
    return file.slice(start, end).arrayBuffer().then(buf => new Uint8Array(buf));
}

async function sampleFile(file) {
    const slices = [];
    if (file.size <= FINGERPRINT_SLICE_SIZE) {
        slices.push(await readSlice(file, 0, file.size));
        return slices;
    }
    const lastStart = file.size - FINGERPRINT_SLICE_SIZE;
    const step = lastStart / (FINGERPRINT_SLICES - 1);
    for (let i = 0; i < FINGERPRINT_SLICES; i++) {
        const start = i === FINGERPRINT_SLICES - 1 ? lastStart : Math.floor(step * i);
        slices.push(await readSlice(file, start, start + FINGERPRINT_SLICE_SIZE));
    }
    return slices;
}

export async function computeFileHash(file) {
    const slices = await sampleFile(file);
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
    return 'v2-' + hex(h1) + hex(h2);
}

// ---------------------------------------------------------------- 任务

function newTask(file) {
    // 必须用 reactive 包起来：任务对象会被 tick()/finish() 直接改字段，
    // 如果只是普通对象，Vue 追踪不到，面板上的速度和进度就不会自己刷新
    return reactive({
        id: 'up-' + (++seq),
        file: file,
        name: file.name,
        size: file.size,
        loaded: 0,
        percent: 0,
        speed: 0,
        status: 'waiting',       // waiting | hashing | uploading | merging | done | error | cancelled
        paused: false,
        message: '准备上传…',
        cancelled: false,
        xhrs: new Set(),
        startedAt: 0,
        lastTick: 0,
        lastLoaded: 0
    });
}

function tick(task) {
    if (task.paused) {
        task.speed = 0;
        return;
    }
    const now = performance.now();
    if (!task.lastTick) {
        task.lastTick = now;
        task.lastLoaded = task.loaded;
        return;
    }
    const dt = (now - task.lastTick) / 1000;
    if (dt >= 0.4) {
        const delta = task.loaded - task.lastLoaded;
        // loaded 会因为「暂停后重传」而回退，delta 为负时直接按 0 处理，避免显示负速度
        task.speed = delta > 0 ? delta / dt : 0;
        task.lastTick = now;
        task.lastLoaded = task.loaded;
    }
    task.percent = task.size ? Math.min(100, Math.round(task.loaded / task.size * 100)) : 0;
}

function finish(task, status, message) {
    task.status = status;
    if (message) task.message = message;
    task.percent = status === 'done' ? 100 : task.percent;
    task.speed = 0;
    refreshStorage();
}

// 暂停期间不发新分片，已经在传的那几片会传完
function waitWhilePaused(task) {
    if (!task.paused || task.cancelled) return Promise.resolve();
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (!task.paused || task.cancelled) {
                clearInterval(timer);
                resolve();
            }
        }, 200);
    });
}

export function pauseTask(id) {
    const task = uploads.tasks.find(t => t.id === id);
    if (!task) return;
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'error') return;
    task.paused = true;
    task.speed = 0;
    task.message = '已暂停';
    // 立刻中止在途分片，否则那几个几十 MB 的分片会继续传完，看起来像没暂停
    task.xhrs.forEach(xhr => {
        try { xhr.abort(); } catch (e) { /* 已结束 */ }
    });
    task.xhrs.clear();
}

export function resumeTask(id) {
    const task = uploads.tasks.find(t => t.id === id);
    if (!task || !task.paused) return;
    task.paused = false;
    task.message = '继续上传…';
    task.lastTick = 0;
    task.lastLoaded = task.loaded;
}

export function cancelTask(id) {
    const task = uploads.tasks.find(t => t.id === id);
    if (!task) return;
    task.cancelled = true;
    task.xhrs.forEach(xhr => { try { xhr.abort(); } catch (e) {} });
    task.xhrs.clear();
    if (task.status !== 'done') {
        task.status = 'cancelled';
        task.message = '已取消';
    }
}

export function cancelAll() {
    uploads.tasks.forEach(t => cancelTask(t.id));
}

export function clearFinished() {
    uploads.tasks = uploads.tasks.filter(t => t.status !== 'done');
}

// ---------------------------------------------------------------- 上传入口

export async function addFiles(fileList, targetPath) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    uploads.visible = true;

    for (const file of files) {
        const task = newTask(file);
        uploads.tasks.push(task);
        // 顺序执行，避免多个大文件同时抢带宽
        await runTask(task, targetPath || '');
    }
}

async function runTask(task, targetPath) {
    if (task.cancelled) return;

    // 预检剩余容量
    try {
        const res = await fetch('/api/version', { cache: 'no-store' });
        if (res.ok) {
            const data = await res.json();
            const remaining = data && data.storage && typeof data.storage.remaining === 'number'
                ? data.storage.remaining : -1;
            if (remaining >= 0 && task.size > remaining) {
                finish(task, 'error', '空间不足：需要 ' + formatSize(task.size)
                    + '，剩余 ' + formatSize(remaining));
                return;
            }
        }
    } catch (e) { /* 交给服务端拦截 */ }

    try {
        if (task.size < LARGE_FILE_THRESHOLD) {
            await uploadSingle(task, targetPath);
        } else {
            await uploadChunked(task, targetPath);
        }
    } catch (e) {
        if (task.cancelled) {
            finish(task, 'cancelled', '已取消');
        } else {
            finish(task, 'error', (e && e.message) || '上传失败');
        }
    }
}

// ---------------------------------------------------------------- 小文件：直传

function uploadSingle(task, targetPath) {
    return new Promise((resolve, reject) => {
        // 直传没有断点，暂停后只能从头重传；用 start() 包一层便于重入
        const start = () => {
            const xhr = new XMLHttpRequest();
            task.xhrs.add(xhr);
            task.status = 'uploading';
            task.message = '上传中…';
            task.lastTick = performance.now();
            task.lastLoaded = task.loaded;

            const fd = new FormData();
            fd.append('file', task.file);
            fd.append('path', targetPath || '');

            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return;
                task.loaded = Math.max(task.loaded, e.loaded);
                tick(task);
                task.message = '上传中 ' + task.percent + '%';
            };

            xhr.onload = () => {
                task.xhrs.delete(xhr);
                if (xhr.status === 200) {
                    finish(task, 'done', '已完成');
                    resolve();
                    return;
                }
                let msg = '上传失败（' + xhr.status + '）';
                try {
                    const info = JSON.parse(xhr.responseText || '{}');
                    if (info && info.message) msg = info.message;
                } catch (e) { /* 非 JSON */ }
                finish(task, 'error', msg);
                reject(new Error(msg));
            };

            xhr.onerror = () => {
                task.xhrs.delete(xhr);
                finish(task, 'error', '网络错误');
                reject(new Error('网络错误'));
            };

            xhr.onabort = () => {
                task.xhrs.delete(xhr);
                if (task.paused && !task.cancelled) {
                    // 暂停引起的中止：不算取消，等恢复后从头重传
                    task.loaded = 0;
                    task.percent = 0;
                    task.message = '已暂停';
                    waitWhilePaused(task).then(() => {
                        if (!task.cancelled) start();
                    });
                    return;
                }
                finish(task, 'cancelled', '已取消');
                resolve();
            };

            xhr.open('POST', '/upload', true);
            xhr.send(fd);
        };

        start();
    });
}

// ---------------------------------------------------------------- 大文件：分片

function pool(tasks, limit, worker, onProgress) {
    return new Promise((resolve, reject) => {
        let index = 0;
        let running = 0;
        let failed = null;

        function next() {
            if (failed) return;
            if (index >= tasks.length && running === 0) return resolve();
            while (running < limit && index < tasks.length) {
                const item = tasks[index++];
                running++;
                worker(item).then(() => {
                    running--;
                    onProgress && onProgress();
                    next();
                }).catch(err => {
                    running--;
                    if (!failed) { failed = err; reject(err); }
                });
            }
        }
        if (!tasks.length) return resolve();
        next();
    });
}

async function uploadChunked(task, targetPath) {
    task.status = 'hashing';
    task.message = '正在计算文件指纹…';

    const fileHash = await computeFileHash(task.file);
    if (task.cancelled) throw new Error('cancelled');

    const chunkSize = Math.min(MAX_CHUNK_SIZE,
        Math.max(MIN_CHUNK_SIZE, Math.ceil(task.size / TARGET_CHUNK_COUNT)));
    const totalChunks = Math.ceil(task.size / chunkSize);

    task.status = 'uploading';
    task.message = '检查已接收切片…';

    let uploadedChunks = [];
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch('/upload/check?fileHash=' + encodeURIComponent(fileHash),
            { signal: controller.signal });
        clearTimeout(timer);
        if (res.ok) {
            const data = await res.json();
            uploadedChunks = data.uploadedChunks || [];
            const info = data.storage || {};
            if (typeof info.remaining === 'number' && task.size > info.remaining) {
                throw new Error('剩余空间不足：需要 ' + formatSize(task.size)
                    + '，只剩 ' + formatSize(info.remaining));
            }
        }
    } catch (e) {
        if (e && e.message && e.message.includes('剩余空间')) throw e;
        uploadedChunks = [];
    }

    const chunkSizeOf = (i) => (i === totalChunks - 1)
        ? (task.size - i * chunkSize)
        : chunkSize;

    const pending = [];
    for (let i = 0; i < totalChunks; i++) {
        if (uploadedChunks.indexOf(i) === -1) pending.push(i);
    }

    let baseLoaded = 0;
    for (let i = 0; i < totalChunks; i++) {
        if (uploadedChunks.indexOf(i) !== -1) baseLoaded += chunkSizeOf(i);
    }
    task.loaded = baseLoaded;
    task.lastTick = performance.now();
    task.lastLoaded = baseLoaded;
    tick(task);

    task.message = pending.length
        ? '分块传输中（' + pending.length + '/' + totalChunks + ' 片）'
        : '秒传完成，正在合并…';

    const sendChunk = (chunkIndex) => new Promise((resolve, reject) => {
        const start = chunkIndex * chunkSize;
        const end = Math.min(task.size, start + chunkSize);
        const chunk = task.file.slice(start, end);
        let retry = 0;
        const maxRetry = 4;

        const attempt = async () => {
            await waitWhilePaused(task);
            if (task.cancelled) return reject(new Error('cancelled'));
            let crc = null;
            try { crc = await chunkCrc32(chunk); } catch (e) { crc = null; }

            const xhr = new XMLHttpRequest();
            task.xhrs.add(xhr);
            xhr.open('POST', '/upload/chunk', true);
            xhr.setRequestHeader('X-Upload-Mode', 'raw');
            xhr.setRequestHeader('X-File-Hash', fileHash);
            xhr.setRequestHeader('X-Chunk-Index', String(chunkIndex));
            xhr.setRequestHeader('X-File-Size', String(task.size));
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            if (crc) xhr.setRequestHeader('X-Chunk-Crc32', crc);

            xhr.upload.onprogress = (e) => {
                if (!e.lengthComputable) return;
                const extra = Math.round(chunk.size * (e.loaded / e.total));
                // 4 片并发时，某片完成会让 baseLoaded 跳增，而另一片的 progress
                // 回调可能还带着旧值，算出来的 loaded 会瞬时变小 -> 速度闪一下负数。
                // 用 max 保证 loaded 单调不减
                task.loaded = Math.max(task.loaded, Math.min(task.size, baseLoaded + extra));
                tick(task);
            };

            xhr.onload = () => {
                task.xhrs.delete(xhr);
                if (xhr.status === 200) {
                    baseLoaded += chunk.size;
                    task.loaded = Math.max(task.loaded, Math.min(task.size, baseLoaded));
                    tick(task);
                    resolve();
                    return;
                }
                let msg = '切片失败（' + xhr.status + '）';
                let quota = false;
                try {
                    const info = JSON.parse(xhr.responseText || '{}');
                    if (info && info.message) msg = info.message;
                    quota = !!(info && info.quota);
                } catch (e) { /* 非 JSON */ }
                if (quota || xhr.status === 413) return reject(new Error(msg));
                if (retry++ < maxRetry) {
                    setTimeout(attempt, 400 * retry);
                } else {
                    reject(new Error(msg));
                }
            };

            xhr.onerror = () => {
                task.xhrs.delete(xhr);
                if (task.cancelled) return reject(new Error('cancelled'));
                if (retry++ < maxRetry) setTimeout(attempt, 600 * retry);
                else reject(new Error('网络中断'));
            };

            xhr.onabort = () => {
                task.xhrs.delete(xhr);
                if (task.paused && !task.cancelled) {
                    // 暂停引起的中止：不要算失败，回到 attempt() 等暂停解除后重发这一片
                    attempt();
                    return;
                }
                reject(new Error('cancelled'));
            };

            xhr.send(chunk);
        };

        attempt();
    });

    await pool(pending, MAX_CONCURRENT_UPLOADS, sendChunk, () => {
        task.percent = task.size ? Math.min(100, Math.round(task.loaded / task.size * 100)) : 0;
    });

    if (task.cancelled) throw new Error('cancelled');

    // 合并
    task.status = 'merging';
    task.message = '合并分块…';
    const mergeRes = await fetch('/upload/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fileHash: fileHash,
            fileName: task.file.name,
            totalChunks: totalChunks,
            targetPath: targetPath || ''
        })
    });

    const mergeData = await mergeRes.json().catch(() => ({}));
    if (!mergeRes.ok) {
        throw new Error(mergeData.message || ('合并失败（' + mergeRes.status + '）'));
    }

    // 轮询合并状态
    const started = Date.now();
    while (Date.now() - started < 180000) {
        await new Promise(r => setTimeout(r, 800));
        if (task.cancelled) throw new Error('cancelled');
        const st = await fetch('/upload/merge_status?fileHash=' + encodeURIComponent(fileHash))
            .then(r => r.json()).catch(() => null);
        if (!st) continue;
        if (st.status === 'success') {
            finish(task, 'done', '已完成');
            return;
        }
        if (st.status === 'error') {
            throw new Error(st.message || '合并失败');
        }
        if (st.status === 'processing') {
            task.message = '后台合并中 ' + (st.progress || 0) + '%…';
        }
    }
    throw new Error('合并等待超时，请刷新页面确认结果');
}
