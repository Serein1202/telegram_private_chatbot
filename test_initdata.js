// 本地测试：验证 validateTelegramInitData 的 HMAC 算法是否与 Telegram 官方算法一致
// 方法：按官方算法自己构造一份"合法"的 initData，看被测函数能否校验通过
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/worker.js', 'utf8')
    .replace('export default', 'module.__fetch_handler =');

const sandbox = {
    console,
    module: { exports: {} },
    crypto: require('crypto').webcrypto,
    TextEncoder,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    FormData,
    fetch: async () => { throw new Error('no network in test'); },
    Map,
    Uint8Array,
    Uint32Array
};
vm.createContext(sandbox);
vm.runInContext(src + '\nmodule.exports = { validateTelegramInitData };', sandbox, { filename: 'worker.js' });

const { validateTelegramInitData } = sandbox.module.exports;

const BOT_TOKEN = '1234567:AAH_farDBOT-fake-token-for-test';
const USER_ID = 987654321;

// ---- 按 Telegram 官方算法计算 hash ----
async function officialHash(fields) {
    const enc = new TextEncoder();
    const dcs = Object.entries(fields)
        .filter(([k]) => k !== 'hash')
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join('\n');
    const botKey = await crypto.subtle.importKey('raw', enc.encode(BOT_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', botKey, enc.encode('WebAppData'));
    const secretKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const calc = await crypto.subtle.sign('HMAC', secretKey, enc.encode(dcs));
    return [...new Uint8Array(calc)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function buildInitData(over = {}) {
    const user = { id: USER_ID, first_name: '测试用户·小明', last_name: '', username: 'xiaoming_test', language_code: 'zh-hans', allows_write_to_pm: true };
    const fields = {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: 'AAF' + 'x'.repeat(20),
        signature: 'sig-placeholder',
        user: JSON.stringify(user),
        ...over
    };
    fields.hash = await officialHash(fields);
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) sp.append(k, v);
    return sp.toString();
}

(async () => {
    const env = { BOT_TOKEN };
    let failures = 0;
    const check = (label, expectOk, result) => {
        const pass = result.ok === expectOk;
        if (!pass) failures++;
        console.log(`[${label}] => ok=${result.ok} reason=${result.reason || '-'} detail=${result.detail || '-'} ${pass ? '✅' : '❌ FAIL'}`);
    };

    check('合法 initData（应通过）', true, await validateTelegramInitData(env, await buildInitData(), USER_ID));

    const tamperedUser = JSON.stringify({ id: 111111111, first_name: '冒名者' });
    check('篡改 user.id（应拒绝）', false, await validateTelegramInitData(env, await buildInitData({ user: tamperedUser }), USER_ID));

    check('错误 BOT_TOKEN（应拒绝）', false, await validateTelegramInitData({ BOT_TOKEN: '999:WRONG' }, await buildInitData(), USER_ID));

    const stale = await buildInitData({ auth_date: String(Math.floor(Date.now() / 1000) - 7200) });
    check('2小时前签名（应拒绝）', false, await validateTelegramInitData(env, stale, USER_ID));

    check('中文+特殊字符用户名（应通过）', true, await validateTelegramInitData(env, await buildInitData({ user: JSON.stringify({ id: USER_ID, first_name: '中文名 + 特殊&符号=测试' }) }), USER_ID));

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
    process.exit(failures === 0 ? 0 : 1);
})();
