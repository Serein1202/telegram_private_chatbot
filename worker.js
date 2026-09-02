// Cloudflare Worker：Telegram 双向机器人 v5.4（Turnstile 人机验证 + 智能内容过滤）

// --- 配置常量 ---
const CONFIG = {
    VERIFY_ID_LENGTH: 12,
    VERIFY_EXPIRE_SECONDS: 300,         // 5分钟
    VERIFIED_EXPIRE_SECONDS: 2592000,   // 30天
    MEDIA_GROUP_EXPIRE_SECONDS: 60,
    MEDIA_GROUP_DELAY_MS: 3000,         // 3秒（从2秒增加）
    PENDING_MAX_MESSAGES: 10,           // 验证期间最多暂存的消息数
    ADMIN_CACHE_TTL_SECONDS: 300,       // 管理员权限缓存 5 分钟
    NEEDS_REVERIFY_TTL_SECONDS: 600,    // 标记需重新验证的 TTL（用于并发兜底）
    RATE_LIMIT_MESSAGE: 45,
    RATE_LIMIT_VERIFY: 3,
    RATE_LIMIT_WINDOW: 60,
    BUTTON_COLUMNS: 2,
    MAX_TITLE_LENGTH: 128,
    MAX_NAME_LENGTH: 30,
    API_TIMEOUT_MS: 10000,
    CLEANUP_BATCH_SIZE: 10,
    MAX_CLEANUP_DISPLAY: 20,
    CLEANUP_LOCK_TTL_SECONDS: 1800,     // /cleanup 防并发锁 30 分钟
    MAX_RETRY_ATTEMPTS: 3,
    THREAD_HEALTH_TTL_MS: 60000,
    // ---- Turnstile 人机验证 ----
    TURNSTILE_LINK_TTL_SECONDS: 300,     // 验证链接有效期 5 分钟
    TURNSTILE_INITDATA_MAX_AGE: 3600,    // initData 签名最大时效 1 小时
    // ---- 智能内容过滤 ----
    FILTER_BLOCK_SCORE: 60,             // 规则评分达到该值直接拦截
    FILTER_GRAY_SCORE: 20,               // 达到该值进入灰区，交给 AI 仲裁
    FILTER_STRIKE_LIMIT: 3,              // 累计违规达到该次数自动封禁
    FILTER_STRIKE_TTL_SECONDS: 604800,   // 违规计数窗口 7 天
    // AI 仲裁模型（glm-4.7-flash：官方推荐替代，快，中文理解力好，免费额度可用）
    AI_MODELS: [
        "@cf/zai-org/glm-4.7-flash"
    ]
};

// 线程健康检查缓存，减少频繁探测请求
const threadHealthCache = new Map();
// 同一实例内的并发保护：避免同一用户短时间内重复创建话题
const topicCreateInFlight = new Map();
// 管理员权限缓存（实例内）
const adminStatusCache = new Map();

// --- 本地题库 (15条) ---
const LOCAL_QUESTIONS = [
    {"question": "冰融化后会变成什么？", "correct_answer": "水", "incorrect_answers": ["石头", "木头", "火"]},
    {"question": "正常人有几只眼睛？", "correct_answer": "2", "incorrect_answers": ["1", "3", "4"]},
    {"question": "以下哪个属于水果？", "correct_answer": "香蕉", "incorrect_answers": ["白菜", "猪肉", "大米"]},
    {"question": "1 加 2 等于几？", "correct_answer": "3", "incorrect_answers": ["2", "4", "5"]},
    {"question": "5 减 2 等于几？", "correct_answer": "3", "incorrect_answers": ["1", "2", "4"]},
    {"question": "2 乘以 3 等于几？", "correct_answer": "6", "incorrect_answers": ["4", "5", "7"]},
    {"question": "10 加 5 等于几？", "correct_answer": "15", "incorrect_answers": ["10", "12", "20"]},
    {"question": "8 减 4 等于几？", "correct_answer": "4", "incorrect_answers": ["2", "3", "5"]},
    {"question": "在天上飞的交通工具是什么？", "correct_answer": "飞机", "incorrect_answers": ["汽车", "轮船", "自行车"]},
    {"question": "星期一的后面是星期几？", "correct_answer": "星期二", "incorrect_answers": ["星期日", "星期五", "星期三"]},
    {"question": "鱼通常生活在哪里？", "correct_answer": "水里", "incorrect_answers": ["树上", "土里", "火里"]},
    {"question": "我们用什么器官来听声音？", "correct_answer": "耳朵", "incorrect_answers": ["眼睛", "鼻子", "嘴巴"]},
    {"question": "晴朗的天空通常是什么颜色的？", "correct_answer": "蓝色", "incorrect_answers": ["绿色", "红色", "紫色"]},
    {"question": "太阳从哪个方向升起？", "correct_answer": "东方", "incorrect_answers": ["西方", "南方", "北方"]},
    {"question": "小狗发出的叫声通常是？", "correct_answer": "汪汪", "incorrect_answers": ["喵喵", "咩咩", "呱呱"]}
];

// --- 辅助工具函数 ---

// 结构化日志系统
const Logger = {
    /**
     * 记录信息级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    info(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    },

    /**
     * 记录警告级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    warn(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'WARN',
            action,
            ...data
        };
        console.warn(JSON.stringify(log));
    },

    /**
     * 记录错误级别日志
     * @param {string} action - 操作名称
     * @param {Error|string} error - 错误对象或消息
     * @param {object} data - 附加数据
     */
    error(action, error, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            action,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            ...data
        };
        console.error(JSON.stringify(log));
    },

    /**
     * 记录调试级别日志
     * @param {string} action - 操作名称
     * @param {object} data - 附加数据
     */
    debug(action, data = {}) {
        const log = {
            timestamp: new Date().toISOString(),
            level: 'DEBUG',
            action,
            ...data
        };
        console.log(JSON.stringify(log));
    }
};

// 加密安全的随机数生成
function secureRandomInt(min, max) {
    const range = max - min;
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return min + (bytes[0] % range);
}

function secureRandomId(length = 12) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// 安全的 JSON 获取
async function safeGetJSON(env, key, defaultValue = null) {
    try {
        const data = await env.TOPIC_MAP.get(key, { type: "json" });
        if (data === null || data === undefined) {
            return defaultValue;
        }
        if (typeof data !== 'object') {
            Logger.warn('kv_invalid_type', { key, type: typeof data });
            return defaultValue;
        }
        return data;
    } catch (e) {
        Logger.error('kv_parse_failed', e, { key });
        return defaultValue;
    }
}

function normalizeTgDescription(description) {
    return (description || "").toString().toLowerCase();
}

function isTopicMissingOrDeleted(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("thread not found") ||
           desc.includes("topic not found") ||
           desc.includes("message thread not found") ||
           desc.includes("topic deleted") ||
           desc.includes("thread deleted") ||
           desc.includes("forum topic not found") ||
           desc.includes("topic closed permanently");
}

function isTestMessageInvalid(description) {
    const desc = normalizeTgDescription(description);
    return desc.includes("message text is empty") ||
           desc.includes("bad request: message text is empty");
}

async function getOrCreateUserTopicRec(from, key, env, userId) {
    const existing = await safeGetJSON(env, key, null);
    if (existing && existing.thread_id) return existing;

    const inflight = topicCreateInFlight.get(String(userId));
    if (inflight) return await inflight;

    const p = (async () => {
        // 并发下二次确认，避免已被其他请求创建却读到旧值
        const again = await safeGetJSON(env, key, null);
        if (again && again.thread_id) return again;
        return await createTopic(from, key, env, userId);
    })();

    topicCreateInFlight.set(String(userId), p);
    try {
        return await p;
    } finally {
        if (topicCreateInFlight.get(String(userId)) === p) {
            topicCreateInFlight.delete(String(userId));
        }
    }
}

function withMessageThreadId(body, threadId) {
    if (threadId === undefined || threadId === null) return body;
    return { ...body, message_thread_id: threadId };
}

async function probeForumThread(env, expectedThreadId, { userId, reason, doubleCheckOnMissingThreadId = true } = {}) {
    const attemptOnce = async () => {
        const res = await tgCall(env, "sendMessage", {
            chat_id: env.SUPERGROUP_ID,
            message_thread_id: expectedThreadId,
            text: "🔎"
        });

        const actualThreadId = res.result?.message_thread_id;
        const probeMessageId = res.result?.message_id;

        // 尽可能清理探测消息（无论落到哪个话题/General）
        if (res.ok && probeMessageId) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: probeMessageId
                });
            } catch (e) {
                // 删除失败不影响主流程
            }
        }

        if (!res.ok) {
            if (isTopicMissingOrDeleted(res.description)) {
                return { status: "missing", description: res.description };
            }
            if (isTestMessageInvalid(res.description)) {
                return { status: "probe_invalid", description: res.description };
            }
            return { status: "unknown_error", description: res.description };
        }

        // 关键：有些情况下 Telegram 会返回 ok 但不带 message_thread_id（常见于 General）
        if (actualThreadId === undefined || actualThreadId === null) {
            return { status: "missing_thread_id" };
        }

        if (Number(actualThreadId) !== Number(expectedThreadId)) {
            return { status: "redirected", actualThreadId };
        }

        return { status: "ok" };
    };

    const first = await attemptOnce();
    if (first.status !== "missing_thread_id" || !doubleCheckOnMissingThreadId) return first;

    // 二次探测：避免偶发字段缺失导致误判并触发重建
    const second = await attemptOnce();
    if (second.status === "missing_thread_id") {
        Logger.warn('thread_probe_missing_thread_id', { userId, expectedThreadId, reason });
    }
    return second;
}

async function resetUserVerificationAndRequireReverify(env, { userId, userKey, oldThreadId, pendingMsgId, reason }) {
    // 清理旧映射与验证状态：用户需要重新做人机验证
    await env.TOPIC_MAP.delete(`verified:${userId}`);
    await env.TOPIC_MAP.put(`needs_verify:${userId}`, "1", { expirationTtl: CONFIG.NEEDS_REVERIFY_TTL_SECONDS });
    await env.TOPIC_MAP.delete(`retry:${userId}`);

    if (userKey) {
        await env.TOPIC_MAP.delete(userKey);
    }

    if (oldThreadId !== undefined && oldThreadId !== null) {
        await env.TOPIC_MAP.delete(`thread:${oldThreadId}`);
        await env.TOPIC_MAP.delete(`thread_ok:${oldThreadId}`);
        threadHealthCache.delete(oldThreadId);
    }

    Logger.info('verification_reset_due_to_topic_loss', {
        userId,
        oldThreadId,
        pendingMsgId,
        reason
    });

    await sendVerificationChallenge(userId, env, pendingMsgId || null);
}

function parseAdminIdAllowlist(env) {
    const raw = (env.ADMIN_IDS || "").toString().trim();
    if (!raw) return null;
    const ids = raw.split(/[,;\s]+/g).map(s => s.trim()).filter(Boolean);
    const set = new Set();
    for (const id of ids) {
        const n = Number(id);
        if (!Number.isFinite(n)) continue;
        set.add(String(n));
    }
    return set.size > 0 ? set : null;
}

async function isAdminUser(env, userId) {
    const allowlist = parseAdminIdAllowlist(env);
    if (allowlist && allowlist.has(String(userId))) return true;

    const cacheKey = String(userId);
    const now = Date.now();
    const cached = adminStatusCache.get(cacheKey);
    if (cached && (now - cached.ts < CONFIG.ADMIN_CACHE_TTL_SECONDS * 1000)) {
        return cached.isAdmin;
    }

    const kvKey = `admin:${userId}`;
    const kvVal = await env.TOPIC_MAP.get(kvKey);
    if (kvVal === "1" || kvVal === "0") {
        const isAdmin = kvVal === "1";
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    }

    try {
        const res = await tgCall(env, "getChatMember", {
            chat_id: env.SUPERGROUP_ID,
            user_id: userId
        });

        const status = res.result?.status;
        const isAdmin = res.ok && (status === "creator" || status === "administrator");
        await env.TOPIC_MAP.put(kvKey, isAdmin ? "1" : "0", { expirationTtl: CONFIG.ADMIN_CACHE_TTL_SECONDS });
        adminStatusCache.set(cacheKey, { ts: now, isAdmin });
        return isAdmin;
    } catch (e) {
        Logger.warn('admin_check_failed', { userId });
        return false;
    }
}

// 获取所有 KV keys（处理分页）
async function getAllKeys(env, prefix) {
    const allKeys = [];
    let cursor = undefined;

    do {
        const result = await env.TOPIC_MAP.list({ prefix, cursor });
        allKeys.push(...result.keys);
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);

    return allKeys;
}

// Fisher-Yates 洗牌算法
function shuffleArray(arr) {
    const array = [...arr];
    for (let i = array.length - 1; i > 0; i--) {
        const j = secureRandomInt(0, i + 1);
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// 速率限制检查
async function checkRateLimit(userId, env, action = 'message', limit = 20, window = 60) {
    const key = `ratelimit:${action}:${userId}`;
    const countStr = await env.TOPIC_MAP.get(key);
    const count = parseInt(countStr || "0");

    if (count >= limit) {
        return { allowed: false, remaining: 0 };
    }

    await env.TOPIC_MAP.put(key, String(count + 1), { expirationTtl: window });
    return { allowed: true, remaining: limit - count - 1 };
}

export default {
  async fetch(request, env, ctx) {
    // ---- 临时诊断接口：报告当前部署实际可见的配置（仅布尔值，不泄露任何密钥）----
    // 排查环境变量问题用，问题解决后可整段删除
    {
        const dbgUrl = new URL(request.url);
        if (dbgUrl.pathname === "/debug/env") {
            return new Response(JSON.stringify({
                kv_bound: !!env.TOPIC_MAP,
                bot_token_set: !!env.BOT_TOKEN,
                supergroup_id_set: !!env.SUPERGROUP_ID,
                workers_ai_bound: !!env.AI,
                turnstile_sitekey_set: !!env.TURNSTILE_SITEKEY,
                turnstile_secret_set: !!env.TURNSTILE_SECRET
            }, null, 2), { headers: { "content-type": "application/json" } });
        }
    }

    // 环境自检
    if (!env.TOPIC_MAP) return new Response("Error: KV 'TOPIC_MAP' not bound.");
    if (!env.BOT_TOKEN) return new Response("Error: BOT_TOKEN not set.");
    if (!env.SUPERGROUP_ID) return new Response("Error: SUPERGROUP_ID not set.");

    const url = new URL(request.url);

    // ---- Turnstile 验证页面与回调接口 ----
    if (request.method === "GET" && url.pathname === "/verify") {
        return handleTurnstilePage(request, env);
    }
    if (request.method === "POST" && url.pathname === "/turnstile/complete") {
        return handleTurnstileComplete(request, env, ctx);
    }

    // ---- Webhook 加密校验（可选加固）----
    // 设置 WEBHOOK_SECRET 后，未携带正确请求头的伪造请求将被直接拒绝
    if (env.WEBHOOK_SECRET) {
        const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
        if (secretHeader !== String(env.WEBHOOK_SECRET)) {
            Logger.warn('webhook_secret_rejected', { path: url.pathname });
            return new Response("Forbidden", { status: 403 });
        }
    }

    // 【修复 #7】规范化环境变量，统一为字符串类型
    const normalizedEnv = {
        ...env,
        SUPERGROUP_ID: String(env.SUPERGROUP_ID),
        BOT_TOKEN: String(env.BOT_TOKEN),
        SELF_ORIGIN: env.PUBLIC_BASE_URL || url.origin   // 生成验证页链接用
    };

    // 验证 SUPERGROUP_ID 格式
    if (!normalizedEnv.SUPERGROUP_ID.startsWith("-100")) {
        return new Response("Error: SUPERGROUP_ID must start with -100");
    }

    if (request.method !== "POST") return new Response("OK");

    // 验证 Content-Type
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        Logger.warn('invalid_content_type', { contentType });
        return new Response("OK");
    }

    let update;
    try {
      update = await request.json();

      // 验证基本结构
      if (!update || typeof update !== 'object') {
          Logger.warn('invalid_json_structure', { update: typeof update });
          return new Response("OK");
      }
    } catch (e) {
      Logger.error('json_parse_failed', e);
      return new Response("OK");
    }

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query, normalizedEnv, ctx);
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    ctx.waitUntil(flushExpiredMediaGroups(normalizedEnv, Date.now()));

    if (msg.chat && msg.chat.type === "private") {
      try {
        await handlePrivateMessage(msg, normalizedEnv, ctx);
      } catch (e) {
        // 不向用户泄露技术细节
        const errText = `⚠️ 系统繁忙，请稍后再试。`;
        await tgCall(normalizedEnv, "sendMessage", { chat_id: msg.chat.id, text: errText });
        Logger.error('private_message_failed', e, { userId: msg.chat.id });
      }
      return new Response("OK");
    }

    // 【修复 #7】使用字符串比较
    if (msg.chat && String(msg.chat.id) === normalizedEnv.SUPERGROUP_ID) {
        if (msg.forum_topic_closed && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, true, normalizedEnv);
            return new Response("OK");
        }
        if (msg.forum_topic_reopened && msg.message_thread_id) {
            await updateThreadStatus(msg.message_thread_id, false, normalizedEnv);
            return new Response("OK");
        }
        // 【修复】支持 General 话题和普通话题
        // General 话题的 message_thread_id 可能不存在，或者等于 1
        const text = (msg.text || "").trim();
        const isCommand = !!text && text.startsWith("/");
        if (msg.message_thread_id || isCommand) {
            await handleAdminReply(msg, normalizedEnv, ctx);
            return new Response("OK");
        }
    }

    return new Response("OK");
  },
};

// ---------------- 核心业务逻辑 ----------------

async function handlePrivateMessage(msg, env, ctx) {
  const userId = msg.chat.id;
  const key = `user:${userId}`;

  // 速率限制检查
  const rateLimit = await checkRateLimit(userId, env, 'message', CONFIG.RATE_LIMIT_MESSAGE, CONFIG.RATE_LIMIT_WINDOW);
  if (!rateLimit.allowed) {
      await tgCall(env, "sendMessage", {
          chat_id: userId,
          text: "⚠️ 发送过于频繁，请稍后再试。"
      });
      return;
  }

  // 拦截普通用户发送的指令
  if (msg.text && msg.text.startsWith("/") && msg.text.trim() !== "/start") {
      return;
  }

  const isBanned = await env.TOPIC_MAP.get(`banned:${userId}`);
  if (isBanned) return;

  const verified = await env.TOPIC_MAP.get(`verified:${userId}`);

  if (!verified) {
    const isStart = msg.text && msg.text.trim() === "/start";
    const pendingMsgId = isStart ? null : msg.message_id;
    await sendVerificationChallenge(userId, env, pendingMsgId);
    return;
  }

  await forwardToTopic(msg, userId, key, env, ctx);
}

async function forwardToTopic(msg, userId, key, env, ctx) {
    // 并发兜底：如果已被标记为需要重新验证，直接发起验证并暂停转发/建话题
    const needsVerify = await env.TOPIC_MAP.get(`needs_verify:${userId}`);
    if (needsVerify) {
        await sendVerificationChallenge(userId, env, msg.message_id || null);
        return;
    }

    // 【修复 #4】使用安全的 JSON 解析
    let rec = await safeGetJSON(env, key, null);

    if (rec && rec.closed) {
        await tgCall(env, "sendMessage", { chat_id: userId, text: "🚫 当前对话已被管理员关闭。" });
        return;
    }

    // 【修复 #5】重试计数器，防止无限循环
    const retryKey = `retry:${userId}`;
    let retryCount = parseInt(await env.TOPIC_MAP.get(retryKey) || "0");

    if (retryCount > CONFIG.MAX_RETRY_ATTEMPTS) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "❌ 系统繁忙，请稍后再试。"
        });
        await env.TOPIC_MAP.delete(retryKey);
        return;
    }

    if (!rec || !rec.thread_id) {
        rec = await getOrCreateUserTopicRec(msg.from, key, env, userId);
        if (!rec || !rec.thread_id) {
            throw new Error("创建话题失败");
        }
    }

    // 补建 thread->user 映射（兼容旧数据）
    if (rec && rec.thread_id) {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${rec.thread_id}`);
        if (!mappedUser) {
            await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
        }
    }

    // 【修复1】验证话题是否仍然存在（带缓存，降低探测频率）
    // 当话题被删除后，KV中的thread_id仍然存在，但实际话题已不可用
    if (rec && rec.thread_id) {
        const cacheKey = rec.thread_id;
        const now = Date.now();
        const cached = threadHealthCache.get(cacheKey);
        const withinTTL = cached && (now - cached.ts < CONFIG.THREAD_HEALTH_TTL_MS);

        if (!withinTTL) {
            // 跨节点缓存：避免由于 Workers 多 PoP 导致每次都做健康探测
            const kvHealthKey = `thread_ok:${rec.thread_id}`;
            const kvHealthOk = await env.TOPIC_MAP.get(kvHealthKey);
            if (kvHealthOk === "1") {
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
            } else {
            const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "health_check" });

            if (probe.status === "redirected" || probe.status === "missing" || probe.status === "missing_thread_id") {
                    await resetUserVerificationAndRequireReverify(env, {
                        userId,
                        userKey: key,
                        oldThreadId: rec.thread_id,
                        pendingMsgId: msg.message_id,
                        reason: `health_check:${probe.status}`
                    });
                    return;
            } else if (probe.status === "probe_invalid") {
                Logger.warn('topic_health_probe_invalid_message', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });

                // 仍然设置短 TTL，避免每条消息都探测（并误触发重建）
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            } else if (probe.status === "unknown_error") {
                Logger.warn('topic_test_failed_unknown', {
                    userId,
                    threadId: rec.thread_id,
                    errorDescription: probe.description
                });
            } else {
                await env.TOPIC_MAP.delete(retryKey);
                threadHealthCache.set(cacheKey, { ts: now, ok: true });
                await env.TOPIC_MAP.put(kvHealthKey, "1", { expirationTtl: Math.ceil(CONFIG.THREAD_HEALTH_TTL_MS / 1000) });
            }
            }
        }
    }

    // ---- 智能内容过滤：识别广告/引流/不良内容，拦截并警告 ----
    const filterResult = await filterMessage(msg, env);
    if (filterResult.action === "block") {
        const strikeKey = `strikes:${userId}`;
        const strikes = parseInt(await env.TOPIC_MAP.get(strikeKey) || "0") + 1;
        if (strikes >= CONFIG.FILTER_STRIKE_LIMIT) {
            await env.TOPIC_MAP.put(`banned:${userId}`, "1");
        } else {
            await env.TOPIC_MAP.put(strikeKey, String(strikes), { expirationTtl: CONFIG.FILTER_STRIKE_TTL_SECONDS });
        }

        const reasonText = filterResult.reasons.slice(0, 3).join("、");
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: strikes >= CONFIG.FILTER_STRIKE_LIMIT
                ? "🚫 检测到您多次发送广告或违规内容，已被拉黑。"
                : `⚠️ 您的消息疑似包含广告或不良内容（${reasonText}），已被拦截，未送达对方。\n累计 ${CONFIG.FILTER_STRIKE_LIMIT} 次将被拉黑（当前 ${strikes}/${CONFIG.FILTER_STRIKE_LIMIT}）。`
        });

        // 通知管理员（仅通知原因，不转发原始内容）
        try {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                text: `⛔ **已拦截违规消息**\n用户: [${userId}](tg://user?id=${userId})\n原因: ${reasonText}\n警告: ${strikes}/${CONFIG.FILTER_STRIKE_LIMIT}${strikes >= CONFIG.FILTER_STRIKE_LIMIT ? "（已自动封禁）" : ""}`,
                parse_mode: "Markdown"
            }, rec.thread_id));
        } catch (e) {
            // 通知失败不影响主流程
        }
        Logger.info('content_blocked', { userId, reasons: filterResult.reasons, strikes });
        return;
    }
    if (filterResult.action === "flag") {
        // 灰区消息：无法 AI 仲裁时照常转发，但提前向管理员提示可疑特征
        try {
            await tgCall(env, "sendMessage", withMessageThreadId({
                chat_id: env.SUPERGROUP_ID,
                text: `⚠️ **可疑消息提醒**\n用户: [${userId}](tg://user?id=${userId})\n特征: ${filterResult.reasons.slice(0, 3).join("、")}\n（AI 仲裁失败: ${String(filterResult.aiError || "未知原因").slice(0, 200)}，请自行甄别下方消息）`,
                parse_mode: "Markdown"
            }, rec.thread_id));
        } catch (e) {
            // 提示失败不影响转发
        }
    }

    if (msg.media_group_id) {
        await handleMediaGroup(msg, env, ctx, {
            direction: "p2t",
            targetChat: env.SUPERGROUP_ID,
            threadId: rec.thread_id
        });
        return;
    }

    const res = await tgCall(env, "forwardMessage", {
        chat_id: env.SUPERGROUP_ID,
        from_chat_id: userId,
        message_id: msg.message_id,
        message_thread_id: rec.thread_id,
    });

    // 检测 Telegram 静默重定向到 General 的情况
    const resThreadId = res.result?.message_thread_id;
    if (res.ok && resThreadId !== undefined && resThreadId !== null && Number(resThreadId) !== Number(rec.thread_id)) {
        Logger.warn('forward_redirected_to_general', {
            userId,
            expectedThreadId: rec.thread_id,
            actualThreadId: resThreadId
        });

        // 删除误投到 General 的消息
        if (res.result?.message_id) {
            try {
                await tgCall(env, "deleteMessage", {
                    chat_id: env.SUPERGROUP_ID,
                    message_id: res.result.message_id
                });
            } catch (e) {
                // 删除失败不影响重发
            }
        }
        await resetUserVerificationAndRequireReverify(env, {
            userId,
            userKey: key,
            oldThreadId: rec.thread_id,
            pendingMsgId: msg.message_id,
            reason: "forward_redirected_to_general"
        });
        return;
    }

    // 兜底：部分情况下 Telegram 返回 ok 但不带 message_thread_id（可能已落入 General）
    if (res.ok && (resThreadId === undefined || resThreadId === null)) {
        const probe = await probeForumThread(env, rec.thread_id, { userId, reason: "forward_result_missing_thread_id" });
        if (probe.status !== "ok") {
            Logger.warn('forward_suspected_redirect_or_missing', {
                userId,
                expectedThreadId: rec.thread_id,
                probeStatus: probe.status,
                probeDescription: probe.description
            });

            // 尽量删除误投消息（通常在 General）
            if (res.result?.message_id) {
                try {
                    await tgCall(env, "deleteMessage", {
                        chat_id: env.SUPERGROUP_ID,
                        message_id: res.result.message_id
                    });
                } catch (e) {
                    // 删除失败不影响重发
                }
            }
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: `forward_missing_thread_id:${probe.status}`
            });
            return;
        }
    }

    // 【修复2】增强错误处理，双重保险
    // 如果上面的测试没有捕获到，这里再次检测
    if (!res.ok) {
        const desc = normalizeTgDescription(res.description);
        if (isTopicMissingOrDeleted(desc)) {
            Logger.warn('forward_failed_topic_missing', {
                userId,
                threadId: rec.thread_id,
                errorDescription: res.description
            });
            await resetUserVerificationAndRequireReverify(env, {
                userId,
                userKey: key,
                oldThreadId: rec.thread_id,
                pendingMsgId: msg.message_id,
                reason: "forward_failed_topic_missing"
            });
            return;
        }

        if (desc.includes("chat not found")) throw new Error(`群组ID错误: ${env.SUPERGROUP_ID}`);
        if (desc.includes("not enough rights")) throw new Error("机器人权限不足 (需 Manage Topics)");

        // 如果forwardMessage失败，尝试使用copyMessage作为降级方案
        await tgCall(env, "copyMessage", {
            chat_id: env.SUPERGROUP_ID,
            from_chat_id: userId,
            message_id: msg.message_id,
            message_thread_id: rec.thread_id
        });
    }
}

async function handleAdminReply(msg, env, ctx) {
  const threadId = msg.message_thread_id;
  const text = (msg.text || "").trim();
  const senderId = msg.from?.id;

  // 仅允许管理员在群内操作与回信，防止任意群成员向用户私聊注入消息
  if (!senderId || !(await isAdminUser(env, senderId))) {
      return;
  }

  // 【修复】允许在任何话题执行 /cleanup 命令
  if (text === "/cleanup") {
      // /cleanup 可能处理较久，使用 waitUntil 防止 webhook 请求超时导致“卡住”
      ctx.waitUntil(handleCleanupCommand(threadId, env));
      return;
  }

  // 优先通过 thread 映射快速反查用户，缺失时再降级全量扫描
  let userId = null;
  const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
  if (mappedUser) {
      userId = Number(mappedUser);
  } else {
      const allKeys = await getAllKeys(env, "user:");
      for (const { name } of allKeys) {
          const rec = await safeGetJSON(env, name, null);
          if (rec && Number(rec.thread_id) === Number(threadId)) {
              userId = Number(name.slice(5));
              break;
          }
      }
  }

  // 如果找不到用户，说明可能是在普通话题，或者数据丢失，直接返回
  if (!userId) return; 

  // --- 指令区域 ---

  if (text === "/close") {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = true;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "closeForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **对话已强制关闭**", parse_mode: "Markdown" });
      }
      return;
  }

  if (text === "/open") {
      const key = `user:${userId}`;
      let rec = await safeGetJSON(env, key, null);
      if (rec) {
          rec.closed = false;
          await env.TOPIC_MAP.put(key, JSON.stringify(rec));
          await tgCall(env, "reopenForumTopic", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId });
          await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **对话已恢复**", parse_mode: "Markdown" });
      }
      return;
  }

  if (text === "/reset") {
      await env.TOPIC_MAP.delete(`verified:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🔄 **验证重置**", parse_mode: "Markdown" });
      return;
  }

  if (text === "/trust") {
      await env.TOPIC_MAP.put(`verified:${userId}`, "trusted");
      await env.TOPIC_MAP.delete(`needs_verify:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🌟 **已设置永久信任**", parse_mode: "Markdown" });
      return;
  }

  if (text === "/ban") {
      await env.TOPIC_MAP.put(`banned:${userId}`, "1");
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "🚫 **用户已封禁**", parse_mode: "Markdown" });
      return;
  }

  if (text === "/unban") {
      await env.TOPIC_MAP.delete(`banned:${userId}`);
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: "✅ **用户已解封**", parse_mode: "Markdown" });
      return;
  }

  if (text === "/info") {
      const userKey = `user:${userId}`;
      const userRec = await safeGetJSON(env, userKey, null);
      const verifyStatus = await env.TOPIC_MAP.get(`verified:${userId}`);
      const banStatus = await env.TOPIC_MAP.get(`banned:${userId}`);

      const info = `👤 **用户信息**\nUID: \`${userId}\`\nTopic ID: \`${threadId}\`\n话题标题: ${userRec?.title || "未知"}\n验证状态: ${verifyStatus ? (verifyStatus === 'trusted' ? '🌟 永久信任' : '✅ 已验证') : '❌ 未验证'}\n封禁状态: ${banStatus ? '🚫 已封禁' : '✅ 正常'}\nLink: [点击私聊](tg://user?id=${userId})`;
      await tgCall(env, "sendMessage", { chat_id: env.SUPERGROUP_ID, message_thread_id: threadId, text: info, parse_mode: "Markdown" });
      return;
  }

  // 转发管理员消息给用户
  if (msg.media_group_id) {
    await handleMediaGroup(msg, env, ctx, { direction: "t2p", targetChat: userId, threadId: undefined });
    return;
  }
  await tgCall(env, "copyMessage", { chat_id: userId, from_chat_id: env.SUPERGROUP_ID, message_id: msg.message_id });
}

// ---------------- 验证模块 (纯本地) ----------------

async function sendVerificationChallenge(userId, env, pendingMsgId) {
    // 优先使用 Cloudflare Turnstile 验证（配置 TURNSTILE_SITEKEY + TURNSTILE_SECRET 后生效）
    if (isTurnstileEnabled(env)) {
        await sendTurnstileChallenge(userId, env, pendingMsgId);
        return;
    }

    // 兜底方案：未配置 Turnstile 时沿用本地题库验证（原逻辑不变）
    // 【修复 #1】检查是否已有进行中的验证
    const existingChallenge = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
    if (existingChallenge) {
        // 有正在进行的验证：仅将新消息加入待发送队列，避免重复下发题目/触发验证限速
        const chalKey = `chal:${existingChallenge}`;
        const state = await safeGetJSON(env, chalKey, null);

        // KV 可能存在不一致/过期：自愈清理后重新下发
        if (!state || state.userId !== userId) {
            await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
        } else {
            if (pendingMsgId) {
                let pendingIds = [];
                if (Array.isArray(state.pending_ids)) {
                    pendingIds = state.pending_ids.slice();
                } else if (state.pending) {
                    pendingIds = [state.pending];
                }

                if (!pendingIds.includes(pendingMsgId)) {
                    pendingIds.push(pendingMsgId);
                    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
                        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
                    }
                    state.pending_ids = pendingIds;
                    delete state.pending;
                    await env.TOPIC_MAP.put(chalKey, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });
                }
            }
            Logger.debug('verification_duplicate_skipped', { userId, verifyId: existingChallenge, hasPending: !!pendingMsgId });
            return;
        }
    }

    // 验证请求速率限制：仅在需要创建新挑战时检查
    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
        });
        return;
    }

    // 【修复 #9】使用加密安全的随机数
    const q = LOCAL_QUESTIONS[secureRandomInt(0, LOCAL_QUESTIONS.length)];
    const challenge = {
        question: q.question,
        correct: q.correct_answer,
        options: shuffleArray([...q.incorrect_answers, q.correct_answer])
    };

    // 【修复 #9】使用加密安全的ID生成
    const verifyId = secureRandomId(CONFIG.VERIFY_ID_LENGTH);

    // 【修复 #6】使用答案索引而非文本，避免截断问题
    const answerIndex = challenge.options.indexOf(challenge.correct);

    const state = {
        answerIndex: answerIndex,      // 存储索引
        options: challenge.options,     // 存储完整选项列表
        pending_ids: pendingMsgId ? [pendingMsgId] : [],
        userId: userId                  // 添加用户ID验证
    };

    await env.TOPIC_MAP.put(`chal:${verifyId}`, JSON.stringify(state), { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

    // 【修复 #1】标记用户正在验证中
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, verifyId, { expirationTtl: CONFIG.VERIFY_EXPIRE_SECONDS });

    Logger.info('verification_sent', {
        userId,
        verifyId,
        question: q.question,
        pendingCount: state.pending_ids.length
    });

    // 【修复 #6】按钮使用索引而非文本
    const buttons = challenge.options.map((opt, idx) => ({
        text: opt,
        callback_data: `verify:${verifyId}:${idx}`  // 使用索引
    }));

    const keyboard = [];
    for (let i = 0; i < buttons.length; i += CONFIG.BUTTON_COLUMNS) {
        keyboard.push(buttons.slice(i, i + CONFIG.BUTTON_COLUMNS));
    }

    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: `🛡️ **人机验证**\n\n${challenge.question}\n\n请点击下方按钮回答 (回答正确后将自动发送您刚才的消息)。`,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard }
    });
}

async function handleCallbackQuery(query, env, ctx) {
    try {
        const data = query.data;
        if (!data.startsWith("verify:")) return;

        const parts = data.split(":");
        if (parts.length !== 3) return;

        const verifyId = parts[1];
        const selectedIndex = parseInt(parts[2]);  // 【修复 #6】用户选择的索引
        const userId = query.from.id;

        const stateStr = await env.TOPIC_MAP.get(`chal:${verifyId}`);
        if (!stateStr) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 验证已过期，请重发消息",
                show_alert: true
            });
            return;
        }

        let state;
        try {
            state = JSON.parse(stateStr);
        } catch(e) {
             await tgCall(env, "answerCallbackQuery", {
                 callback_query_id: query.id,
                 text: "❌ 数据错误",
                 show_alert: true
             });
             return;
        }

        // 【修复 #1】验证用户ID匹配
        if (state.userId && state.userId !== userId) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 无效的验证",
                show_alert: true
            });
            return;
        }

        // 【修复 #6】验证索引有效性
        if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= state.options.length) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 无效选项",
                show_alert: true
            });
            return;
        }

        if (selectedIndex === state.answerIndex) {
            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "✅ 验证通过"
            });

            Logger.info('verification_passed', {
                userId,
                verifyId,
                selectedOption: state.options[selectedIndex]
            });

            // 30天有效期 - 使用配置常量
            await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
            await env.TOPIC_MAP.delete(`needs_verify:${userId}`);

            // 【修复 #1】清理所有相关挑战
            await env.TOPIC_MAP.delete(`chal:${verifyId}`);
            await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

            await tgCall(env, "editMessageText", {
                chat_id: userId,
                message_id: query.message.message_id,
                text: "✅ **验证成功**\n\n您现在可以自由对话了。",
                parse_mode: "Markdown"
            });

            const hasPending = (Array.isArray(state.pending_ids) && state.pending_ids.length > 0) || !!state.pending;
            if (hasPending) {
                try {
                    let pendingIds = [];
                    if (Array.isArray(state.pending_ids)) {
                        pendingIds = state.pending_ids.slice();
                    } else if (state.pending) {
                        pendingIds = [state.pending];
                    }

                    // 限制一次性转发量，避免用户恶意堆积导致执行超时
                    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
                        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
                    }

                    let forwardedCount = 0;
                    for (const pendingId of pendingIds) {
                        if (!pendingId) continue;
                        const forwardedKey = `forwarded:${userId}:${pendingId}`;
                        const alreadyForwarded = await env.TOPIC_MAP.get(forwardedKey);
                        if (alreadyForwarded) {
                            Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
                            continue;
                        }

                        const fakeMsg = {
                            message_id: pendingId,
                            chat: { id: userId, type: "private" },
                            from: query.from,
                        };

                        await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx);
                        await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
                        forwardedCount++;
                    }

                    if (forwardedCount > 0) {
                        await tgCall(env, "sendMessage", {
                            chat_id: userId,
                            text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
                        });
                    }
                } catch (e) {
                    Logger.error('pending_message_forward_failed', e, { userId });
                    await tgCall(env, "sendMessage", {
                        chat_id: userId,
                        text: "⚠️ 自动发送失败，请重新发送您的消息。"
                    });
                }
            }
        } else {
            Logger.info('verification_failed', {
                userId,
                verifyId,
                selectedIndex,
                correctIndex: state.answerIndex
            });

            await tgCall(env, "answerCallbackQuery", {
                callback_query_id: query.id,
                text: "❌ 答案错误",
                show_alert: true
            });
        }
    } catch (e) {
        Logger.error('callback_query_error', e, {
            userId: query.from?.id,
            callbackData: query.data
        });
        await tgCall(env, "answerCallbackQuery", {
            callback_query_id: query.id,
            text: `⚠️ 系统错误，请重试`,
            show_alert: true
        });
    }
}

// ---------------- Turnstile 人机验证模块 ----------------

function isTurnstileEnabled(env) {
    return !!(env.TURNSTILE_SITEKEY && env.TURNSTILE_SECRET);
}

/**
 * 下发 Turnstile 验证：向用户私聊发送 web_app 按钮，
 * 打开 Worker 自托管的验证页完成 Cloudflare Turnstile 挑战。
 * 验证期间的消息 ID 暂存在 KV，验证通过后自动补发。
 */
async function sendTurnstileChallenge(userId, env, pendingMsgId) {
    // 进行中的验证只追加待发消息，不重复下发按钮（防止刷接口）
    const existingToken = await env.TOPIC_MAP.get(`user_challenge:${userId}`);
    if (existingToken) {
        const stateKey = `ts:${existingToken}`;
        const state = await safeGetJSON(env, stateKey, null);
        if (state && state.userId === userId) {
            if (pendingMsgId) {
                let pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : [];
                if (!pendingIds.includes(pendingMsgId)) {
                    pendingIds.push(pendingMsgId);
                    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
                        pendingIds = pendingIds.length - CONFIG.PENDING_MAX_MESSAGES > 0
                            ? pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES)
                            : pendingIds;
                    }
                    state.pending_ids = pendingIds;
                    await env.TOPIC_MAP.put(stateKey, JSON.stringify(state), { expirationTtl: CONFIG.TURNSTILE_LINK_TTL_SECONDS });
                }
            }
            Logger.debug('turnstile_duplicate_skipped', { userId, hasPending: !!pendingMsgId });
            return;
        }
        // KV 不一致：自愈清理后重新下发
        await env.TOPIC_MAP.delete(`user_challenge:${userId}`);
    }

    const verifyLimit = await checkRateLimit(userId, env, 'verify', CONFIG.RATE_LIMIT_VERIFY, 300);
    if (!verifyLimit.allowed) {
        await tgCall(env, "sendMessage", {
            chat_id: userId,
            text: "⚠️ 验证请求过于频繁，请5分钟后再试。"
        });
        return;
    }

    // 生成一次性验证链接令牌（32 位加密随机串，5 分钟有效）
    const linkToken = secureRandomId(32);
    const state = { userId, pending_ids: pendingMsgId ? [pendingMsgId] : [] };
    await env.TOPIC_MAP.put(`ts:${linkToken}`, JSON.stringify(state), { expirationTtl: CONFIG.TURNSTILE_LINK_TTL_SECONDS });
    await env.TOPIC_MAP.put(`user_challenge:${userId}`, linkToken, { expirationTtl: CONFIG.TURNSTILE_LINK_TTL_SECONDS });

    Logger.info('turnstile_challenge_sent', {
        userId,
        pendingCount: state.pending_ids.length
    });

    const origin = env.PUBLIC_BASE_URL || env.SELF_ORIGIN;
    if (!origin) {
        Logger.error('turnstile_origin_missing', new Error("无法确定 Worker 公网地址，请配置 PUBLIC_BASE_URL"));
        return;
    }
    const verifyUrl = `${origin}/verify?t=${linkToken}`;

    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "🛡️ **人机验证**\n\n请点击下方按钮完成 Cloudflare 人机验证（约 5 秒）。\n验证通过后，您刚才的消息将自动送达。",
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: [[{ text: "✅ 点击进行人机验证", web_app: { url: verifyUrl } }]] }
    });
}

/**
 * 渲染 Turnstile 验证页（由 Worker 直接托管）。
 * 页面在 Telegram 内置浏览器中打开，可读取 initData 用于身份绑定。
 */
function buildTurnstilePage(env, expired) {
    const sitekey = String(env.TURNSTILE_SITEKEY).replace(/[^a-zA-Z0-9_-]/g, "");

    const body = expired
        ? '<div class="card"><h2>⏳ 链接已过期</h2><p>验证链接已失效，请回到 Telegram 聊天窗口重新发送一条消息，即可获取新的验证。</p></div>'
        : [
              '<div class="card">',
              '  <h2>🛡️ 人机验证</h2>',
              '  <p>为了防止广告与骚扰，请先完成下方验证。验证通过后将自动返回聊天窗口。</p>',
              '  <div id="widget"></div>',
              '  <p id="status"></p>',
              '</div>',
              '<script>',
              '  var tg = (window.Telegram && window.Telegram.WebApp) ? window.Telegram.WebApp : null;',
              '  if (tg && tg.ready) { tg.ready(); }',
              '  if (tg && tg.expand) { tg.expand(); }',
              '  function setStatus(text, cls) {',
              '    var s = document.getElementById("status");',
              '    if (s) { s.textContent = text; s.className = cls || ""; }',
              '  }',
              '  function initWidget() {',
              '    try {',
              '      turnstile.render("#widget", {',
              '        sitekey: "' + sitekey + '",',
              '        theme: "auto",',
              '        language: "zh-cn",',
              '        callback: function (token) { submitVerify(token); }',
              '      });',
              '    } catch (e) {',
              '      setStatus("验证组件加载失败，请刷新重试", "err");',
              '    }',
              '  }',
              '  function submitVerify(token) {',
              '    setStatus("正在校验，请稍候…", "");',
              '    var payload = {',
              '      t: new URLSearchParams(location.search).get("t"),',
              '      cf: token,',
              '      initData: (tg && tg.initData) ? tg.initData : ""',
              '    };',
              '    fetch("/turnstile/complete", {',
              '      method: "POST",',
              '      headers: { "content-type": "application/json" },',
              '      body: JSON.stringify(payload)',
              '    }).then(function (r) { return r.json(); }).then(function (res) {',
              '      if (res.ok) {',
              '        setStatus("✅ 验证成功！正在返回 Telegram…", "ok");',
              '        setTimeout(function () { if (tg && tg.close) { tg.close(); } }, 1600);',
              '      } else {',
              '        setStatus("❌ " + (res.message || "验证失败，请返回聊天窗口重新发送消息"), "err");',
              '      }',
              '    }).catch(function () {',
              '      setStatus("网络错误，请重试", "err");',
              '    });',
              '  }',
              '</script>',
              '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=initWidget&render=explicit" async defer></script>'
          ].join("\n");

    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>人机验证</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1c1e21; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; border-radius: 16px; box-shadow: 0 2px 12px rgba(0,0,0,.08); padding: 28px 24px; max-width: 360px; width: calc(100% - 48px); text-align: center; }
  h2 { font-size: 18px; margin: 0 0 10px; }
  p { font-size: 14px; line-height: 1.6; color: #555; }
  #widget { display: flex; justify-content: center; margin: 18px 0; min-height: 65px; }
  #status { min-height: 20px; font-size: 14px; }
  #status.ok { color: #0f6e56; font-weight: 600; }
  #status.err { color: #b02a2a; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

async function handleTurnstilePage(request, env) {
    if (!isTurnstileEnabled(env)) {
        return new Response("Turnstile 未配置：请设置 TURNSTILE_SITEKEY 与 TURNSTILE_SECRET 环境变量。", { status: 404 });
    }
    const token = (new URL(request.url).searchParams.get("t") || "").replace(/[^a-zA-Z0-9]/g, "");
    const state = token ? await safeGetJSON(env, `ts:${token}`, null) : null;
    const expired = !state || state.userId === undefined;
    return new Response(buildTurnstilePage(env, expired), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
}

/**
 * Turnstile 完成回调：
 * 1. 校验一次性链接令牌（KV 中存在且未过期）
 * 2. 校验 Telegram initData HMAC 签名，确保是本人操作
 * 3. 调用 Cloudflare siteverify 校验挑战结果
 * 4. 标记 30 天免验证，补发暂存消息
 */
async function handleTurnstileComplete(request, env, ctx) {
    const jsonResp = (obj, status) => new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
    });

    if (!isTurnstileEnabled(env)) return jsonResp({ ok: false, message: "Turnstile 未配置" }, 404);

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return jsonResp({ ok: false, message: "请求格式错误" }, 400);
    }

    const linkToken = String(body.t || "").replace(/[^a-zA-Z0-9]/g, "");
    const cfResponse = String(body.cf || "");
    if (!linkToken || !cfResponse) return jsonResp({ ok: false, message: "参数缺失" }, 400);

    const stateKey = `ts:${linkToken}`;
    const state = await safeGetJSON(env, stateKey, null);
    if (!state || state.userId === undefined) {
        return jsonResp({ ok: false, message: "验证链接已过期，请返回聊天窗口重新发送消息" }, 410);
    }
    const userId = state.userId;

    // 身份校验（软校验）：initData HMAC 校验失败时仅记录日志、不阻断流程。
    // 安全性由一次性链接令牌（KV 绑定 userId、5 分钟过期）+ Turnstile siteverify 保证，
    // initData 属于额外的第三层防线，参考 dydydd fork 的做法降级为可观察项。
    const initData = String(body.initData || "");
    if (initData) {
        const v = await validateTelegramInitData(env, initData, userId);
        if (!v.ok) {
            Logger.warn('turnstile_initdata_invalid_soft', { userId, reason: v.reason, detail: v.detail || null });
        }
    }

    // 调用 Cloudflare siteverify
    const form = new FormData();
    form.append("secret", String(env.TURNSTILE_SECRET));
    form.append("response", cfResponse);
    let svResult;
    try {
        const svResp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
            method: "POST",
            body: form
        });
        svResult = await svResp.json();
    } catch (e) {
        Logger.error('turnstile_siteverify_failed', e, { userId });
        return jsonResp({ ok: false, message: "验证服务暂时不可用，请稍后重试" }, 502);
    }
    if (!svResult || !svResult.success) {
        Logger.warn('turnstile_verify_failed', { userId, errors: svResult && svResult["error-codes"] });
        return jsonResp({ ok: false, message: "人机验证未通过，请重新验证" }, 400);
    }

    // 幂等：立即删除一次性链接与进行中标记
    await env.TOPIC_MAP.delete(stateKey);
    await env.TOPIC_MAP.delete(`user_challenge:${userId}`);

    // 30 天免验证
    await env.TOPIC_MAP.put(`verified:${userId}`, "1", { expirationTtl: CONFIG.VERIFIED_EXPIRE_SECONDS });
    await env.TOPIC_MAP.delete(`needs_verify:${userId}`);

    Logger.info('turnstile_verification_passed', { userId });

    await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: "✅ **验证成功**\n\n您现在可以自由对话了。",
        parse_mode: "Markdown"
    });

    // 补发验证期间暂存的消息
    let pendingIds = Array.isArray(state.pending_ids) ? state.pending_ids.slice() : [];
    if (pendingIds.length > CONFIG.PENDING_MAX_MESSAGES) {
        pendingIds = pendingIds.slice(pendingIds.length - CONFIG.PENDING_MAX_MESSAGES);
    }
    if (pendingIds.length > 0) {
        try {
            let forwardedCount = 0;
            for (const pendingId of pendingIds) {
                if (!pendingId) continue;
                const forwardedKey = `forwarded:${userId}:${pendingId}`;
                if (await env.TOPIC_MAP.get(forwardedKey)) {
                    Logger.info('message_forward_duplicate_skipped', { userId, messageId: pendingId });
                    continue;
                }
                const fakeMsg = {
                    message_id: pendingId,
                    chat: { id: userId, type: "private" },
                    from: { id: userId }
                };
                await forwardToTopic(fakeMsg, userId, `user:${userId}`, env, ctx);
                await env.TOPIC_MAP.put(forwardedKey, "1", { expirationTtl: 3600 });
                forwardedCount++;
            }
            if (forwardedCount > 0) {
                await tgCall(env, "sendMessage", {
                    chat_id: userId,
                    text: `📩 刚才的 ${forwardedCount} 条消息已帮您送达。`
                });
            }
        } catch (e) {
            Logger.error('pending_message_forward_failed', e, { userId });
            await tgCall(env, "sendMessage", {
                chat_id: userId,
                text: "⚠️ 自动发送失败，请重新发送您的消息。"
            });
        }
    }

    return jsonResp({ ok: true });
}

/**
 * 校验 Telegram WebApp initData 的 HMAC 签名（官方算法）：
 * secret_key = HMAC_SHA256(bot_token, "WebAppData")
 * hash       = HMAC_SHA256(secret_key, data_check_string)
 * 返回 { ok, reason, detail }，reason 标识具体失败环节（用于诊断）
 */
async function validateTelegramInitData(env, initData, expectedUserId) {
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get("hash");
        const authDate = parseInt(params.get("auth_date") || "0", 10);
        if (!hash) return { ok: false, reason: "no_hash" };
        if (!authDate) return { ok: false, reason: "no_auth_date" };
        const age = Math.floor(Date.now() / 1000) - authDate;
        if (age > CONFIG.TURNSTILE_INITDATA_MAX_AGE) return { ok: false, reason: "expired", detail: `auth_age=${age}s` };

        const userRaw = params.get("user");
        if (userRaw) {
            const u = JSON.parse(userRaw);
            if (Number(u.id) !== Number(expectedUserId)) return { ok: false, reason: "user_mismatch", detail: `initData_uid=${u.id} expected=${expectedUserId}` };
        }

        // 【修复 #29】排除 hash 与 signature（Telegram 直链启动 Mini App 时 initData 会附带 signature）
        // 官方算法要求：构造 data-check-string 时 hash 和 signature 都必须从输入中移除
        params.delete("hash");
        params.delete("signature");

        // data_check_string = 按 key 排序的 "k=v" 列表，用 \n 连接
        const dataCheckString = [...params.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join("\n");

        const enc = new TextEncoder();
        const botKey = await crypto.subtle.importKey(
            "raw", enc.encode(String(env.BOT_TOKEN)),
            { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const secretBuf = await crypto.subtle.sign("HMAC", botKey, enc.encode("WebAppData"));
        const secretKey = await crypto.subtle.importKey(
            "raw", secretBuf,
            { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const calcBuf = await crypto.subtle.sign("HMAC", secretKey, enc.encode(dataCheckString));
        const calc = [...new Uint8Array(calcBuf)].map(b => b.toString(16).padStart(2, "0")).join("");
        if (calc !== hash) {
            // 详细输出便于线上比对：
            // - initData 原文前 200 字符（看是否被修改）
            // - 期望 hash 与计算 hash 前 12 字符
            // - data_check_string 完整内容（把 \n 替换为 | 以便单行显示）
            const safeInit = (initData || "").slice(0, 200);
            const safeDcs = dataCheckString.replace(/\n/g, "|");
            return {
                ok: false,
                reason: "hmac_mismatch",
                detail: `exp=${hash.slice(0,12)} calc=${calc.slice(0,12)} dcs[${safeDcs.length}]=${safeDcs.slice(0,160)} init[${initData.length}]=${safeInit}`
            };
        }
        return { ok: true };
    } catch (e) {
        Logger.error('initdata_validate_failed', e);
        return { ok: false, reason: "exception", detail: String(e && e.message) };
    }
}

// ---------------- 智能内容过滤模块 ----------------

// 关键词规则组（每组命中只计一次权重）
const SPAM_RULE_GROUPS = [
    { weight: 60, name: "违法/色情/赌博", keywords: ["博彩", "赌球", "六合彩", "时时彩", "开元棋牌", "开户存送", "色情", "援交", "裸聊", "约炮", "一夜情", "福利姬", "毒品", "冰毒", "洗钱", "枪支买卖"] },
    { weight: 40, name: "兼职刷单/返利", keywords: ["刷单", "返利", "日入", "月入过万", "稳赚", "躺赚", "带你赚", "带单", "高额回报", "保本保息", "红包返现", "动动手指", "宝妈兼职", "闲鱼无货源"] },
    { weight: 40, name: "联系方式引流", keywords: ["加微信", "加vx", "加v信", "加威信", "薇信", "私聊我", "联系我", "扫码进群", "进群领", "加q群", "扣扣"] },
    { weight: 30, name: "广告推广", keywords: ["推广", "代刷", "代充", "高仿", "莆田", "一手货源", "招代理", "招商加盟", "外发加工", "接单", "低价代购"] },
    { weight: 35, name: "虚拟币/投资诈骗", keywords: ["usdt", "u商", "收u", "出u", "泰达币", "虚拟币", "挖矿收益", "交易所返佣", "老师带单", "内幕消息"] }
];

// 正则特征规则（每条命中只计一次权重）
const SPAM_PATTERNS = [
    { weight: 45, name: "Telegram 引流链接", re: /(?:t\.me|telegram\.me)\/\S+/i },
    { weight: 25, name: "外部链接", re: /(?:https?:\/\/|www\.)\S+/i },
    { weight: 40, name: "社交联系方式", re: /(?:微信|vx|v信|威信|薇信|wx|扣扣|qq)\s*[:：号]?\s*[a-z0-9_-]{5,}/i },
    { weight: 40, name: "手机号", re: /(?:^|\D)1[3-9]\d{9}(?!\d)/ },
    { weight: 30, name: "字符刷屏", re: /(.)\1{6,}/ },
    { weight: 25, name: "表情刷屏", re: /(?:[\u{1F300}-\u{1FAFF}]\s*){6,}/u }
];

/**
 * 规则层：对消息做特征打分
 */
function analyzeContentSignals(msg) {
    const text = ((msg && (msg.text || msg.caption)) || "").trim();
    const result = { text, score: 0, reasons: [] };
    if (!text) return result;
    const lower = text.toLowerCase();

    for (const group of SPAM_RULE_GROUPS) {
        for (const kw of group.keywords) {
            if (lower.includes(kw.toLowerCase())) {
                result.score += group.weight;
                result.reasons.push(`${group.name}「${kw}」`);
                break;
            }
        }
    }

    for (const p of SPAM_PATTERNS) {
        if (p.re.test(text)) {
            result.score += p.weight;
            result.reasons.push(p.name);
        }
    }

    // 结构化信号：消息内嵌的 URL 实体
    const entities = (msg && msg.entities) || [];
    const urlCount = entities.filter(e => e.type === "url" || e.type === "text_link").length;
    if (urlCount >= 3) {
        result.score += 40;
        result.reasons.push("多个链接实体");
    } else if (urlCount === 1) {
        result.score += 15;
        result.reasons.push("含链接实体");
    }

    return result;
}

/**
 * AI 层：Workers AI 对灰区消息做语义仲裁。
 * 依次尝试 AI_MODELS 中的模型，任一成功即返回判定结果。
 * 全部失败时返回 { error: 所有模型的失败原因汇总 }，交由调用方降级处理并透出错误信息。
 */
async function aiClassifySpam(env, text) {
    if (!env.AI) return { error: "AI binding 未绑定" };
    const errors = [];
    for (const model of CONFIG.AI_MODELS) {
        try {
            const result = await env.AI.run(model, {
                messages: [
                    {
                        role: "system",
                        content: "你是 Telegram 客服机器人的消息安全审核助手，判断用户发来的私聊消息是否属于垃圾广告、引流推广、诈骗或色情骚扰。\n\n" +
                            "判定为垃圾（spam=true）：\n" +
                            "- 推广话术本身：提及兼职刷单、返利、宝妈兼职、带你赚钱、日入过万、稳赚等，即使没有留联系方式也算\n" +
                            "- 引流：微信号/QQ号/手机号/t.me链接/要求加群或私聊\n" +
                            "- 赌博、色情、虚拟币投资、贷款、代开发票等违法或灰色推广\n" +
                            "- 消息的主旨是在推销、招揽或撒网\n\n" +
                            "判定为正常（spam=false）：\n" +
                            "- 咨询产品、价格、售后等业务问题\n" +
                            "- 正常问候和闲聊\n" +
                            "- 用户陈述自己被骗的经历（如\"我之前刷单被骗了，想咨询怎么追回\"）\n\n" +
                            "宁枉勿纵：拿不准时倾向判 spam=true。\n" +
                            "只输出 JSON，不要输出其他文字，格式：{\"spam\": true, \"reason\": \"简短原因\"} 或 {\"spam\": false, \"reason\": \"\"}"
                    },
                    { role: "user", content: text.slice(0, 500) }
                ],
                // 注意：glm-4.7-flash 是推理模型，预算需覆盖思维链+正文；
                // max_tokens 已废弃（官方要求改用 max_completion_tokens），预算过小会导致正文为空
                max_completion_tokens: 500
            });
            // 兼容不同模型的返回结构（response 或 result.response）
            const raw = String(
                (result && (result.response ?? (result.result && result.result.response))) || ""
            ).trim();
            const match = raw.match(/\{[\s\S]*\}/);
            if (!match) {
                // 透出原始返回结构，便于定位字段差异或 token 耗尽问题
                const dump = raw ? raw.slice(0, 60) : JSON.stringify(result).slice(0, 150);
                errors.push(`${model} 响应无法解析: ${dump}`);
                continue;
            }
            const parsed = JSON.parse(match[0]);
            return { spam: !!parsed.spam, reason: parsed.reason || "" };
        } catch (e) {
            errors.push(`${model}: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
        }
    }
    return { error: errors.join(" | ") || "AI 无响应" };
}

/**
 * 统一过滤入口：
 * - 评分 >= FILTER_BLOCK_SCORE  → block（拦截 + 警告 + 计次）
 * - 评分 >= FILTER_GRAY_SCORE   → AI 仲裁：判垃圾则 block，判正常则 pass，AI 不可用则 flag（转发但提醒管理员）
 * - 其他                        → pass
 */
async function filterMessage(msg, env) {
    const signals = analyzeContentSignals(msg);

    if (signals.score >= CONFIG.FILTER_BLOCK_SCORE) {
        return {
            action: "block",
            reasons: signals.reasons.length ? signals.reasons : ["命中垃圾内容特征"]
        };
    }

    if (signals.score >= CONFIG.FILTER_GRAY_SCORE && signals.text) {
        const ai = await aiClassifySpam(env, signals.text);
        if (ai && ai.error === undefined) {
            if (ai.spam) {
                return { action: "block", reasons: [ai.reason || "AI 判定为广告/垃圾内容"] };
            }
            return { action: "pass", reasons: [] };
        }
        // AI 不可用：返回 flag（转发但提醒管理员），并携带失败原因
        return { action: "flag", reasons: signals.reasons, aiError: (ai && ai.error) || "AI 仲裁未生效" };
    }

    return { action: "pass", reasons: signals.reasons };
}

// ---------------- 辅助函数 ----------------

/**
 * 【修复 #8】批量清理命令处理函数（优化并发性能）
 *
 * 功能说明：
 * 1. 检查所有用户的话题记录
 * 2. 找出话题ID已不存在（被删除）的用户
 * 3. 删除这些用户的KV存储记录和验证状态
 * 4. 让他们下次发消息时重新验证并创建新话题
 *
 * 使用场景：
 * - 管理员手动删除了多个用户话题后
 * - 需要批量重置这些用户的状态
 *
 * @param {number} threadId - 当前话题ID（通常在General话题中调用）
 * @param {object} env - 环境变量对象
 */
async function handleCleanupCommand(threadId, env) {
    const lockKey = "cleanup:lock";
    const locked = await env.TOPIC_MAP.get(lockKey);
    if (locked) {
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: "⏳ **已有清理任务正在运行，请稍后再试。**",
            parse_mode: "Markdown"
        }, threadId));
        return;
    }

    await env.TOPIC_MAP.put(lockKey, "1", { expirationTtl: CONFIG.CLEANUP_LOCK_TTL_SECONDS });

    // 发送处理中的消息
    await tgCall(env, "sendMessage", withMessageThreadId({
        chat_id: env.SUPERGROUP_ID,
        text: "🔄 **正在扫描需要清理的用户...**",
        parse_mode: "Markdown"
    }, threadId));

    let cleanedCount = 0;
    let errorCount = 0;
    const cleanedUsers = [];
    let scannedCount = 0;

    try {
        // 逐页扫描，避免一次性拉取全部 keys 导致超时/内存膨胀
        let cursor = undefined;
        do {
            const result = await env.TOPIC_MAP.list({ prefix: "user:", cursor });
            const names = (result.keys || []).map(k => k.name);
            scannedCount += names.length;

            // 批量并发处理（限制并发数）
            for (let i = 0; i < names.length; i += CONFIG.CLEANUP_BATCH_SIZE) {
                const batch = names.slice(i, i + CONFIG.CLEANUP_BATCH_SIZE);

                const results = await Promise.allSettled(
                    batch.map(async (name) => {
                        const rec = await safeGetJSON(env, name, null);
                    if (!rec || !rec.thread_id) return null;

                    const userId = name.slice(5);
                    const topicThreadId = rec.thread_id;

                    // 检测话题是否存在：尝试向话题发送测试消息
                    const probe = await probeForumThread(env, topicThreadId, {
                        userId,
                        reason: "cleanup_check",
                        doubleCheckOnMissingThreadId: false
                    });

                    // cleanup 要求更保守：仅在明确缺失/重定向时清理，避免误删有效记录
                    if (probe.status === "redirected" || probe.status === "missing") {
                            await env.TOPIC_MAP.delete(name);
                            await env.TOPIC_MAP.delete(`verified:${userId}`);
                            await env.TOPIC_MAP.delete(`thread:${topicThreadId}`);

                            return {
                                userId,
                                threadId: topicThreadId,
                                title: rec.title || "未知"
                            };
                    } else if (probe.status === "probe_invalid") {
                        Logger.warn('cleanup_probe_invalid_message', {
                            userId,
                            threadId: topicThreadId,
                            errorDescription: probe.description
                        });
                    } else if (probe.status === "unknown_error") {
                        Logger.warn('cleanup_probe_failed_unknown', {
                            userId,
                            threadId: topicThreadId,
                            errorDescription: probe.description
                        });
                    } else if (probe.status === "missing_thread_id") {
                        Logger.warn('cleanup_probe_missing_thread_id', { userId, threadId: topicThreadId });
                    }

                    return null;
                })
            );

            // 处理结果
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    cleanedCount++;
                    cleanedUsers.push(result.value);
                    Logger.info('cleanup_user', {
                        userId: result.value.userId,
                        threadId: result.value.threadId
                    });
                } else if (result.status === 'rejected') {
                    errorCount++;
                    Logger.error('cleanup_batch_error', result.reason);
                }
            });

                // 防止速率限制
                if (i + CONFIG.CLEANUP_BATCH_SIZE < names.length) {
                    await new Promise(r => setTimeout(r, 600));
                }
            }

            cursor = result.list_complete ? undefined : result.cursor;

            // 在分页之间让出时间片，降低单次执行压力
            if (cursor) {
                await new Promise(r => setTimeout(r, 200));
            }
        } while (cursor);

        // 生成并发送清理报告
        let reportText = `✅ **清理完成**\n\n`;
        reportText += `📊 **统计信息**\n`;
        reportText += `- 扫描用户数: ${scannedCount}\n`;
        reportText += `- 已清理用户数: ${cleanedCount}\n`;
        reportText += `- 错误数: ${errorCount}\n\n`;

        if (cleanedCount > 0) {
            reportText += `🗑️ **已清理的用户** (话题已删除):\n`;
            for (const user of cleanedUsers.slice(0, CONFIG.MAX_CLEANUP_DISPLAY)) {
                reportText += `- UID: \`${user.userId}\` | 话题: ${user.title}\n`;
            }
            if (cleanedUsers.length > CONFIG.MAX_CLEANUP_DISPLAY) {
                reportText += `\n...(还有 ${cleanedUsers.length - CONFIG.MAX_CLEANUP_DISPLAY} 个用户)\n`;
            }
            reportText += `\n💡 这些用户下次发消息时将重新进行人机验证并创建新话题。`;
        } else {
            reportText += `✨ 没有发现需要清理的用户记录。`;
        }

        Logger.info('cleanup_completed', {
            cleanedCount,
            errorCount,
            totalUsers: scannedCount
        });

        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: reportText,
            parse_mode: "Markdown"
        }, threadId));

    } catch (e) {
        Logger.error('cleanup_failed', e, { threadId });
        await tgCall(env, "sendMessage", withMessageThreadId({
            chat_id: env.SUPERGROUP_ID,
            text: `❌ **清理过程出错**\n\n错误信息: \`${e.message}\``,
            parse_mode: "Markdown"
        }, threadId));
    } finally {
        await env.TOPIC_MAP.delete(lockKey);
    }
}

// ---------------- 其他辅助函数 ----------------

// 为话题建立 thread->user 映射，避免管理员命令时全量 KV 反查
async function createTopic(from, key, env, userId) {
    const title = buildTopicTitle(from);
    if (!env.SUPERGROUP_ID.toString().startsWith("-100")) throw new Error("SUPERGROUP_ID必须以-100开头");
    const res = await tgCall(env, "createForumTopic", { chat_id: env.SUPERGROUP_ID, name: title });
    if (!res.ok) throw new Error(`创建话题失败: ${res.description}`);
    const rec = { thread_id: res.result.message_thread_id, title, closed: false };
    await env.TOPIC_MAP.put(key, JSON.stringify(rec));
    if (userId) {
        await env.TOPIC_MAP.put(`thread:${rec.thread_id}`, String(userId));
    }
    return rec;
}

// 【修复 #2】更新话题状态 - 修复异步操作未等待
async function updateThreadStatus(threadId, isClosed, env) {
    try {
        const mappedUser = await env.TOPIC_MAP.get(`thread:${threadId}`);
        if (mappedUser) {
            const userKey = `user:${mappedUser}`;
            const rec = await safeGetJSON(env, userKey, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                await env.TOPIC_MAP.put(userKey, JSON.stringify(rec));
                Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: 1 });
                return;
            }

            // 映射失效：清理后降级全量扫描
            await env.TOPIC_MAP.delete(`thread:${threadId}`);
        }

        const allKeys = await getAllKeys(env, "user:");
        const updates = [];

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && Number(rec.thread_id) === Number(threadId)) {
                rec.closed = isClosed;
                updates.push(env.TOPIC_MAP.put(name, JSON.stringify(rec)));
            }
        }

        await Promise.all(updates);
        Logger.info('thread_status_updated', { threadId, isClosed, updatedCount: updates.length });
    } catch (e) {
        Logger.error('thread_status_update_failed', e, { threadId, isClosed });
        throw e;
    }
}

// 改进的话题标题构建（清理特殊字符）
function buildTopicTitle(from) {
  const firstName = (from.first_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);
  const lastName = (from.last_name || "").trim().substring(0, CONFIG.MAX_NAME_LENGTH);

  // 清理 username
  let username = "";
  if (from.username) {
      username = from.username
          .replace(/[^\w]/g, '')  // 只保留字母数字下划线
          .substring(0, 20);
  }

  // 移除控制字符和换行符
  const cleanName = (firstName + " " + lastName)
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  const name = cleanName || "User";
  const usernameStr = username ? ` @${username}` : "";

  // Telegram 话题标题最大长度为 128 字符
  const title = (name + usernameStr).substring(0, CONFIG.MAX_TITLE_LENGTH);

  return title;
}

// 改进的 Telegram API 调用（添加超时和 HTTPS 强制）
async function tgCall(env, method, body, timeout = CONFIG.API_TIMEOUT_MS) {
  let base = env.API_BASE || "https://api.telegram.org";

  // 【修复 #20】强制 HTTPS
  if (base.startsWith("http://")) {
      Logger.warn('api_http_upgraded', { originalBase: base });
      base = base.replace("http://", "https://");
  }

  // 验证 URL 格式
  try {
      new URL(`${base}/test`);
  } catch (e) {
      Logger.error('api_base_invalid', e, { base });
      base = "https://api.telegram.org";
  }

  // 【修复 #13】添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
      const resp = await fetch(`${base}/bot${env.BOT_TOKEN}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!resp.ok && resp.status >= 500) {
          Logger.warn('telegram_api_server_error', {
              method,
              status: resp.status
          });
      }

      const result = await resp.json();

      // 记录速率限制
      if (!result.ok && result.description && result.description.includes('Too Many Requests')) {
          const retryAfter = result.parameters?.retry_after || 5;
          Logger.warn('telegram_api_rate_limit', {
              method,
              retryAfter
          });
      }

      return result;
  } catch (e) {
      clearTimeout(timeoutId);

      if (e.name === 'AbortError') {
          Logger.error('telegram_api_timeout', e, { method, timeout });
          return { ok: false, description: 'Request timeout' };
      }

      Logger.error('telegram_api_failed', e, { method });
      throw e;
  }
}

async function handleMediaGroup(msg, env, ctx, { direction, targetChat, threadId }) {
    const groupId = msg.media_group_id;
    const key = `mg:${direction}:${groupId}`;
    const item = extractMedia(msg);
    if (!item) {
        await tgCall(env, "copyMessage", withMessageThreadId({
            chat_id: targetChat,
            from_chat_id: msg.chat.id,
            message_id: msg.message_id
        }, threadId));
        return;
    }
    let rec = await safeGetJSON(env, key, null);
    if (!rec) rec = { direction, targetChat, threadId: (threadId === null ? undefined : threadId), items: [], last_ts: Date.now() };
    rec.items.push({ ...item, msg_id: msg.message_id });
    rec.last_ts = Date.now();
    await env.TOPIC_MAP.put(key, JSON.stringify(rec), { expirationTtl: CONFIG.MEDIA_GROUP_EXPIRE_SECONDS });
    ctx.waitUntil(delaySend(env, key, rec.last_ts));
}

// 【修复 #15, #19】改进的媒体提取（支持更多类型，不修改原数组）
function extractMedia(msg) {
    // 图片
    if (msg.photo && msg.photo.length > 0) {
        const highestResolution = msg.photo[msg.photo.length - 1];  // 不使用 pop()
        return {
            type: "photo",
            id: highestResolution.file_id,
            cap: msg.caption || ""
        };
    }

    // 视频
    if (msg.video) {
        return {
            type: "video",
            id: msg.video.file_id,
            cap: msg.caption || ""
        };
    }

    // 文档
    if (msg.document) {
        return {
            type: "document",
            id: msg.document.file_id,
            cap: msg.caption || ""
        };
    }

    // 音频
    if (msg.audio) {
        return {
            type: "audio",
            id: msg.audio.file_id,
            cap: msg.caption || ""
        };
    }

    // 动图
    if (msg.animation) {
        return {
            type: "animation",
            id: msg.animation.file_id,
            cap: msg.caption || ""
        };
    }

    // 语音和视频消息不支持 media group
    return null;
}

// 【修复 #21】实现媒体组清理
async function flushExpiredMediaGroups(env, now) {
    try {
        const prefix = "mg:";
        const allKeys = await getAllKeys(env, prefix);
        let deletedCount = 0;

        for (const { name } of allKeys) {
            const rec = await safeGetJSON(env, name, null);
            if (rec && rec.last_ts && (now - rec.last_ts > 300000)) { // 超过 5 分钟
                await env.TOPIC_MAP.delete(name);
                deletedCount++;
            }
        }

        if (deletedCount > 0) {
            Logger.info('media_groups_cleaned', { deletedCount });
        }
    } catch (e) {
        Logger.error('media_group_cleanup_failed', e);
    }
}

// 【修复 #12, #28】改进媒体组延迟发送
async function delaySend(env, key, ts) {
    await new Promise(r => setTimeout(r, CONFIG.MEDIA_GROUP_DELAY_MS));

    const rec = await safeGetJSON(env, key, null);

    if (rec && rec.last_ts === ts) {
        // 验证媒体数组
        if (!rec.items || rec.items.length === 0) {
            Logger.warn('media_group_empty', { key });
            await env.TOPIC_MAP.delete(key);
            return;
        }

        const media = rec.items.map((it, i) => {
            if (!it.type || !it.id) {
                Logger.warn('media_group_invalid_item', { key, item: it });
                return null;
            }
            // 【修复 #28】限制 caption 长度
            const caption = i === 0 ? (it.cap || "").substring(0, 1024) : "";
            return { 
                type: it.type,
                media: it.id,
                caption
            };
        }).filter(Boolean);  // 过滤掉无效项

        if (media.length > 0) {
            try {
                const result = await tgCall(env, "sendMediaGroup", withMessageThreadId({
                    chat_id: rec.targetChat,
                    media
                }, rec.threadId));

                if (!result.ok) {
                    Logger.error('media_group_send_failed', result.description, {
                        key,
                        mediaCount: media.length
                    });
                } else {
                    Logger.info('media_group_sent', {
                        key,
                        mediaCount: media.length,
                        targetChat: rec.targetChat
                    });
                }
            } catch (e) {
                Logger.error('media_group_send_exception', e, { key });
            }
        }

        await env.TOPIC_MAP.delete(key);
    }
}
