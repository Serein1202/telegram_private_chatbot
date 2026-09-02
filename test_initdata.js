// 复现 + 回归测试：validateTelegramInitData 必须正确处理含 signature 字段的 initData
// 真实场景：用户从 Telegram 直链（t.me/<bot>/<app>?startapp=...）启动 Mini App，
// 此时 initData 会带 signature 字段；Telegram 官方算法规定该字段必须从 data-check-string 中排除
const webcrypto = require('crypto').webcrypto;
const { createHmac } = require('crypto');

const BOT_TOKEN = 'TEST_BOT_TOKEN_123456789:ABCdef';
const USER_ID = 987654321;
const AUTH_DATE = Math.floor(Date.now() / 1000);
const QUERY_ID = 'AAHdF6IQAAAAAN0XohwDNM5A';

function buildInitData(includeSignature) {
    const userJson = JSON.stringify({ id: USER_ID, first_name: 'Test', username: 'tester' });
    const params = new URLSearchParams();
    params.set('user', userJson);
    params.set('query_id', QUERY_ID);
    params.set('auth_date', String(AUTH_DATE));
    // 按 Telegram 文档：data_check_string 排除 hash 和 signature
    const dataCheckString = [...params.entries()]
        .sort(([a],[b]) => a.localeCompare(b))
        .map(([k,v]) => `${k}=${v}`).join('\n');
    const secretKey = createHmac('sha256', BOT_TOKEN).update('WebAppData').digest();
    const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    params.set('hash', hash);
    if (includeSignature) {
        // signature 字段由 Telegram 服务端用 bot 公钥 ed25519 签名，客户端拿不到私钥
        // 这里只用作占位以触发 bug，不参与 HMAC 计算
        params.set('signature', 'FAKE_SIG_FOR_TEST_ONLY_abcdef1234567890');
    }
    return params.toString();
}

// 抽取 worker.js 里的函数（保持和部署版本一致）
async function validateCurrent(initData, expectedUserId) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!hash || !authDate) return { ok: false, reason: 'no_hash' };
    if (Math.floor(Date.now() / 1000) - authDate > 86400) return { ok: false, reason: 'expired' };
    const userRaw = params.get('user');
    if (userRaw) { const u = JSON.parse(userRaw); if (Number(u.id) !== Number(expectedUserId)) return { ok: false, reason: 'user_mismatch' }; }
    const dataCheckString = [...params.entries()]
        .filter(([k]) => k !== 'hash')
        .map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const enc = new TextEncoder();
    const botKey = await webcrypto.subtle.importKey('raw', enc.encode(BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secretBuf = await webcrypto.subtle.sign('HMAC', botKey, enc.encode('WebAppData'));
    const secretKey = await webcrypto.subtle.importKey('raw', secretBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const calcBuf = await webcrypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
    const calc = [...new Uint8Array(calcBuf)].map(b => b.toString(16).padStart(2,'0')).join('');
    return calc === hash ? { ok: true } : { ok: false, reason: 'hmac_mismatch' };
}

// 修复后版本：使用 URLSearchParams.delete('signature')
async function validateFixed(initData, expectedUserId) {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!hash || !authDate) return { ok: false, reason: 'no_hash' };
    if (Math.floor(Date.now() / 1000) - authDate > 86400) return { ok: false, reason: 'expired' };
    const userRaw = params.get('user');
    if (userRaw) { const u = JSON.parse(userRaw); if (Number(u.id) !== Number(expectedUserId)) return { ok: false, reason: 'user_mismatch' }; }
    params.delete('hash');
    params.delete('signature'); // 修复：从 data-check-string 中排除 signature
    const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
    const enc = new TextEncoder();
    const botKey = await webcrypto.subtle.importKey('raw', enc.encode(BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secretBuf = await webcrypto.subtle.sign('HMAC', botKey, enc.encode('WebAppData'));
    const secretKey = await webcrypto.subtle.importKey('raw', secretBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const calcBuf = await webcrypto.subtle.sign('HMAC', secretKey, enc.encode(dataCheckString));
    const calc = [...new Uint8Array(calcBuf)].map(b => b.toString(16).padStart(2,'0')).join('');
    return calc === hash ? { ok: true } : { ok: false, reason: 'hmac_mismatch' };
}

(async () => {
    const noSig = buildInitData(false);
    const withSig = buildInitData(true);
    console.log('--- 不含 signature 字段 ---');
    console.log('current:', await validateCurrent(noSig, USER_ID));
    console.log('fixed  :', await validateFixed(noSig, USER_ID));
    console.log('--- 含 signature 字段（用户报错的场景）---');
    console.log('current:', await validateCurrent(withSig, USER_ID));   // 预期 hmac_mismatch
    console.log('fixed  :', await validateFixed(withSig, USER_ID));     // 预期 ok
})();
