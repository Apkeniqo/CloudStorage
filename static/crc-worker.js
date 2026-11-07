/* 切片 CRC32 计算（放在 Worker 里，避免大文件上传时阻塞页面主线程） */

const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
})();

self.onmessage = async (e) => {
    const { id, blob } = e.data || {};
    try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) {
            crc = (crc >>> 8) ^ TABLE[(crc ^ bytes[i]) & 0xFF];
        }
        crc = (crc ^ 0xFFFFFFFF) >>> 0;
        self.postMessage({ id, crc: crc.toString(16).padStart(8, '0') });
    } catch (err) {
        self.postMessage({ id, error: String(err) });
    }
};

