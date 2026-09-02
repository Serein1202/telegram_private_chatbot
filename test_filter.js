// 冒烟测试：验证内容过滤规则打分逻辑（提取 worker.js 内部函数）
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
vm.runInContext(src + '\nmodule.exports = { analyzeContentSignals, filterMessage, CONFIG, isTurnstileEnabled };', sandbox, { filename: 'worker.js' });

const { analyzeContentSignals, filterMessage, CONFIG, isTurnstileEnabled } = sandbox.module.exports;

const cases = [
    ['纯正常消息', { text: '你好，我想咨询一下你们的售后流程' }],
    ['正常带链接', { text: '你好，这个问题我之前在 https://example.com/a 看到过说明' }],
    ['刷单广告', { text: '宝妈兼职刷单返利，动动手指日入300，加微信 abc12345 详聊' }],
    ['赌博引流', { text: '澳门威尼斯人博彩开户存送，秒到账 t.me/xxx88' }],
    ['t.me 引流', { text: '想看更多资源，进群 t.me/spam_group' }],
    ['留手机号', { text: '有事打我电话 13812345678' }],
    ['表情刷屏', { text: '🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉 优惠大促' }],
];

(async () => {
    console.log('阈值: block>=' + CONFIG.FILTER_BLOCK_SCORE + ', gray>=' + CONFIG.FILTER_GRAY_SCORE, '\n');
    for (const [name, msg] of cases) {
        const s = analyzeContentSignals(msg);
        const f = await filterMessage(msg, {}); // 无 AI 绑定 → 灰区走 flag
        console.log(`[${name}] 评分=${s.score}  判定=${f.action}`);
        if (s.reasons.length) console.log('   特征:', s.reasons.join('、'));
    }
    console.log('\nTurnstile 开关(空env):', isTurnstileEnabled({}));
})();
