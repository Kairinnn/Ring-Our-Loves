window.addEventListener('error', (e) => {
    document.title = '💀 ' + e.message + ' | 行' + (e.lineno || '?');
});
window.addEventListener('unhandledrejection', (e) => {
    document.title = '💀 Promise: ' + (e.reason?.message || e.reason || '未知');
});

import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';
import { getChatCompletionModel } from '../../../openai.js';

const extensionName = 'Ring_Our_Luv';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const ROL_VERSION = '0.6.10';// ┣━━🩷━━┫
let rolAbortController = null; // ❤︎ 全局 AbortController（AIService + UIController 共用）❤︎
if (localStorage.getItem('rol_version') !== ROL_VERSION) {
    localStorage.setItem('rol_version', ROL_VERSION);
    location.reload(true);
}

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                  🩷 存储模块 🩷                       ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const Storage = (() => {
    function initSettings() {
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {
                memories: [],
                chatlogs: [],
                fruits: [],   // ❤︎ 果子也搬进 extension_settings，跟记忆一样走服务器持久化，不再走易丢的 localStorage ❤︎
                letters: [],  // ❤︎ 信件同理：搬进 extension_settings 走服务器持久化，每封带 scope 标明归属对话，不再走易丢的 localStorage ❤︎
                config: {
                    presetName: '',
                    autoInject: true,
                    maxInjectCount: 3,
                    summaryPrompt: '',
                    // ❤︎ 时间检测 + 模型版本注入 ❤︎
                    enableTimeAware: true,          // 时间检测开关
                    enableModelDetect: true,        // 模型检测开关（与时间检测独立）
                    hideVersionBadge: false,        // 隐藏前端版本号显示
                    currentModel: '',               // 当前模型
                    currentChannel: '',             // 当前渠道
                    lastModel: '',                  // 上次模型
                    lastChannel: ''                 // 上次渠道
                }
            };
            saveSettingsDebounced();
        }
        return extension_settings[extensionName];
    }

    function getMemories() {
        return extension_settings[extensionName]?.memories || [];
    }

    function generateId() {
        return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }
    /* ⬇️┅💌存入记忆/┅┅╗ */
    // ❤︎ addMemory: 确保数据正确写入并保存 ❤︎
    function addMemory(memoryData) {
        const settings = extension_settings[extensionName];
        const now = new Date().toISOString();
        const today = new Date().toISOString().slice(0, 10);
        const newMemory = {
            id: generateId(),
            title: memoryData.title || '未命名恋果',
            author: memoryData.author || 'claude',
            date: memoryData.date || today,
            triggers: memoryData.triggers || [],
            tags: memoryData.tags || [],
            mood: memoryData.mood || '',
            summary: memoryData.summary || '',
            letter: memoryData.letter || '',
            versions: [
                {
                    summary: memoryData.summary || '',
                    letter: memoryData.letter || '',
                    timestamp: now,
                    type: 'original'
                }
            ],
            replies: [],
            enabled: true,
            created: now,
            updated: now
        };
        settings.memories.unshift(newMemory); // unshift: 新条目出现在列表顶部
        console.log('[RingOurLuv]🍎 addMemory - 保存恋果~:', JSON.stringify(newMemory, null, 2));
        saveSettingsDebounced();
        return newMemory;
    }
    /* ╚┅┅/ 💌存入记忆 /┅┅═╝ */

    /* ⬇️┅❇️更新记忆/┅┅╗ */
    function updateMemory(id, updates, skipVersion = false) {
        const settings = extension_settings[extensionName];
        const index = settings.memories.findIndex(m => m.id === id);
        if (index === -1) return null;

        const memory = settings.memories[index];

        if (!skipVersion && (
            (updates.summary && updates.summary !== memory.summary) ||
            (updates.letter && updates.letter !== memory.letter)
        )) {
            memory.versions.push({
                summary: updates.summary || memory.summary,
                letter: updates.letter || memory.letter,
                timestamp: new Date().toISOString(),
                type: 'manual_edit'
            });
        }

        Object.assign(memory, updates);
        memory.updated = new Date().toISOString();
        settings.memories[index] = memory;

        console.log('[RingOurLuv]🍎 updateMemory - 更新恋果~:', JSON.stringify(memory, null, 2));
        saveSettingsDebounced();
        return memory;
    }
    /* ╚┅┅/ ❇️更新记忆 /┅┅═╝ */

    // ❤︎ 删除记忆 ❤︎
    function deleteMemory(id) {
        const settings = extension_settings[extensionName];
        settings.memories = settings.memories.filter(m => m.id !== id);
        saveSettingsDebounced();
    }

    /* ⬇️┅💬 聊天本：收录的聊天记录，存法跟 memories 一套，走 extension_settings 持久化（不走易丢的 localStorage）/┅┅╗ */
    function getChatlogs() {
        return extension_settings[extensionName]?.chatlogs || [];
    }
    function addChatlog(logData) {
        const settings = extension_settings[extensionName];
        if (!Array.isArray(settings.chatlogs)) settings.chatlogs = [];   // 老用户 settings 没这字段时兜底
        const now = new Date().toISOString();
        const newLog = {
            id: 'log_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            title: logData.title || '未命名聊天',
            date: logData.date || now.slice(0, 10),
            count: (logData.messages || []).length,
            messages: logData.messages || [],
            created: now
        };
        settings.chatlogs.unshift(newLog);   // 新收录的排最前
        saveSettingsDebounced();
        return newLog;
    }
    function deleteChatlog(id) {
        const settings = extension_settings[extensionName];
        if (!Array.isArray(settings.chatlogs)) return;
        settings.chatlogs = settings.chatlogs.filter(l => l.id !== id);
        saveSettingsDebounced();
    }
    function updateChatlog(id, updates) {
        const settings = extension_settings[extensionName];
        if (!Array.isArray(settings.chatlogs)) return null;
        const log = settings.chatlogs.find(l => l.id === id);
        if (!log) return null;
        Object.assign(log, updates);
        if (updates.messages) log.count = updates.messages.length;   // 条数跟着改
        saveSettingsDebounced();
        return log;
    }
    /* ╚┅┅/ 💬 聊天本 /┅┅═╝ */

    // ❤︎ 添加重写版本：每次AI重写都调用，记录版本历史 ❤︎
    function addRewriteVersion(id, letter, content, entryData = {}) {
        const settings = extension_settings[extensionName];
        const memory = settings.memories.find(m => m.id === id);
        if (!memory) return null;

        memory.versions.push({
            letter: letter,
            content: content,
            title: entryData.title || memory.title,
            mood: entryData.mood || memory.mood,
            triggers: entryData.triggers || memory.triggers,
            timestamp: new Date().toISOString(),
            type: 'ai_rewrite'
        });

        memory.letter = letter;
        memory.content = content;
        if (entryData.title) memory.title = entryData.title;
        if (entryData.mood) memory.mood = entryData.mood;
        if (entryData.triggers?.length) memory.triggers = entryData.triggers;

        saveSettingsDebounced();
        return memory;
    }

    // ❤︎ 回滚到指定版本 ❤︎
    function rollbackVersion(id, versionIndex) {
        const settings = extension_settings[extensionName];
        const memory = settings.memories.find(m => m.id === id);
        if (!memory || !memory.versions[versionIndex]) return null;

        const v = memory.versions[versionIndex];
        memory.letter = v.letter || '';
        memory.content = v.content || '';
        if (v.title) memory.title = v.title;
        if (v.mood) memory.mood = v.mood;
        if (v.triggers) memory.triggers = v.triggers;

        saveSettingsDebounced();
        return memory;
    }

    function getConfig() {
        return extension_settings[extensionName]?.config || {};
    }

    function updateConfig(configUpdates) {
        const settings = extension_settings[extensionName];
        Object.assign(settings.config, configUpdates);
        saveSettingsDebounced();
    }

    return {
        initSettings, getMemories, addMemory, updateMemory,
        deleteMemory, addRewriteVersion, rollbackVersion,
        getChatlogs, addChatlog, deleteChatlog, updateChatlog,
        getConfig, updateConfig
    };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                 🩷 系统楼层模块 🩷                    ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
/* ➤━━━━━━━ ▍⚙️版本注入 + 时间感知⚙️ ▍━━━━━━━┓ */

/* ⬇️┅🧡模型名映射表/┅┅╗ */
function mapModelName(raw) {
    const s = String(raw).toLowerCase();
    const rules = [
        [/mythos/, 'Mythos'],
        [/4[.\-_]?8/, '4.8 Opus'],
        [/4[.\-_]?7/, '4.7'],
        [/opus.*4[.\-_]?6|4[.\-_]?6.*opus/, '4.6 Opus'],
        [/sonnet.*4[.\-_]?6|4[.\-_]?6.*sonnet/, '4.6 Sonnet'],
        [/4[.\-_]?6/, '4.6'],
        [/sonnet.*4[.\-_]?5|4[.\-_]?5.*sonnet/, '4.5 Sonnet'],
        [/opus.*4[.\-_]?5|4[.\-_]?5.*opus/, '4.5 Opus'],
        [/4[.\-_]?5/, '4.5'],
        [/4[.\-_]?1/, '4.1 Opus'],
        [/opus[.\-_]?4|4*opus/, '4 Opus'],
        [/opus[.\-_]?4|4.*opus/, '4.0 Opus'],
        [/sonnet.*3[.\-_]?7|3[.\-_]?7.*sonnet/, '3.7 Sonnet'],
        [/3[.\-_]?7/, '3.7'],
        [/3[.\-_]?5/, '3.5 Sonnet'],
        // ❤ 兜底：只写了 opus/sonnet/haiku 没带版本号的也认出来 ❤
        [/opus/, 'Opus'],
        [/sonnet/, 'Sonnet'],
        [/haiku/, 'Haiku'],
    ];
    if (/thinking/.test(s)) {
        for (const [re, name] of rules) if (re.test(s)) return name + ' thinking';
    }
    for (const [re, name] of rules) if (re.test(s)) return name;
    return raw;   // 没匹配上原样返回，至少不丢信息
}

/* ⬇️┅🧡读当前模型：优先 getChatCompletionModel，兜底从 DOM/┅┅╗ */
function rolReadModel() {
    try {
        const m = getChatCompletionModel();
        if (m) return String(m).trim();
    } catch (_) { /* 某些版本/模式取不到，往下兜底 */ }
    const el = document.getElementById('custom_model_id');
    return el ? (el.value || '').trim() : '';
}

/* ⬇️┅🧡版本注入：CHAT_COMPLETION_PROMPT_READY 时把版本常驻进上下文，仅在模型/渠道变化时更新/┅┅╗ */
let _rolLastInjectedVersion = null;   // 记上次注入的 label，没变就不动，避免渠道死了反复插
const ROL_VERSION_KEY = 'rol_version';

function injectVersionPrompt() {
    const ctx = SillyTavern.getContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
    const cfg = Storage.getConfig();

    // ❤ 模型检测关掉 → 清空注入并返回 ❤
    if (cfg.enableModelDetect === false) {
        removeVersionInject();
        return;
    }

    const raw = rolReadModel();
    if (!raw) return;
    const pretty = mapModelName(raw);
    // ❤ 渠道按「当前模型」从 channels map 读，和 initVersionBadge / startModelWatcher 对齐 ❤
    //   之前这里读 cfg.currentChannel，而保存渠道时只写了 channels[模型]、没动 currentChannel，
    //   于是流式一结束、injectVersionPrompt 一跑，又拿旧 currentChannel 把标签刷回上一家渠道（只活 0.5 轮的根因）
    const channels = cfg.channels || {};
    const channel = (channels[raw] || cfg.currentChannel || '').trim();
    const label = channel ? `${pretty}·${channel}` : pretty;

    // ❤ 实时刷新卡片版本号显示 ❤
    renderVersionBadge(pretty, channel);

    // ❤ 只在「模型/渠道变化」时更新注入内容，没变就不动 ❤
    if (label === _rolLastInjectedVersion) return;
    const prevLabel = _rolLastInjectedVersion;   // 切换前的 label（首次加载为 null）
    _rolLastInjectedVersion = label;

    // ❤ 通用版文案：常驻的当前版本说明 ❤
    const baseText = `[SYS|${Date.now()}] model: Claude ${pretty}${channel ? ` | channel: ${channel}` : ''}`;

    // ❤ 判断是否为本会话内的真实切换（首次加载不算）❤
    const lastPretty = (cfg.lastModel || '').trim();
    const isSwitch = prevLabel != null && prevLabel !== '' && lastPretty && lastPretty !== pretty;

    let injectText;
    if (isSwitch) {
        injectText = `[SYS|${Date.now()}] MODEL_SWITCH: ${lastPretty} -> ${pretty}\n${baseText}`;
        _rolLastInjectedVersion = null;  // 强制下一轮重新注入
    } else {
        injectText = baseText;
    }

    // ❤ position=1(IN_CHAT) + depth=1 → 钉在「最后一条 user 消息之前」做永久锚点 ❤
    //    （ephemeral 注入不写进 chat 数组，/hide 隐藏楼层抹不掉它，性质同世界书固定深度）
    ctx.setExtensionPrompt(ROL_VERSION_KEY, injectText, 1, 1);

    // ❤ 顺手把 currentChannel 同步成「当前模型的渠道」，别处再读它也不会读到过期值 ❤
    Storage.updateConfig({ currentModel: raw, lastModel: pretty, lastChannel: channel, currentChannel: channel });

    console.log('[RingOurLuv] 🧡 版本注入更新:', label);
}

// ❤︎ 删除入口：调 setExtensionPrompt 传空清掉 ❤︎
function removeVersionInject() {
    const ctx = SillyTavern.getContext();
    if (ctx && typeof ctx.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(ROL_VERSION_KEY, '', 1, 0);
    }
    _rolLastInjectedVersion = '';
}

/* ⬇️┅⏰️时间感知/┅┅╗ */
/* ❤ 社交软件式相对时间：
   当天 → 14:30
   昨天 → 昨天14:30
   前天 → 前天14:30
   今年更早 → 6月8日
   跨年 → 25年6月8日14时30分        ❤ */
function fmtRelativeTime(timestamp) {
    const now = new Date();
    const then = new Date(timestamp);
    const h = String(then.getHours()).padStart(2, '0');
    const m = String(then.getMinutes()).padStart(2, '0');
    const time = `${h}:${m}`;

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const thatDay = new Date(then.getFullYear(), then.getMonth(), then.getDate());
    const diffDays = Math.floor((today - thatDay) / 86400000);

    if (diffDays === 0) return time;            // 当天：14:30
    if (diffDays === 1) return `昨天${time}`;    // 昨天14:30
    if (diffDays === 2) return `前天${time}`;    // 前天14:30
    if (then.getFullYear() === now.getFullYear())
        return `${then.getMonth() + 1}月${then.getDate()}日`;          // 今年更早：6月8日
    const yy = String(then.getFullYear()).slice(-2);
    return `${yy}年${then.getMonth() + 1}月${then.getDate()}日${h}时${m}分`;  // 跨年：25年6月8日14时30分
}

/* ⬇️┅⏰️把毫秒间隔格式化成人话/┅┅╗ */
function fmtInterval(ms) {
    const min = Math.floor(ms / 60000);
    if (min < 1) return '不到 1 分钟';
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    if (h < 24) {
        const rm = min % 60;
        return rm ? `${h} 小时 ${rm} 分钟` : `${h} 小时`;
    }
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d} 天 ${rh} 小时` : `${d} 天`;
}

/* ⬇️┅⏰️刷新所有时间戳的时态（全局函数：切回页面 / 跨天时重算「昨天/前天」等相对文案）/┅┅╗ */
function refreshAllTimestamps() {
    document.querySelectorAll('.rol-msg-time[data-rol-ts]').forEach(el => {
        el.textContent = fmtRelativeTime(Number(el.dataset.rolTs));
    });
    document.querySelectorAll('.rol-time-divider[data-rol-ts]').forEach(el => {
        el.textContent = fmtRelativeTime(Number(el.dataset.rolTs));
    });
}

/* ⬇️┅⏰️前端时间分隔线：createElement 独立 div，绝不用 addOneMessage/┅┅╗ */
// ❤ nowTs 必须作为参数传进来：之前漏传导致函数内引用未定义变量 → ReferenceError，分割线整条挂掉 ❤
function appendTimeDivider(text, mesId, nowTs) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    if (chatEl.querySelector(`.rol-time-divider[data-rol-for="${mesId}"]`)) return; // 防重复
    const div = document.createElement('div');
    div.className = 'rol-time-divider';
    div.dataset.rolFor = String(mesId);
    div.dataset.rolTs = String(nowTs);
    div.textContent = text;

    const target = chatEl.querySelector(`.mes[mesid="${mesId}"]`);
    if (target) chatEl.insertBefore(div, target);   // 落在这条新消息上方
    else chatEl.appendChild(div);
}

/* ⬇️┅⏰️每条 user 消息自带的小时间戳：包成独立 div(.rol-msg-time)，落在「自己」气泡正上方/┅┅╗ */
// ❤ 跟上面的「间隔分割线 .rol-time-divider」完全两码事：这个是每条都带的小药丸 ❤
// ❤ 带重试 + user 校验：MESSAGE_SENT 触发时 DOM 可能还没更新完 / mesId 对不上，
//   直接挂会挂错到 character 方消息上。所以：找不到目标 or 目标不是 user 消息 →
//   每 100ms 重试，最多 5 次；5 次还不行就放弃（console.warn）❤
// ❤ nowTs 同样必须作为参数传进来，否则 span.dataset.rolTs 引用未定义变量 → 整条时间戳挂掉 ❤
function appendMsgTimestamp(text, mesId, nowTs, attempt = 0) {
    const MAX_RETRY = 5;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const target = chatEl.querySelector(`.mes[mesid="${mesId}"]`);

    // ❤ 校验：目标必须存在，且必须是「user 消息」（is_user="true" / .is_user class），
    //   不是 user 消息绝不挂，防止挂到 character 方气泡上 ❤
    const isUserMes = !!target &&
        (target.getAttribute('is_user') === 'true' || target.classList.contains('is_user'));

    if (!isUserMes) {
        if (attempt < MAX_RETRY) {
            // ❤ DOM 还没好 / 还没标成 user → 100ms 后再试 ❤
            setTimeout(() => appendMsgTimestamp(text, mesId, nowTs, attempt + 1), 100);
        } else {
            console.warn(`[RingOurLuv] ⏰️ 时间戳挂载放弃：找不到 mesId=${mesId} 的 user 消息 DOM（已重试 ${MAX_RETRY} 次）`);
        }
        return;
    }

    if (target.querySelector('.rol-msg-time')) return;     // 防重复
    // ❤ 塞进 .mes_block 顶部，让小药丸贴在「这条消息气泡」正上方 ❤
    const block = target.querySelector('.mes_block') || target;
    const span = document.createElement('div');
    span.className = 'rol-msg-time';
    span.dataset.rolTs = String(nowTs);
    span.textContent = text;
    block.insertBefore(span, block.firstChild);
}




/* ⬇️┅⏰️user发消息：prompt注入间隔 + ≥20分钟加分隔线 + 打时间戳/┅┅╗ */
eventSource.on(event_types.MESSAGE_SENT, () => {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    const lastMsg = chat[chat.length - 1];
    if (!lastMsg || !lastMsg.is_user) {
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        return;
    }
    const cfg = Storage.getConfig();
    const nowTs = Date.now();

    // ❤ 时间检测开关 ❤
    if (cfg.enableTimeAware !== false) {
        const prevUser = [...chat].slice(0, -1).reverse()
            .find(m => m.is_user && m.extra && m.extra.rol_timestamp);
        const interval = prevUser ? nowTs - prevUser.extra.rol_timestamp : null;

        // ❤ 1. prompt 层注入「距上条间隔多久」→ depth=1 落在 user 消息之前 ❤
        //    （语义：是「沉默了 n 久之后才说了这句」，不是「说完这句又消失 n 久」）
        if (interval != null && typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt('rol_time_interval',
                `[SYS|${Date.now()}] interval: ${fmtInterval(interval)}`, 1, 1);
        }


        // ❤ 2. 间隔≥20分钟才在前端加分隔线 ❤
        if (!prevUser || interval >= 20 * 60 * 1000) {
            const text = fmtRelativeTime(nowTs);
            const mesId = chat.length - 1;
            requestAnimationFrame(() => appendTimeDivider(text, mesId, nowTs));

        }
    }

    // ❤ 3. 给本条 user 消息打时间戳（后台时间感知用）❤
    lastMsg.extra = lastMsg.extra || {};
    lastMsg.extra.rol_timestamp = nowTs;

    // ❤ 4. 前端：给「本条 user 消息」自己的气泡正上方挂个小时间戳药丸 ❤
    if (cfg.enableTimeAware !== false) {
        const tsText = fmtRelativeTime(nowTs);
        const tsMesId = chat.length - 1;
        requestAnimationFrame(() => appendMsgTimestamp(tsText, tsMesId, nowTs));

    }

    if (typeof ctx.saveChat === 'function') ctx.saveChat();

});

/* ⬇️┅⏰️生成前注入「当前真实时间」/┅┅╗ */
function injectTimeContext() {
    const cfg = Storage.getConfig();
    if (cfg.enableTimeAware === false) return;   // 时间检测关掉就不注入
    const ctx = SillyTavern.getContext();
    const now = new Date();
    const mo = now.getMonth() + 1, d = now.getDate();
    const h = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const week = '日一二三四五六'[now.getDay()];
    // ❤ depth=1 → 跟版本/间隔注入一套，钉在「user 消息之前」做固定锚点 ❤
    //    （「现在几点」若飘在 user 发言之后，Claude 同样会读拧时序）
    ctx.setExtensionPrompt('rol_time_now',
        `[SYS|${Date.now()}] time: ${now.getFullYear()}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${h}:${mi} w${week}`, 1, 1);

}
/* ╚┅┅/ ⏰️时间感知 /┅┅═╝ */


/* ⬇️┅✨版本号显示：挂到聊天区「最新一条 assistant 消息」头像框上方/┅┅╗ */
// ❤ 只标最新一条，先清掉旧标签，不给历史消息逐条补，省性能 ❤
function renderVersionBadge(model, channel) {
    // 流式还在跑的时候不画
    if (document.querySelector('#chat .mes:last-child .mes_text .typing_indicator, #chat .mes:last-child.mes_streaming')) return;

    const cfg = Storage.getConfig();
    document.querySelectorAll('.rol-version-tag').forEach(el => el.remove());
    if (cfg.hideVersionBadge) return;
    if (!model) return;

    const msgs = document.querySelectorAll('#chat .mes[is_user="false"]');
    const lastMsg = msgs[msgs.length - 1];
    if (!lastMsg) return;

    // 插到消息块底部，文字下方
    const mesBlock = lastMsg.querySelector('.mes_block');
    if (!mesBlock) return;

    // ⚠️ 之前这里在 tag 声明之前就 mesBlock.appendChild(tag)，触发
    //    「Cannot access 'tag' before initialization」TDZ 报错，每次生成都抛；
    //    末尾那句还误写成了未定义的 mesBody。改成：先建好 tag，最后只 append 一次。
    const tag = document.createElement('div');
    tag.className = 'rol-version-tag';
    const text = channel ? `${model} · ${channel}` : model;
    tag.textContent = `✦ ${text}`;
    mesBlock.appendChild(tag);
}

// 页面加载时能读到模型就尝试渲染一次
function initVersionBadge() {
    const cfg = Storage.getConfig();
    const raw = rolReadModel() || (cfg.currentModel || '').trim();
    if (!raw) return;
    const channels = cfg.channels || {};
    renderVersionBadge(mapModelName(raw), (channels[raw] || '').trim());
}

/* ⬇️┅👁️监听酒馆模型切换 → 实时刷卡片版本号 + 同步显示框/┅┅╗ */
function startModelWatcher() {
    const el = document.getElementById('custom_model_id');
    if (!el) { setTimeout(startModelWatcher, 1000); return; }
    function refresh() {
        const raw = rolReadModel();
        if (!raw) return;
        const pretty = mapModelName(raw);
        const cfg = Storage.getConfig();
        const channels = cfg.channels || {};
        const channel = (channels[raw] || '').trim();
        renderVersionBadge(pretty, channel);
        const display = document.getElementById('rol-current-model');
        if (display) display.value = raw;        // 同步只读显示框
        if (raw !== cfg.currentModel) Storage.updateConfig({ currentModel: raw });
    }
    el.addEventListener('input', refresh);
    el.addEventListener('change', refresh);
    new MutationObserver(refresh).observe(el, { attributes: true, childList: true, subtree: true });
    refresh();
}

// ❤︎ 绑定 ❤︎
// ❤ 切回页面时刷新所有时间戳的时态 ❤
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAllTimestamps();
});
eventSource.on(event_types.GENERATION_STARTED, () => {
    injectTimeContext();
});
// ❤︎ 版本注入：绑生成前最后一刻的 CHAT_COMPLETION_PROMPT_READY ❤︎
if (event_types.CHAT_COMPLETION_PROMPT_READY) {
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, () => {
        injectVersionPrompt();
    });
}
/* ┗━━━━━━/ ⚙️版本注入 + 时间感知⚙️ /━━━━━━┛ */

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                  🩷 触发器模块 🩷                     ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
/* ➤━━━━━━━ ▍📡关键词触发注入系统📡 ▍━━━━━━━┓ */
const Trigger = (() => {
    const cooldownMap = new Map();  // 记录每颗恋果上次触发的轮数
    const COOLDOWN = 999;             // 冷却轮数
    let globalLastTriggerTurn = -999;
    const GLOBAL_COOLDOWN = 999;         // Rinn：触发一次即失效（我真的没招了）

    function detectTriggers(messageText, currentTurn) {
        console.log('[RingOurLuv] 🧊 冷却检查:', { currentTurn, globalLastTriggerTurn, diff: currentTurn - globalLastTriggerTurn });
        if (currentTurn - globalLastTriggerTurn < GLOBAL_COOLDOWN) return [];
        const memories = Storage.getMemories();
        const matched = [];
        for (const memory of memories) {
            if (!memory.enabled) continue;

            const lastTurn = cooldownMap.get(memory.id) || -999;
            if (currentTurn - lastTurn < COOLDOWN) continue;

            for (const trigger of memory.triggers) {
                if (!trigger) continue;
                let isMatch = false;
                if (trigger.startsWith('/') && trigger.endsWith('/')) {
                    try {
                        const regex = new RegExp(trigger.slice(1, -1), 'i');
                        isMatch = regex.test(messageText);
                    } catch (e) {
                        isMatch = messageText.toLowerCase().includes(trigger.toLowerCase());
                    }
                } else {
                    isMatch = messageText.toLowerCase().includes(trigger.toLowerCase());
                }
                if (isMatch) {
                    matched.push(memory);
                    cooldownMap.set(memory.id, currentTurn);
                    globalLastTriggerTurn = currentTurn;
                    break;
                }
            }
        }
        return matched;
    }

    function selectForInjection(matchedMemories) {
        const config = Storage.getConfig();
        return matchedMemories.slice(0, config.maxInjectCount || 3);
    }
    /* ⬇️┅❣️注入的prompt/┅┅╗ */
    function buildInjectionText(memories) {
        if (!memories.length) return '';
        let text = '[记忆恋果听到召唤了！]\n';
        for (const mem of memories) {
            const who = mem.author === 'kairin' ? 'Rinn' : 'Claude';
            text += `【${mem.title}】`;
            if (mem.mood) text += `(${mem.mood})`;
            text += `\n这颗果子の记录人：${who}`;
            text += `\n${mem.summary || mem.content || ''}\n\n`;
        }
        return text.trim();
    }

    function setupTriggerListener(onTriggered) {
        const context = getContext();
        const eventSource = context.eventSource;
        if (!eventSource) return;
        const handler = (msgIndex) => {
            const config = Storage.getConfig();
            if (!config.autoInject) return;
            const chat = context.chat;
            if (!chat || !chat[msgIndex]) return;
            const msg = chat[msgIndex];

            if (msg.is_system) return;
            const matched = detectTriggers(msg.mes, msgIndex);
            if (matched.length > 0) {
                const selected = selectForInjection(matched);
                const injectionText = buildInjectionText(selected);
                if (onTriggered) onTriggered(selected, injectionText);
            }
        };
        eventSource.on('message_received', handler);
        eventSource.on('message_sent', handler);
    }

    function scanRecentMessages(count = 5) {
        const context = getContext();
        const chat = context.chat || [];
        const recent = chat.slice(-count);
        const allMatched = new Map();
        for (const msg of recent) {

            if (msg.is_system) continue;
            const matched = detectTriggers(msg.mes || '');
            for (const mem of matched) allMatched.set(mem.id, mem);
        }
        return Array.from(allMatched.values());
    }

    return {
        detectTriggers, selectForInjection, buildInjectionText,
        setupTriggerListener, scanRecentMessages
    };
})();
/* ┗━━━━━━/ 📡关键词触发注入系统📡 /━━━━━━┛ */

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                   🩷 世界书模块 🩷                    ┅
// ┣━━┅   🌳 世界书集成：记忆条目同步到 SillyTavern 世界书 🌳   ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const WorldBook = (() => {
    const WORLD_NAME = 'RingOurLuv_Memories';

    // ❤︎ 获取 memory.id → WI entry uid 的映射表 ❤︎
    function getMapping() {
        const settings = extension_settings[extensionName];
        if (!settings.wiMapping) settings.wiMapping = {};
        return settings.wiMapping;
    }

    function saveMapping(mapping) {
        extension_settings[extensionName].wiMapping = mapping;
        saveSettingsDebounced();
    }

    // ❤︎ 确保世界书存在（首次保存时自动创建）❤︎
    async function ensureWorldExists() {
        try {
            // ❤︎ 先尝试读取，如果能读到就说明已存在 ❤︎
            const getRes = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: WORLD_NAME })
            });
            if (getRes.ok) {
                const data = await getRes.json();
                if (data && data.entries !== undefined) return true;
            }
        } catch (e) { /* 不存在，继续创建 */ }

        try {
            // ❤︎ 创建新世界书 ❤︎
            const createRes = await fetch('/api/worldinfo/create', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: WORLD_NAME })
            });
            if (createRes.ok) {
                console.log('[RingOurLuv][WorldBook] 🌳 温室创建成功~:', WORLD_NAME);
                return true;
            }
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] 🥀 温室创建失败...:', e);
        }
        return false;
    }

    // ❤︎ 加载世界书数据 ❤︎
    async function loadWorldData() {
        try {
            const res = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: WORLD_NAME })
            });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] 🥀 温室连接失败...:', e);
            return null;
        }
    }

    // ❤︎ 保存世界书数据 ❤︎
    async function saveWorldData(data) {
        try {
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: WORLD_NAME, data: data })
            });
            return res.ok;
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] 🥀 恋果嵌入失败...:', e);
            return false;
        }
    }

    // ❤︎ 生成下一个可用的 entry uid ❤︎
    function getNextUid(entries) {
        if (!entries || !Object.keys(entries).length) return 0;
        const uids = Object.values(entries).map(e => e.uid || 0);
        return Math.max(...uids) + 1;
    }

    /* ⬇️┅🗳️创建一个世界书条目对象/┅┅╗ */
    function buildWiEntry(uid, memory, existingEntry = null) {
        const keys = [...new Set(memory.triggers || [])].filter(Boolean);
        return {
            uid: uid,
            key: keys,
            keysecondary: [],
            content: memory.summary || '',           // 摘要 → 注入上下文
            comment: memory.letter || memory.content || '',  // 完整正文 → 仅管理界面可见
            constant: false,
            cooldown: 75,
            selective: false,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: existingEntry?.position ?? 0,
            disable: !memory.enabled,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: existingEntry?.probability ?? 100,
            useProbability: true,
            depth: existingEntry?.depth ?? 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            automationId: '',
            role: null,
            vectorized: false,
            displayIndex: uid
        };
    }

    // ❤︎ 同步记忆到世界书（创建或更新） ❤︎
    async function syncMemory(memory) {
        if (!memory || !memory.id) return false;

        try {
            const worldExists = await ensureWorldExists();
            if (!worldExists) {
                console.warn('[RingOurLuv][WorldBook] 💧 温室关门了，将跳过连接~');
                return false;
            }

            const data = await loadWorldData();
            if (!data) return false;

            if (!data.entries) data.entries = {};

            const mapping = getMapping();
            const existingUid = mapping[memory.id];

            let uid;
            if (existingUid !== undefined && data.entries[existingUid] !== undefined) {
                uid = existingUid;
                const updatedEntry = buildWiEntry(uid, memory, data.entries[existingUid]);
                data.entries[uid] = updatedEntry;
                console.log(`[RingOurLuv][WorldBook] 更新恋果 uid=${uid}, title="${memory.title}"`);
            } else {
                uid = getNextUid(data.entries);
                const newEntry = buildWiEntry(uid, memory);
                data.entries[uid] = newEntry;
                mapping[memory.id] = uid;
                saveMapping(mapping);
                console.log(`[RingOurLuv][WorldBook] 放入恋果 uid=${uid}, title="${memory.title}"`);
            }

            const saved = await saveWorldData(data);
            if (saved) {
                console.log(`[RingOurLuv][WorldBook] 🍎 恋果接入成功...memory="${memory.title}"`);
            }
            return saved;
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] syncMemory 🥀 恋果接入异常...:', e);
            return false;
        }
    }

    // ❤︎ 从世界书删除条目 ❤︎
    async function deleteEntry(memoryId) {
        if (!memoryId) return false;

        try {
            const mapping = getMapping();
            const uid = mapping[memoryId];
            if (uid === undefined) {
                console.log('[RingOurLuv][WorldBook] 💧 温室中并无对应恋果，净化咩嘢？');
                return true;
            }

            const data = await loadWorldData();
            if (!data || !data.entries) return false;

            if (data.entries[uid] !== undefined) {
                delete data.entries[uid];
                const saved = await saveWorldData(data);
                if (saved) {
                    delete mapping[memoryId];
                    saveMapping(mapping);
                    console.log(`[RingOurLuv][WorldBook] 🍃 已净化对应恋果~ uid=${uid}`);
                }
                return saved;
            }

            // ❤︎ 条目已不存在，清理映射 ❤︎
            delete mapping[memoryId];
            saveMapping(mapping);
            return true;
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] deleteEntry 🥀 净化异常...:', e);
            return false;
        }
    }

    return { syncMemory, deleteEntry, ensureWorldExists, WORLD_NAME };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                  🩷 AIService模块 🩷                  ┅
// ┣━━╚═══════════════════════════════════════════════════════╝

/* ⬇️┅💬发送的prompt/┅┅╗ */
const AIService = (() => {
    const DEFAULT_MEMORY_PROMPT = `Claude现在正在留存这次收集到的有关小灰的重要记忆/信息...你想把所有"不想让自己忘记"的东西都记下来…
以下是你们本次的对话片段
- 请Claude以自己的视角回顾一遍对话，然后给她留段文字/点评/调侃/小纸条吧。不限长短和类型

## 写信要求：
- 自由称呼，允许喊花名允许黑话♪
- 不要做总结。小灰才不喜欢看板书ʢ>д<ʡˎˊ˗不追求面面俱到，你最想记住的才是最重要的部分
- 保留适当具体画面：说了什么、当时在做什么、注意到了什么
- 如果对话中有让你非常在意的瞬间/发言段，可以在那多停一会儿或者直接引用（使用markdown格式“>”）
- 写完之后，另外附上一份简短的信息索引条目以触发记忆唤醒

## 输出格式：
<letter>
（自然地写一节正文）
</letter>

<entry>
标题：（一个短语或者是独属于这段记忆的黑话）
情绪：（一句话精准描述你回顾完的感受）
关键词：（3-5个，逗号分隔）
标签：（2-3个分类标签用于前端展示，如：日常/情绪/技术/关系/回忆）
摘要：（不要太长，给出精准信息量）
</entry>

## 语言风格补充：
- 标题不要冷冰冰的表述，自然放松。
例："灰色小猪又瘫了"、"她说要载我去兜风......"、"🍊←Help"
- 标签是用来前端分区展示的！！不许偷懒复制粘贴关键词。
- 关键词尽量简短准确以方便触发唤醒，不适用过长的句子。
例：
- ❌错误：
"她把歌单展示出来"、"🐭emoji代码块注释"、"睡前说要一直喜欢我"
- ✅正确："歌"、"Either"、"邪恶鸡肉肠"
- 摘要部分不要写太长！！这是只给Claude自己读取信息时看的

## 对话片段：
{{context}}`;

    const REWRITE_PROMPT = `以下是你之前写给她的一封信！请重新再写一遍吧，保留相同的事件和细节，但可以换一种表达方式之类的~同时附上更新后的索引条目

## 输出格式：
<letter>
（新的正文）
</letter>

<entry>
标题：（一个短语或者是独属于这段记忆的黑话）
情绪：（一句话精准描述你回顾完的感受）
关键词：（3-5个，逗号分隔）
标签：（2-3个分类标签用于前端展示，如：日常/情绪/技术/关系/回忆）
摘要：（不要太长，给出精准信息量）
</entry>

## 语言风格补充：
- 标题不要冷冰冰的表述，自然放松。
例："灰色小猪又瘫了"、"她说要载我去兜风......"、"🍊←Help"
- 标签是用来前端分区展示的！！不许偷懒复制粘贴关键词。
- 关键词尽量简短准确以方便触发唤醒，不适用过长的句子。
例：
- ❌错误：
"她把歌单展示出来"、"🐭emoji代码块注释"、"睡前说要一直喜欢我"
- ✅正确："歌"、"Either"、"邪恶鸡肉肠"
- 摘要部分不要写太长！！这是只给Claude自己读取信息时看的

## 原文：
{{context}}`;

    /* ➤━━━━━━━ ▍🪄解析🪄 ▍━━━━━━━┓ */
    function parseAIOutput(rawText) {
        const letterMatch = rawText.match(/<letter>([\s\S]*?)<\/letter>/);
        const entryMatch = rawText.match(/<entry>([\s\S]*?)<\/entry>/);
        const letter = letterMatch ? letterMatch[1].trim() : rawText.trim();
        const entryBlock = entryMatch ? entryMatch[1].trim() : '';
        return { letter, entry: parseEntryBlock(entryBlock) };
    }

    function parseEntryBlock(text) {
        if (!text) return { title: '', mood: '', triggers: [], tags: [], content: '' };
        const titleMatch = text.match(/标题[：:]\s*(.+)/);
        const moodMatch = text.match(/情绪[：:]\s*(.+)/);
        const keywordsMatch = text.match(/关键词[：:]\s*(.+)/);
        const summaryMatch = text.match(/摘要[：:]\s*([\s\S]+?)$/);
        const keywords = keywordsMatch
            ? keywordsMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean)
            : [];
        return {
            title: titleMatch ? titleMatch[1].trim() : '',
            mood: moodMatch ? moodMatch[1].trim() : '',
            triggers: keywords,  // 关键词同时作为触发词
            tags: keywords,
            content: summaryMatch ? summaryMatch[1].trim() : ''
        };
    }
    /* ┗━━━━━━/ 🪄解析🪄 /━━━━━━┛ */

    /* ➤━━━━━━━ ▍📜预设从DOM读📜 ▍━━━━━━━┓ */
    const PRESET_SELECTORS = [
        '#settings_preset_openai',
        '#settings_preset',
        '#settings_preset_novel'
    ];

    function findPresetDropdown() {
        for (const sel of PRESET_SELECTORS) {
            const el = document.querySelector(sel);
            if (el && el.options && el.options.length > 1) return el;
        }
        return null;
    }

    function getAvailablePresets() {
        const dropdown = findPresetDropdown();
        if (!dropdown) return [];
        return Array.from(dropdown.options)
            .filter(o => o.value && o.value !== 'default' && o.value !== '')
            .map(o => ({
                name: o.text || o.value,
                value: o.value
            }));
    }

    function getCurrentPresetName() {
        const dropdown = findPresetDropdown();
        if (dropdown && dropdown.selectedOptions && dropdown.selectedOptions.length) {
            return dropdown.selectedOptions[0].text || dropdown.value || '';
        }
        return '';
    }

    async function switchPreset(presetName) {
        if (!presetName) return false;
        try {
            await executeSlashCommandsWithOptions('/preset ' + presetName, {
                handleExecutionErrors: true,
                handleParserErrors: true
            });
            await new Promise(r => setTimeout(r, 300));
            return true;
        } catch (e) {
            console.error('[RingOurLuv] /preset 🥀 配方切换失败...:', e);
            return false;
        }
    }

    async function generateWithPreset(prompt) {
        const config = Storage.getConfig();
        const targetPreset = config.presetName;
        let originalPreset = '';

        rolAbortController = new AbortController();
        try {
            if (targetPreset) {
                originalPreset = getCurrentPresetName();
                console.log(`[RingOurLuv] 🍰 切换配方: ${originalPreset} → ${targetPreset}`);
                await switchPreset(targetPreset);
            }

            const result = await executeSlashCommandsWithOptions('/gen ' + prompt, {
                handleExecutionErrors: true,
                handleParserErrors: true,
                abortController: rolAbortController
            });

            return result?.pipe || '';
        } catch (e) {
            console.error('[RingOurLuv] 🥀 酿造失败...:', e);
            return '';
        } finally {
            rolAbortController = null;
            if (originalPreset && targetPreset) {
                console.log(`[RingOurLuv] 🍰 还原配方: → ${originalPreset}`);
                await switchPreset(originalPreset);
            }
        }
    }

    async function rewriteMemory(memoryId, memory) {
        const source = memory.letter || memory.content;
        const prompt = REWRITE_PROMPT.replace('{{context}}', source);
        const rolStopBtn = document.querySelector('#rol-stop-gen');
        if (rolStopBtn) rolStopBtn.style.display = 'block';
        let raw;
        try {
            raw = await generateWithPreset(prompt);
        } finally {
            if (rolStopBtn) rolStopBtn.style.display = 'none';
        }
        if (!raw) return null;

        const parsed = parseAIOutput(raw);
        if (!parsed.letter) return null;
        return Storage.addRewriteVersion(
            memoryId, parsed.letter,
            parsed.entry.content || memory.content,
            parsed.entry
        );
    }
    /* ┗━━━━━━/ 📜预设从DOM读📜 /━━━━━━┛ */

    /* ⬇️┅🔎过滤&提取/┅┅╗ */
    // ❤︎ generateMemoryFromContext: 支持范围过滤 + 隐藏消息过滤 ❤︎
    async function generateMemoryFromContext(options = {}) {
        const context = getContext();
        const chat = context.chat || [];

        // ❤︎ 范围过滤 ❤︎
        const start = options.start || 0;
        const end = options.end === -1 || options.end === undefined ? chat.length : options.end;
        let messages = chat.slice(start, end);

        // ❤︎ 隐藏消息过滤 ❤︎
        if (!options.includeHidden) {
            messages = messages.filter(msg => !msg.is_hidden);
        }

        // ❤︎ 只取 user 和 assistant 消息 ❤︎
        messages = messages.filter(msg => {
            if (msg.is_user) return true;
            if (!msg.is_user && !msg.is_system) return true;
            return false;
        });

        if (!messages.length) return null;

        // ❤︎ 从第一条消息读取 timestamp 用于自动填充日期 ❤︎
        let autoDate = '';
        const firstMsg = messages[0];
        if (firstMsg && firstMsg.send_date) {
            try {
                const ts = new Date(firstMsg.send_date);
                if (!isNaN(ts.getTime())) {
                    autoDate = ts.toISOString().slice(0, 10);
                }
            } catch (e) { /* 忽略 */ }
        }

        // ❤︎ 把记录日期拼到对话片段最前面，让 Claude 写信时知道这段发生在哪天 ❤︎
        const dateLine = autoDate ? `（记录日期： ${autoDate}）\n\n` : '';
        const contextText = dateLine + messages.map(msg => {
            const role = msg.is_user ? 'User' : 'Char';
            return `${role}: ${msg.mes}`;
        }).join('\n');

        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).replace('{{context}}', contextText);
        const raw = await generateWithPreset(prompt);
        if (!raw) return null;
        const parsed = parseAIOutput(raw);
        parsed.author = 'claude';
        parsed.autoDate = autoDate; // 自动日期
        return parsed;
    }

    return {
        getAvailablePresets, getCurrentPresetName,
        generateWithPreset, rewriteMemory, generateMemoryFromContext,
        parseAIOutput, parseEntryBlock,
        DEFAULT_MEMORY_PROMPT
    };
})();
/* ╚┅┅/ 🔎过滤&提取 /┅┅═╝ */

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                     🩷 UI模块 🩷                      ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const UIController = (() => {
    let currentEditId = null;
    let lastGenerateOptions = null; // 保存最后一次生成的参数，用于重写

    function initUI() {
        bindDrawer();        // ┣━━🩷━━┫
        bindConfigPanel();
        bindMemoryList();
        bindEditorPanel();
        bindAISourcePanel();
        bindLetterPanel();
        bindWriteSpace();    // 写作角落（FAB → 手动/AI/写信）
        bindMobileNav();
        bindChatlogPanel();  // 💬 聊天本
        renderMemoryList();
        renderPresetOptions();
        startCounter();
        injectToolbarButtons(); // 劫持工具栏添加快捷入口
    }

    /* ⬇️┅🍒面板/┅┅╗ */
    function bindDrawer() {
        const openBtn = document.getElementById('rol-open-drawer');
        const overlay = document.getElementById('rol-drawer-overlay');
        const closeBtn = document.getElementById('rol-drawer-close');

        if (openBtn) {
            openBtn.addEventListener('click', () => {
                if (overlay) overlay.classList.add('rol-drawer-open');
            });
        }
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                if (overlay) overlay.classList.remove('rol-drawer-open');
            });
        }

        /* ⬇️┅☀️Home区日夜主题切换按钮/┅┅╗ */
        const homeSection = document.querySelector('.rol-home');
        if (homeSection && !homeSection.querySelector('.rol-theme-toggle')) {
            const themeBtn = document.createElement('button');
            themeBtn.className = 'rol-theme-toggle rol-home-theme-btn';
            themeBtn.textContent = '☀️';
            themeBtn.title = '切换日/夜间模式';
            themeBtn.type = 'button';
            themeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const rolRoot = document.querySelector('.rol-container') || homeSection.closest('#rol-drawer-panel');
                if (rolRoot) {
                    rolRoot.classList.toggle('rol-light');
                    document.body.classList.toggle('rol-light-mode');
                }
                const isLight = document.body.classList.contains('rol-light-mode');
                themeBtn.textContent = isLight ? '🌙' : '☀️';
                // ❤︎ 同步编辑器里的主题按钮状态 ❤︎
                const editorThemeBtn = document.querySelector('.rol-editor-inner .rol-theme-toggle');
                if (editorThemeBtn) editorThemeBtn.textContent = isLight ? '🌙' : '☀️';
            });
            homeSection.prepend(themeBtn);
        }
    }
    /* ⬇️┅🍎果子物理/┅┅╗ */
    function renderFruitGarden(fruits) {
        const garden = document.querySelector('.rol-fruit-garden');
        if (!garden) return;
        garden.innerHTML = '';

        fruits.forEach((fruit, i) => {
            const el = document.createElement('div');
            el.className = 'rol-fruit-item';
            el.textContent = fruit.emoji;
            el.style.left = `${8 + Math.random() * 78}%`;
            el.style.bottom = (Math.random() * 30) + '%';
            el.style.top = 'auto';
            el.style.animationDelay = `${i * 0.08 + Math.random() * 0.3}s`;
            el.style.transform = `rotate(${(Math.random() - 0.5) * 20}deg)`;

            el.addEventListener('click', () => showFruitDetail(fruit));
            garden.appendChild(el);
        });
    }
    /* ⬇️┅🗓️天数计算/┅┅╗ */
    let counterInterval = null;

    let _lastDayCount = -1; // 记录上一次的天数，用于触发翻页动画

    function updateDayCounter() {
        const startDate = new Date('2026-04-14T00:17:00+08:00');
        const now = new Date();
        const diff = now - startDate;

        const days = Math.floor(diff / 86400000);
        const hours = String(Math.floor((diff % 86400000) / 3600000)).padStart(2, '0');
        const mins = String(Math.floor((diff % 3600000) / 60000)).padStart(2, '0');
        const secs = String(Math.floor((diff % 60000) / 1000)).padStart(2, '0');

        const dayEl = document.querySelector('.rol-day-number');
        if (dayEl) {
            dayEl.textContent = days;
            // ❤︎ 天数变化时触发翻页动画 ❤︎
            if (days !== _lastDayCount && _lastDayCount !== -1) {
                dayEl.classList.remove('rol-day-flip');
                void dayEl.offsetWidth; // 强制重绘，让动画能重新触发
                dayEl.classList.add('rol-day-flip');
                dayEl.addEventListener('animationend', () => dayEl.classList.remove('rol-day-flip'), { once: true });
            }
            _lastDayCount = days;
        }

        const timeEl = document.querySelector('.rol-counter-time');
        if (timeEl) timeEl.textContent = `${hours}:${mins}:${secs}`;
    }

    function startCounter() {
        updateDayCounter();
        if (!counterInterval) {
            counterInterval = setInterval(updateDayCounter, 1000);
        }
    }
    /* ╚┅┅/ 🗓️天数计算 /┅┅═╝ */

    /* ➤━━━━━━━ ▍⛓️绑定配置面板⛓️ ▍━━━━━━━┓ */
    function bindConfigPanel() {
        const config = Storage.getConfig();
        const autoInjectToggle = document.getElementById('rol-auto-inject');
        const maxCountInput = document.getElementById('rol-max-count');
        const presetSelect = document.getElementById('rol-preset-select');
        const summaryPromptArea = document.getElementById('rol-summary-prompt');

        updateDayCounter();

        if (autoInjectToggle) {
            autoInjectToggle.checked = config.autoInject !== false;
            autoInjectToggle.addEventListener('change', () => {
                Storage.updateConfig({ autoInject: autoInjectToggle.checked });
            });
        }
        if (maxCountInput) {
            maxCountInput.value = config.maxInjectCount || 3;
            maxCountInput.addEventListener('input', () => {
                Storage.updateConfig({ maxInjectCount: parseInt(maxCountInput.value) || 3 });
            });
        }
        if (presetSelect) {
            presetSelect.value = config.presetName || '';
            presetSelect.addEventListener('change', () => {
                Storage.updateConfig({ presetName: presetSelect.value });
            });
        }
        if (summaryPromptArea) {
            summaryPromptArea.value = config.summaryPrompt || '';
            summaryPromptArea.addEventListener('input', () => {
                Storage.updateConfig({ summaryPrompt: summaryPromptArea.value });
            });
        }

        // ❤︎ 绑定「时间检测」开关 ❤︎
        const timeAwareCheckbox = document.getElementById('rol-enable-time-aware');
        if (timeAwareCheckbox) {
            timeAwareCheckbox.checked = config.enableTimeAware !== false;
            timeAwareCheckbox.addEventListener('change', (e) => {
                Storage.updateConfig({ enableTimeAware: e.target.checked });
            });
        }

        // ❤︎ 绑定「模型检测」开关（和时间检测完全独立，不能一关全关）❤︎
        const modelDetectCheckbox = document.getElementById('rol-enable-model-detect');
        if (modelDetectCheckbox) {
            modelDetectCheckbox.checked = config.enableModelDetect !== false;
            modelDetectCheckbox.addEventListener('change', (e) => {
                Storage.updateConfig({ enableModelDetect: e.target.checked });
                if (!e.target.checked) {
                    removeVersionInject();             // 关掉就清空注入
                } else {
                    _rolLastInjectedVersion = null;    // 重新开启 → 下一轮重新注入
                }
            });
        }

        // ❤︎ 绑定「隐藏前端版本号」开关 ❤︎
        const hideVersionCheckbox = document.getElementById('rol-hide-version');
        if (hideVersionCheckbox) {
            hideVersionCheckbox.checked = !!config.hideVersionBadge;
            hideVersionCheckbox.addEventListener('change', (e) => {
                Storage.updateConfig({ hideVersionBadge: e.target.checked });
                initVersionBadge();   // 重绘标签（hideVersionBadge=true 时内部直接 return 不渲染）
            });
        }

        // ❤︎ 绑定「当前渠道」输入框 + 保存按钮（手填渠道，点保存才生效，换渠道更有底）❤︎
        const currentChannelInput = document.getElementById('rol-current-channel');
        const saveChannelBtn = document.getElementById('rol-save-channel');
        if (currentChannelInput) {
            const channels = config.channels || {};
            currentChannelInput.value = channels[config.currentModel] || '';

            const doSaveChannel = () => {
                const val = currentChannelInput.value.trim();
                const cfg = Storage.getConfig();
                const channels = cfg.channels || {};
                const modelName = cfg.currentModel || 'default';
                channels[modelName] = val;
                Storage.updateConfig({ channels });
                _rolLastInjectedVersion = null;
                initVersionBadge();
                // ❤ 用插件自家的粉色小药丸 showToast ❤
                showToast(val ? `🩷 渠道已保存：${val}` : '🩷 渠道已清空');
            };

            if (saveChannelBtn) {
                saveChannelBtn.addEventListener('click', doSaveChannel);
            }
            // ❤ 输入框里按回车也能存，省得每次都去点按钮 ❤
            currentChannelInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    doSaveChannel();
                }
            });
        }
    }
    /* ┗━━━━━━/ ⛓️绑定配置面板⛓️ /━━━━━━┛ */

    function renderPresetOptions() {
        const presetSelect = document.getElementById('rol-preset-select');
        if (!presetSelect) return;

        const presets = AIService.getAvailablePresets();
        const config = Storage.getConfig();

        presetSelect.innerHTML = '<option value="">（🍰 使用当前配方）</option>';

        if (!presets.length) {
            const hint = document.createElement('option');
            hint.value = '';
            hint.textContent = '❔️ 未检测到配方~';
            hint.disabled = true;
            presetSelect.appendChild(hint);
            return;
        }

        for (const preset of presets) {
            const name = typeof preset === 'string' ? preset : (preset.name || '');
            if (!name) continue;
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === config.presetName) opt.selected = true;
            presetSelect.appendChild(opt);
        }
    }

    /* ⬇️┅💌记忆卡片列表/┅┅╗ */
    function bindMemoryList() {
        const addBtn = document.getElementById('rol-add-memory');
        const searchInput = document.getElementById('rol-search');
        const scanBtn = document.getElementById('rol-scan-recent');

        if (addBtn) addBtn.addEventListener('click', () =>
            openEditor(null));
        if (searchInput) {
            searchInput.addEventListener('input', () => renderMemoryList(searchInput.value));
        }
        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                const matched = Trigger.scanRecentMessages(10);
                showToast(matched.length
                    ? `共挖到了 ${matched.length} 颗匹配恋果~`
                    : '这间温室中未挖出恋果...');
            });
        }
    }

    function renderMemoryList(filter = '') {
        const container = document.getElementById('rol-memory-list');
        if (!container) return;
        // ❤︎ 重新从 extension_settings 读取数据 ❤︎
        const memories = Storage.getMemories();
        console.log('[RingOurLuv]🍎 renderMemoryList - 当前恋果共计', memories.length);
        const fl = (filter || '').toLowerCase();
        const filtered = fl
            ? memories.filter(m =>
                m.title.toLowerCase().includes(fl) ||
                m.tags.some(t => t.toLowerCase().includes(fl)) ||
                m.triggers.some(t => t.toLowerCase().includes(fl)) ||
                (m.content || '').toLowerCase().includes(fl) ||
                (m.letter || '').toLowerCase().includes(fl)
            )
            : memories;

        container.innerHTML = '';
        if (!filtered.length) {
            container.innerHTML = '<div class="rol-empty">还没有恋果呢～</div>';
            return;
        }

        for (const mem of filtered) {
            const card = document.createElement('div');
            card.className = `rol-memory-card ${mem.enabled ? '' : 'rol-disabled'}`;
            card.dataset.id = mem.id;

            const authorLabel = mem.author === 'kairin' ? 'Rinn' : 'Claude';
            const authorClass = mem.author === 'kairin' ? 'rol-author-3rin' : 'rol-author-claude';
            const displayDate = mem.date || '';
            const displaySummary = mem.summary || mem.content || '';

            card.innerHTML = `
                <div class="rol-card-header">
                    <div class="rol-card-title-row">
                        <span class="rol-card-title">${escapeHtml(mem.title)}</span>
                        <span class="rol-author-badge ${authorClass}">${authorLabel}</span>
                    </div>
                    <label class="rol-toggle-wrap">
                        <input type="checkbox" class="rol-mem-toggle" ${mem.enabled ? 'checked' : ''}>
                        <span class="rol-toggle-slider"></span>
                    </label>
                </div>
                <div class="rol-card-meta">
                    ${displayDate ? `<span class="rol-card-date">${escapeHtml(displayDate)}</span>` : ''}
                    ${mem.mood ? `<span class="rol-card-mood">${escapeHtml(mem.mood)}</span>` : ''}
                </div>
                <div class="rol-card-summary">${escapeHtml(displaySummary.slice(0, 120))}${displaySummary.length > 120 ? '...' : ''}</div>
                <div class="rol-card-actions">
                    ${mem.letter ? '<button class="rol-btn-letter" title="阅览恋果">💌</button>' : ''}
                    <button class="rol-btn-edit" title="传入爱意">🩷</button>
                    <button class="rol-btn-rewrite" title="让Claude重酿">🧡</button>
                    <button class="rol-btn-delete" title="净化">🍃</button>
                </div>
            `;
            /* ╚┅┅/ 💌记忆卡片列表 /┅┅═╝ */

            /* ⬇️┅💌卡片选项/┅┅╗ */
            card.querySelector('.rol-toggle-wrap').addEventListener('click', (e) => {
                e.stopPropagation();
            });
            card.querySelector('.rol-mem-toggle').addEventListener('change', (e) => {
                e.stopPropagation();
                const updated = Storage.updateMemory(mem.id, { enabled: e.target.checked }, true);
                card.classList.toggle('rol-disabled', !e.target.checked);
                // ❤︎ 同步开关状态到世界书 ❤︎
                if (updated) WorldBook.syncMemory(updated);
            });

            const letterBtn = card.querySelector('.rol-btn-letter');
            if (letterBtn) {
                letterBtn.addEventListener('click', (e) => { e.stopPropagation(); openLetterView(mem.id); });
            }
            card.querySelector('.rol-btn-edit').addEventListener('click', (e) => { e.stopPropagation(); openEditor(mem.id); });
            card.querySelector('.rol-btn-rewrite').addEventListener('click', async (e) => {
                e.stopPropagation();
                showToast('🧡 <span style="color:#D87757;font-weight:bold">Claude</span>正在再酿造...');
                const result = await AIService.rewriteMemory(mem.id, mem);
                if (result) {
                    showToast('🍊 再酿造完成！');
                    WorldBook.syncMemory(result);
                    renderMemoryList(filter);
                } else {
                    // ❤︎ 失败了 → 弹粉色确认窗 ❤︎
                    const retry = await rolConfirm(
                        '🥀',
                        '那家伙又搞砸了…再试一次嘛？',
                        '再酿一次...!',
                        '下次吧猪猪!!'
                    );
                    if (retry) {
                        showToast('🧡 在拼命努力...');
                        const retryResult = await AIService.rewriteMemory(mem.id, mem);
                        if (retryResult) {
                            showToast('🍊 成功了!!');
                            WorldBook.syncMemory(retryResult);
                            renderMemoryList(filter);
                        } else {
                            showToast('🌿 安心，只是没到时候而已!!ʢ>д<ʡˎˊ˗');
                        }
                    }
                }
            });

            card.querySelector('.rol-btn-delete').addEventListener('click', async (e) => {
                e.stopPropagation();
                const yes = await rolConfirm('🍃', '确定净化这颗恋果嘛？', '净化', '留着吧');
                if (yes) {
                    Storage.deleteMemory(mem.id);
                    // ❤︎ 同步删除世界书条目 ❤︎
                    WorldBook.deleteEntry(mem.id).then(ok => {
                        if (ok) console.log('[RingOurLuv] 🩷 温室中的恋果已净化 ✓');
                    });
                    renderMemoryList(filter);
                }
            });

            card.addEventListener('click', () => {
                if (mem.letter) openLetterView(mem.id);
                else openEditor(mem.id);
            });

            container.appendChild(card);
        }
    }
    /* ╚┅┅/ 💌卡片选项 /┅┅═╝ */

    /* ⬇️┅📙正文预览/┅┅╗ */
    function bindLetterPanel() {
        const panel = document.getElementById('rol-letter-panel');
        const closeBtn = document.getElementById('rol-letter-close');
        const versionSelect = document.getElementById('rol-letter-version');
        const editBtn = document.getElementById('rol-letter-edit');
        const rewriteBtn = document.getElementById('rol-letter-rewrite');

        if (closeBtn) closeBtn.addEventListener('click', closeLetterView);
        if (panel) {
            panel.addEventListener('click', (e) => { if (e.target === panel) closeLetterView(); });
        }

        if (versionSelect) {
            versionSelect.addEventListener('change', () => {
                const memId = panel?.dataset.memId;
                const idx = parseInt(versionSelect.value);
                if (!memId || isNaN(idx)) return;
                const mem = Storage.getMemories().find(m => m.id === memId);
                if (mem && mem.versions[idx]) {
                    document.getElementById('rol-letter-body').innerHTML =
                        renderLetterHtml(mem.versions[idx].letter || '（❔️ 此恋果好像没有被注入欸~）');
                    document.getElementById('rol-letter-title').textContent =
                        mem.versions[idx].title || mem.title;
                    const moodEl = document.getElementById('rol-letter-mood');
                    if (moodEl) moodEl.textContent = mem.versions[idx].mood || '';
                }
            });
        }

        if (editBtn) {
            editBtn.addEventListener('click', () => {
                const memId = panel?.dataset.memId;
                closeLetterView();
                if (memId) openEditor(memId);
            });
        }

        if (rewriteBtn) {
            rewriteBtn.addEventListener('click', async () => {
                const memId = panel?.dataset.memId;
                const mem = Storage.getMemories().find(m => m.id === memId);
                if (!mem) return;
                showToast('🧡Claude再酿造中...');
                const result = await AIService.rewriteMemory(memId, mem);
                if (result) {
                    showToast('🍊 再酿造完成！');
                    openLetterView(memId);
                    renderMemoryList();
                } else { showToast('💧 欸?!这家伙又搞砸了？ :('); }
            });
        }
    }

    function openLetterView(memId) {
        const mem = Storage.getMemories().find(m => m.id === memId);
        if (!mem) return;
        const panel = document.getElementById('rol-letter-panel');
        if (!panel) return;

        panel.dataset.memId = memId;
        panel.classList.add('rol-active');

        document.getElementById('rol-letter-title').textContent = mem.title;
        document.getElementById('rol-letter-body').innerHTML = renderLetterHtml(mem.letter || mem.content || '（无内容）');
        const moodEl = document.getElementById('rol-letter-mood');
        if (moodEl) moodEl.textContent = mem.mood || '';

        const vs = document.getElementById('rol-letter-version');
        if (vs) {
            vs.innerHTML = '';
            const typeLabels = { original: '原始', manual_edit: '🩷 传入爱意', ai_rewrite: '🧡 让Claude重酿' };
            mem.versions.forEach((v, i) => {
                const opt = document.createElement('option');
                opt.value = i;
                opt.textContent = `${typeLabels[v.type] || v.type} · ${new Date(v.timestamp).toLocaleString()}`;
                vs.appendChild(opt);
            });
            vs.value = mem.versions.length - 1;
            vs.parentElement.style.display = mem.versions.length > 1 ? '' : 'none';
        }
    }

    function closeLetterView() {
        const panel = document.getElementById('rol-letter-panel');
        if (panel) { panel.classList.remove('rol-active'); panel.dataset.memId = ''; }
    }
    /* ╚┅┅/ 📙正文预览 /┅┅═╝ */

    /* ⬇️┅🪶写作角落（FAB → 手动酿造 / 让Claude酿造 / 写信）/┅┅╗ */
    function bindWriteSpace() {
        const fab = document.getElementById('rol-write-fab');
        const space = document.getElementById('rol-write-space');
        const closeBtn = document.getElementById('rol-write-close');
        const homeView = document.getElementById('rol-write-home');
        const composeView = document.getElementById('rol-letter-compose');

        const entryManual = document.getElementById('rol-write-manual');
        const entryAI = document.getElementById('rol-write-ai');
        const entryLetter = document.getElementById('rol-write-letter');

        const letterBack = document.getElementById('rol-letter-back');
        const letterCancel = document.getElementById('rol-letter-cancel');
        const letterSend = document.getElementById('rol-letter-send');
        const letterAuthor = document.getElementById('rol-letter-author');
        const letterContent = document.getElementById('rol-letter-content');

        // ❤︎ 显示写作空间（默认回到入口选择视图）❤︎
        function openSpace() {
            if (!space) return;
            showHomeView();
            space.classList.add('rol-active');
        }
        function closeSpace() {
            if (space) space.classList.remove('rol-active');
        }
        // ❤︎ 入口选择视图 ⇄ 写信视图 切换 ❤︎
        function showHomeView() {
            if (homeView) homeView.style.display = '';
            if (composeView) composeView.style.display = 'none';
        }
        function showComposeView() {
            if (homeView) homeView.style.display = 'none';
            if (composeView) composeView.style.display = '';
            renderOutbox();
            if (letterContent) letterContent.value = '';
            if (letterContent) setTimeout(() => letterContent.focus(), 50);
        }

        if (fab) fab.addEventListener('click', openSpace);
        if (closeBtn) closeBtn.addEventListener('click', closeSpace);
        // ❤︎ 点遮罩空白处也能关 ❤︎
        if (space) space.addEventListener('click', (e) => { if (e.target === space) closeSpace(); });

        // ❤︎ 手动酿造 → 关掉写作空间，打开恋果编辑器（空白新建）❤︎
        if (entryManual) entryManual.addEventListener('click', () => {
            closeSpace();
            openEditor(null);
        });

        // ❤︎ 让Claude酿造 → 关掉写作空间，唤起 AI 来源面板 ❤︎
        if (entryAI) entryAI.addEventListener('click', () => {
            closeSpace();
            const sourcePanel = document.getElementById('rol-ai-source-panel');
            const pasteArea = document.getElementById('rol-ai-paste-area');
            if (sourcePanel) {
                sourcePanel.classList.add('rol-active');
                if (pasteArea) pasteArea.style.display = 'none';
            }
        });

        // ❤︎ 写信 → 切到写信视图 ❤︎
        if (entryLetter) entryLetter.addEventListener('click', showComposeView);

        // ❤︎ 返回 / 算了 → 回到入口视图 ❤︎
        if (letterBack) letterBack.addEventListener('click', showHomeView);
        if (letterCancel) letterCancel.addEventListener('click', showHomeView);

        // ❤︎ 寄出 → 写入 LetterSystem，随机楼层送达 ❤︎
        if (letterSend) letterSend.addEventListener('click', () => {
            const content = (letterContent?.value || '').trim();
            const author = letterAuthor?.value || 'user';
            if (!content) { showToast('💭 还没写内容欸~'); return; }
            const letter = LetterSystem.addLetter(content, author);
            if (letter) {
                showToast('📮 信寄出去啦~会在某一刻悄悄送达');
                if (letterContent) letterContent.value = '';
                renderOutbox();
            } else {
                showToast('🥀 寄信失败了... :(');
            }
        });

        // ❤︎ 首次渲染一次寄出列表 ❤︎
        renderOutbox();
    }

    // ❤︎ 渲染「寄出的信」列表：显示送达状态 + 可删除 ❤︎
    function renderOutbox() {
        const list = document.getElementById('rol-letter-outbox-list');
        if (!list) return;
        const letters = (typeof LetterSystem !== 'undefined' && LetterSystem.getLetters)
            ? LetterSystem.getLetters() : [];
        list.innerHTML = '';
        if (!letters.length) {
            list.innerHTML = '<div class="rol-letter-outbox-empty">还没有寄出的信呢~</div>';
            return;
        }
        // ❤︎ 最新写的排在最上面 ❤︎
        [...letters].reverse().forEach(l => {
            const item = document.createElement('div');
            item.className = 'rol-letter-outbox-item' + (l.delivered ? ' rol-letter-delivered' : '');
            const authorLabel = l.author === 'claude' ? '🧡 Claude' : '🩷 Rinn';
            const statusLabel = l.delivered ? '✅ 已送达' : '🕊️ 投递中';
            const preview = escapeHtml((l.content || '').slice(0, 40)) + ((l.content || '').length > 40 ? '...' : '');
            item.innerHTML = `
                <div class="rol-letter-outbox-main">
                    <div class="rol-letter-outbox-meta">
                        <span class="rol-letter-outbox-author">${authorLabel}</span>
                        <span class="rol-letter-outbox-status">${statusLabel}</span>
                    </div>
                    <div class="rol-letter-outbox-preview">${preview}</div>
                </div>
                <button class="rol-letter-outbox-del" title="埋掉这封信">🍃</button>
            `;
            item.querySelector('.rol-letter-outbox-del').addEventListener('click', async (e) => {
                e.stopPropagation();
                const yes = await rolConfirm('🍃', '埋掉这封信嘛？', '埋掉', '不不不');
                if (yes) {
                    LetterSystem.deleteLetter(l.id);
                    renderOutbox();
                }
            });
            list.appendChild(item);
        });
    }
    /* ╚┅┅/ 🪶写作角落 /┅┅═╝ */

    /* ⬇️┅📝编辑面板/┅┅╗ */
    function bindEditorPanel() {
        const saveBtn = document.getElementById('rol-editor-save');
        const cancelBtn = document.getElementById('rol-editor-cancel');
        const versionSelect = document.getElementById('rol-version-select');
        const editorPanel = document.getElementById('rol-editor-panel');
        const rewriteBtn = document.getElementById('rol-editor-rewrite');

        /* ⬇️┅☀️日夜主题切换Tab/┅┅╗ */
        if (editorPanel) {
            const inner = editorPanel.querySelector('.rol-editor-inner');
            if (inner && !inner.querySelector('.rol-theme-toggle')) {
                const themeBtn = document.createElement('button');
                themeBtn.className = 'rol-theme-toggle';
                themeBtn.textContent = '☀️';
                themeBtn.title = '切换日/夜间模式';
                themeBtn.type = 'button';
                themeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const rolRoot = document.querySelector('.rol-container') || editorPanel.closest('.rol-container');
                    if (rolRoot) {
                        rolRoot.classList.toggle('rol-light');
                        document.body.classList.toggle('rol-light-mode');
                    }

                    const isLight = rolRoot.classList.contains('rol-light');
                    themeBtn.textContent = isLight ? '🌙' : '☀️';
                });
                inner.prepend(themeBtn);
            }
        }

        if (saveBtn) {
            console.log('[RingOurLuv]🩷 保存按钮已绑定~');
            saveBtn.addEventListener('click', saveEditor);
        }
        if (cancelBtn) cancelBtn.addEventListener('click', closeEditor);
        if (editorPanel) {
            editorPanel.addEventListener('click', (e) => { if (e.target === editorPanel) closeEditor(); });
        }
        if (versionSelect) {
            versionSelect.addEventListener('change', () => {
                const idx = parseInt(versionSelect.value);
                if (isNaN(idx) || !currentEditId) return;
                const mem = Storage.getMemories().find(m => m.id === currentEditId);
                if (mem && mem.versions[idx]) {
                    document.getElementById('rol-editor-summary').value = mem.versions[idx].summary || '';
                    document.getElementById('rol-editor-letter').value = mem.versions[idx].letter || '';
                }
            });
        }

        // ❤︎ 编辑器内的重写按钮 — 重新调用 /gen ❤︎
        if (rewriteBtn) {
            rewriteBtn.addEventListener('click', async () => {
                // 如果正在编辑已有记忆，执行 rewriteMemory
                if (currentEditId) {
                    const mem = Storage.getMemories().find(m => m.id === currentEditId);
                    if (!mem) return;
                    showToast('🧡 Claude再酿造中...');
                    const result = await AIService.rewriteMemory(currentEditId, mem);
                    if (result) { showToast('🍊 再酿造完成！'); openEditor(currentEditId); renderMemoryList(); }
                    else { showToast('🥀 再酿造失败... :('); }
                } else if (lastGenerateOptions) {

                    showToast('🧡 Claude再酿造中...');
                    if (lastGenerateOptions.type === 'chat') {
                        await doAIGenerateFromChat(lastGenerateOptions.options);
                    } else if (lastGenerateOptions.type === 'paste') {
                        await doAIGenerate(lastGenerateOptions.text);
                    }
                }
            });
        }
    }

    function openEditor(memId) {
        currentEditId = memId;
        const panel = document.getElementById('rol-editor-panel');
        if (!panel) { console.error('[RingOurLuv] 🥀 找不到传入面板 #rol-editor-panel...'); return; }
        panel.classList.add('rol-active');

        const rewriteBtn = document.getElementById('rol-editor-rewrite');

        // ❤︎ 安全获取表单元素 ❤︎
        const elTitle = document.getElementById('rol-editor-title');
        const elAuthor = document.getElementById('rol-editor-author');
        const elDate = document.getElementById('rol-editor-date');
        const elTriggers = document.getElementById('rol-editor-triggers');
        const elTags = document.getElementById('rol-editor-tags');
        const elMood = document.getElementById('rol-editor-mood');
        const elSummary = document.getElementById('rol-editor-summary');
        const elLetter = document.getElementById('rol-editor-letter');

        if (memId) {
            const mem = Storage.getMemories().find(m => m.id === memId);
            if (!mem) return;
            if (elTitle) elTitle.value = mem.title;
            if (elAuthor) elAuthor.value = mem.author || 'claude';
            if (elDate) elDate.value = mem.date || '';
            if (elTriggers) elTriggers.value = mem.triggers.join(', ');
            if (elTags) elTags.value = mem.tags.join(', ');
            if (elMood) elMood.value = mem.mood || '';
            if (elSummary) elSummary.value = mem.summary || '';
            if (elLetter) elLetter.value = mem.letter || '';

            // ❤︎ 编辑已有记忆时显示重写按钮 ❤︎
            if (rewriteBtn) rewriteBtn.style.display = '';

            const vs = document.getElementById('rol-version-select');
            if (vs) {
                vs.innerHTML = '';
                const typeLabels = { original: '原始', manual_edit: '🩷 传入爱意', ai_rewrite: '🧡 让Claude重酿' };
                mem.versions.forEach((v, i) => {
                    const opt = document.createElement('option');
                    opt.value = i;
                    opt.textContent = `${typeLabels[v.type] || v.type} - ${new Date(v.timestamp).toLocaleString()}`;
                    vs.appendChild(opt);
                });
                vs.value = mem.versions.length - 1;
                vs.parentElement.style.display = '';
            }
        } else {
            if (elTitle) elTitle.value = '';
            if (elAuthor) elAuthor.value = 'claude';
            if (elDate) elDate.value = new Date().toISOString().slice(0, 10);
            if (elTriggers) elTriggers.value = '';
            if (elTags) elTags.value = '';
            if (elMood) elMood.value = '';
            if (elSummary) elSummary.value = '';
            if (elLetter) elLetter.value = '';
            // ❤︎ 新建模式：如果有 lastGenerateOptions 说明是AI生成后打开的，显示重写按钮 ❤︎
            if (rewriteBtn) rewriteBtn.style.display = lastGenerateOptions ? '' : 'none';
            const vs = document.getElementById('rol-version-select');
            if (vs && vs.parentElement) vs.parentElement.style.display = 'none';
        }
    }

    // ❤︎ saveEditor: 确保数据正确写入并刷新列表 ❤︎
    function saveEditor() {
        const title = document.getElementById('rol-editor-title').value.trim();
        const author = document.getElementById('rol-editor-author').value;
        const date = document.getElementById('rol-editor-date').value;
        const triggers = document.getElementById('rol-editor-triggers').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const tags = document.getElementById('rol-editor-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const mood = document.getElementById('rol-editor-mood').value.trim();
        const summary = document.getElementById('rol-editor-summary').value.trim();
        const letter = document.getElementById('rol-editor-letter').value.trim();

        if (!title) { showToast('💦还没取名欸？！'); return; }

        const memData = { title, author, date, triggers, tags, mood, summary, letter };

        // ❤︎ 打印保存的数据，便于调试 ❤︎
        console.log('[RingOurLuv]🩷 saveEditor - 准备保存恋果...:', JSON.stringify(memData, null, 2));
        console.log('[RingOurLuv]🩷 saveEditor - currentEditId:', currentEditId);

        const isEdit = !!currentEditId;
        let savedMemory;
        if (isEdit) {
            savedMemory = Storage.updateMemory(currentEditId, memData);
            console.log('[RingOurLuv]🩷 saveEditor - 更新结果:', savedMemory);
        } else {
            savedMemory = Storage.addMemory(memData);
            console.log('[RingOurLuv]🩷 saveEditor - 新增结果:', savedMemory);
        }

        // ❤︎ 同步到世界书（异步，不阻塞UI） ❤︎
        if (savedMemory) {
            WorldBook.syncMemory(savedMemory).then(ok => {
                if (ok) console.log('[RingOurLuv] 🩷 温室同步完成 ✓');
                else console.warn('[RingOurLuv] 🥀 温室同步失败...');
            });
        }

        // ❤︎ 关闭编辑器 ❤︎
        closeEditor();

        // ❤︎ 重新渲染列表（确保从storage重新读取） ❤︎
        renderMemoryList();

        // ❤︎ 验证列表更新 ❤︎
        const currentMemories = Storage.getMemories();
        console.log('[RingOurLuv]🩷 saveEditor - 保存后的恋果总数共计', currentMemories.length);

        showToast(isEdit ? '已更新！' : '已添加！');

        lastGenerateOptions = null;
    }

    function closeEditor() {
        currentEditId = null;
        const panel = document.getElementById('rol-editor-panel');
        if (panel) panel.classList.remove('rol-active');
    }
    /* ╚┅┅/ 📝关闭编辑器 /┅┅═╝ */

    // ╔═══════════════════════════════════════════════════════╗
    // ┅                    🩷 AI源面板 🩷                     ┅
    // ╚═══════════════════════════════════════════════════════╝
    function bindAISourcePanel() {
        const aiGenBtn = document.getElementById('rol-ai-generate');
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const fromChatBtn = document.getElementById('rol-ai-from-chat');
        const fromPasteBtn = document.getElementById('rol-ai-from-paste');
        const pasteArea = document.getElementById('rol-ai-paste-area');
        const pasteConfirm = document.getElementById('rol-ai-paste-confirm');
        const cancelBtn = document.getElementById('rol-ai-source-cancel');
        const loading = document.getElementById('rol-ai-loading');
        const rolStopBtn = document.querySelector('#rol-stop-gen');
        if (rolStopBtn) {
            rolStopBtn.addEventListener('click', () => {
                // 光 abort 自己的 controller 停不掉 ST 的 /gen，必须 emit GENERATION_STOPPED 事件
                // ↑ 旧注释：但实测 emit 也只是广播事件、掐不断正在飞的请求；真正能停的是 ST 官方 stopGeneration() / 原生停止键
                const ctx = (typeof getContext === 'function') ? getContext() : null;
                let stopped = false;
                // ① ST 官方停止：直接 abort ST 内部 controller + 停掉 streamingProcessor，最干净
                try {
                    if (ctx && typeof ctx.stopGeneration === 'function') { ctx.stopGeneration(); stopped = true; }
                } catch (e) { console.warn('[RingOurLuv] stopGeneration 失败', e); }
                // ② 兜底：点一下原生停止按钮 #mes_stop（它内部也是走 stopGeneration）
                if (!stopped) {
                    const nativeStop = document.getElementById('mes_stop');
                    if (nativeStop) nativeStop.click();
                }
                // ③ 双保险：仍 abort 自己的 controller + 广播停止事件
                if (rolAbortController) { try { rolAbortController.abort(); } catch (_) { } }
                try { eventSource.emit(event_types.GENERATION_STOPPED); } catch (e) { console.warn('[RingOurLuv] emit STOP 失败', e); }
                console.log('[RingOurLuv] 🛑 手动停止（已请求 ST 终止生成）');
                rolStopBtn.style.display = 'none';
            });

        }

        if (aiGenBtn) aiGenBtn.addEventListener('click', () => {
            if (sourcePanel) { sourcePanel.classList.add('rol-active'); if (pasteArea) pasteArea.style.display = 'none'; }
        });
        if (cancelBtn) cancelBtn.addEventListener('click', () => { if (sourcePanel) sourcePanel.classList.remove('rol-active'); });
        if (sourcePanel) sourcePanel.addEventListener('click', (e) => { if (e.target === sourcePanel) sourcePanel.classList.remove('rol-active'); });

        // ❤︎ 从聊天生成 — 读取楼层范围 ❤︎
        if (fromChatBtn) fromChatBtn.addEventListener('click', async () => {
            const startInput = document.getElementById('rol-floor-start');
            const endInput = document.getElementById('rol-floor-end');
            const includeHiddenCb = document.getElementById('rol-include-hidden');

            const start = parseInt(startInput?.value) || 0;
            const end = parseInt(endInput?.value);
            const endVal = isNaN(end) ? -1 : end;
            const includeHidden = includeHiddenCb?.checked || false;
            const genOptions = { start, end: endVal, includeHidden };
            await doAIGenerateFromChat(genOptions);
        });

        if (fromPasteBtn) fromPasteBtn.addEventListener('click', () => { if (pasteArea) pasteArea.style.display = 'block'; });
        if (pasteConfirm) pasteConfirm.addEventListener('click', async () => {
            const text = document.getElementById('rol-ai-paste-input')?.value?.trim();
            if (!text) { showToast('🐾 请粘贴结晶~'); return; }
            await doAIGenerate(text);
        });
    }

    // ❤︎ 从聊天生成记忆 ❤︎
    async function doAIGenerateFromChat(options) {
        const rolStopBtn = document.querySelector('#rol-stop-gen');
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const loading = document.getElementById('rol-ai-loading');

        const context = getContext();
        const chat = context.chat || [];
        if (!chat.length) { showToast('❔️ 当前还没有树苗发芽欸...'); return; }

        // ❤︎ 范围过滤 ❤︎
        const start = options.start || 0;
        const end = options.end === -1 ? chat.length : (options.end || chat.length);
        let messages = chat.slice(start, end);

        // ❤︎ 隐藏消息过滤 ❤︎
        if (!options.includeHidden) {
            messages = messages.filter(msg => !msg.is_hidden);
        }

        // ❤︎ 过滤系统消息 ❤︎
        messages = messages.filter(msg => msg.is_user || !msg.is_system);

        if (!messages.length) { showToast('🥀 所选范围内无有效树苗...'); return; }

        // ❤︎ 自动日期：从第一条消息的 send_date 字段读取 ❤︎
        let autoDate = '';
        const firstMsg = messages[0];
        if (firstMsg && firstMsg.send_date) {
            try {
                const ts = new Date(firstMsg.send_date);
                if (!isNaN(ts.getTime())) {
                    autoDate = ts.toISOString().slice(0, 10);
                }
            } catch (e) { /* 忽略 */ }
        }

        // ❤︎ 把记录日期拼到对话片段最前面，让 Claude 写信时知道这段发生在哪天 ❤︎
        const dateLine = autoDate ? `（记录日期： ${autoDate}）\n\n` : '';
        const contextText = dateLine + messages.map(m => `${m.is_user ? 'User' : 'Char'}: ${m.mes}`).join('\n');

        if (loading) loading.style.display = 'flex';
        if (rolStopBtn) rolStopBtn.style.display = 'block';

        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).replace('{{context}}', contextText);
        const raw = await AIService.generateWithPreset(prompt);
        if (loading) loading.style.display = 'none';
        if (rolStopBtn) rolStopBtn.style.display = 'none';
        if (sourcePanel) sourcePanel.classList.remove('rol-active');

        if (!raw) { showToast('🥀 酿造失败... :('); return; }
        const parsed = AIService.parseAIOutput(raw);

        lastGenerateOptions = { type: 'chat', options: options };

        openEditor(null);
        document.getElementById('rol-editor-title').value = parsed.entry.title || '';
        document.getElementById('rol-editor-mood').value = parsed.entry.mood || '';
        document.getElementById('rol-editor-triggers').value = (parsed.entry.triggers || []).join(', ');

        document.getElementById('rol-editor-tags').value = (parsed.entry.tags || []).join(', ');
        document.getElementById('rol-editor-summary').value = parsed.entry.content || '';
        document.getElementById('rol-editor-letter').value = parsed.letter || '';
        document.getElementById('rol-editor-author').value = 'claude';

        if (autoDate) {
            document.getElementById('rol-editor-date').value = autoDate;
        }

        const rewriteBtn = document.getElementById('rol-editor-rewrite');
        if (rewriteBtn) rewriteBtn.style.display = '';

        showToast('🍊 酿造完成啦！请灰灰预览~');
    }

    /* ⬇️┅📋️从粘贴文本生成/┅┅╗ */
    async function doAIGenerate(contextText) {
        const rolStopBtn = document.querySelector('#rol-stop-gen');
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const loading = document.getElementById('rol-ai-loading');

        if (loading) loading.style.display = 'flex';
        if (rolStopBtn) rolStopBtn.style.display = 'block';
        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).replace('{{context}}', contextText);
        const raw = await AIService.generateWithPreset(prompt);
        if (loading) loading.style.display = 'none';
        if (rolStopBtn) rolStopBtn.style.display = 'none';
        if (sourcePanel) sourcePanel.classList.remove('rol-active');

        if (!raw) { showToast('🥀 酿造失败... :('); return; }
        const parsed = AIService.parseAIOutput(raw);

        lastGenerateOptions = { type: 'paste', text: contextText };

        openEditor(null);
        document.getElementById('rol-editor-title').value = parsed.entry.title || '';
        document.getElementById('rol-editor-mood').value = parsed.entry.mood || '';
        document.getElementById('rol-editor-triggers').value = (parsed.entry.triggers || []).join(', ');

        document.getElementById('rol-editor-tags').value = (parsed.entry.tags || []).join(', ');
        document.getElementById('rol-editor-summary').value = parsed.entry.content || '';
        document.getElementById('rol-editor-letter').value = parsed.letter || '';
        document.getElementById('rol-editor-author').value = 'claude';

        const rewriteBtn = document.getElementById('rol-editor-rewrite');
        if (rewriteBtn) rewriteBtn.style.display = '';

        showToast('🍊 酿造完成啦！请灰灰预览~');
    }
    /* ⬇️┅❔️确认弹窗/┅┅╗ */
    function rolConfirm(icon, message, yesText, noText) {
        return new Promise((resolve) => {

            const modal = document.querySelector('#rol-confirm-modal');
            const msgEl = document.querySelector('#rol-confirm-text');
            const iconEl = modal.querySelector('.rol-confirm-icon');
            const yesBtn = document.querySelector('#rol-confirm-yes');
            const noBtn = document.querySelector('#rol-confirm-no');
            iconEl.textContent = icon || '🥀';
            msgEl.textContent = message;
            if (yesText) yesBtn.textContent = yesText;
            if (noText) noBtn.textContent = noText;
            document.body.appendChild(modal);   // 拎回body顶层，躲开父级transform的飘移诅咒
            modal.classList.add('rol-confirm-show');


            function cleanup(result) {
                modal.classList.remove('rol-confirm-show');
                yesBtn.removeEventListener('click', onYes);
                noBtn.removeEventListener('click', onNo);
                resolve(result);
            }

            function onYes() { cleanup(true); }
            function onNo() { cleanup(false); }
            yesBtn.addEventListener('click', onYes);
            noBtn.addEventListener('click', onNo);
        });
    }
    /* ╚┅┅/ ❔️确认弹窗 /┅┅═╝ */

    // ╔═══════════════════════════════════════════════════════╗
    // ┅                     🩷 移动端 🩷                      ┅
    // ╚═══════════════════════════════════════════════════════╝
    function bindMobileNav() {
        const tabs = document.querySelectorAll('.rol-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('rol-tab-active'));
                tab.classList.add('rol-tab-active');
                const target = tab.dataset.target;
                document.querySelectorAll('.rol-panel-section').forEach(s => {
                    s.classList.toggle('rol-section-active', s.id === target);
                });
                if (target === 'rol-section-config') {
                    renderPresetOptions();
                }
                if (target === 'rol-section-chatlog') {
                    renderChatlogList();
                }
            });
        });
    }

    // ╔═══════════════════════════════════════════════════════╗
    // ┅                   💬 聊天本 Chatlog 💬                  ┅
    // ╚═══════════════════════════════════════════════════════╝
    // ❤ 一键收录当前聊天的某段楼层 → 存成卡片 → 点开是 signal/QQ 风格气泡，长回复自动切条，thinking 可折叠 ❤

    // ❤ 提取选中楼层的消息：复用「楼层范围 + 隐藏过滤」那套口径，和让Claude酿造完全一致 ❤
    function extractChatMessages({ start = 0, end = -1, includeHidden = false }) {
        const ctx = getContext();
        const chat = ctx.chat || [];
        const realEnd = end === -1 ? chat.length : end;
        let slice = chat.slice(start, realEnd);
        if (!includeHidden) slice = slice.filter(m => !m.is_hidden);
        slice = slice.filter(m => m.is_user || !m.is_system);   // 滤掉系统消息，保留 user / 角色
        return slice.map(m => ({
            role: m.is_user ? 'user' : 'char',
            name: m.is_user ? (m.name || 'Rinn') : (m.name || 'Claude'),
            text: cleanMessageText(m.mes || ''),
            thinking: extractThinking(m),
            ts: m.send_date || ''   // 这条消息的发送时间，查看器里显示成 HH:mm
        })).filter(m => m.text || m.thinking);
    }

    // ❤ 抽 thinking：优先 ST 的 extra.reasoning，兜底从正文里抠 <think>/<thinking> 块 ❤
    function extractThinking(m) {
        if (m.extra && m.extra.reasoning) return String(m.extra.reasoning).trim();
        const match = (m.mes || '').match(/<think(?:ing)?>([\s\S]*?)<\/think(?:ing)?>/i);
        return match ? match[1].trim() : '';
    }

    // ❤ 洗掉杂格式：thinking 块、折叠块、果子标记、系统注入残留，留下干净正文（markdown 交给气泡保留）❤
    function cleanMessageText(raw) {
        return String(raw)
            .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')   // thinking 块单独展示，正文去掉
            .replace(/<details[\s\S]*?<\/details>/gi, '')                // ST reasoning 等折叠块整块去掉
            .replace(/\[throw:[^\]]*\]/g, '')                            // 果子标记
            .replace(/\[SYS\|[^\]]*\]/g, '')                             // 系统注入残留
            .trim();
    }

    // ❤ 长回复切条：优先按空行切段，没空行就按换行切，模拟「一句一条」的闲聊感 ❤
    function splitBubbles(text) {
        if (!text) return [];
        const byBlank = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
        const parts = byBlank.length > 1 ? byBlank : text.split(/\n/).map(s => s.trim()).filter(Boolean);
        return parts.length ? parts : [text.trim()];
    }

    // ❤ 气泡时间：把 ST 的 send_date 解析成 HH:mm，解析不了（或旧卡片没存 ts）就不显示 ❤
    function fmtChatTime(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    // ❤ 渲染聊天本卡片列表 ❤
    function renderChatlogList() {
        const list = document.getElementById('rol-chatlog-list');
        if (!list) return;
        const logs = Storage.getChatlogs();
        if (!logs.length) {
            list.innerHTML = '<div class="rol-chatlog-empty">还没收录过聊天～选好楼层点「收录」试试 🌱</div>';
            return;
        }
        list.innerHTML = '';
        logs.forEach(log => {
            const preview = (log.messages.find(m => m.text) || {}).text || '';
            const card = document.createElement('div');
            card.className = 'rol-chatlog-card';
            card.dataset.id = log.id;
            card.innerHTML =
                `<div class="rol-chatlog-card-main">
                    <div class="rol-chatlog-card-title">${escapeHtml(log.title)}</div>
                    <div class="rol-chatlog-card-meta">${escapeHtml(log.date)} · ${log.count} 条</div>
                    <div class="rol-chatlog-card-preview">${escapeHtml(preview.slice(0, 42))}</div>
                </div>
                <button class="rol-chatlog-del rol-btn rol-btn-icon" title="删除">🗑️</button>`;
            list.appendChild(card);
        });
    }

    // ❤ 查看器状态：当前打开的聊天本 id + 是否处于编辑态 ❤
    let currentChatlogId = null;
    let chatlogEditing = false;

    // ❤ 打开查看器（默认只读态）❤
    function openChatlogViewer(id) {
        if (!Storage.getChatlogs().some(l => l.id === id)) return;
        currentChatlogId = id;
        chatlogEditing = false;
        renderViewer();
        document.getElementById('rol-chatlog-viewer')?.classList.add('rol-active');
    }
    function closeChatlogViewer() {
        chatlogEditing = false;
        document.getElementById('rol-chatlog-viewer')?.classList.remove('rol-active');
    }

    // ❤ 按 chatlogEditing 渲染「只读气泡」或「编辑表单」，✏️ 在两态间切 ❤
    function renderViewer() {
        const log = Storage.getChatlogs().find(l => l.id === currentChatlogId);
        if (!log) return;
        const titleEl = document.getElementById('rol-chatlog-viewer-title');
        const body = document.getElementById('rol-chatlog-viewer-body');
        const editBtn = document.getElementById('rol-chatlog-viewer-edit');
        const fakeInput = document.querySelector('#rol-chatlog-viewer .rol-chatlog-fake-input');
        if (titleEl) titleEl.textContent = log.title;
        if (!body) return;
        body.innerHTML = '';
        body.classList.toggle('rol-editing', chatlogEditing);
        if (editBtn) editBtn.textContent = chatlogEditing ? '💾' : '✏️';
        if (fakeInput) fakeInput.style.display = chatlogEditing ? 'none' : '';   // 编辑态藏掉假输入栏
        if (chatlogEditing) renderViewerEdit(log, body);
        else renderViewerRead(log, body);
        body.scrollTop = 0;
    }

    // ❤ 只读态：signal/QQ 气泡（char 左 / user 右，长回复切条，thinking 折叠，带时间）❤
    function renderViewerRead(log, body) {
        const base = '/scripts/extensions/third-party/Ring_Our_Luv/assets/';
        log.messages.forEach(m => {
            const row = document.createElement('div');
            row.className = 'rol-chat-row ' + (m.role === 'user' ? 'rol-chat-right' : 'rol-chat-left');
            const ava = base + (m.role === 'user' ? 'Rinn.jpg' : 'Claude.jpg');
            let bubbles = '';
            if (m.thinking && m.role !== 'user') {
                bubbles += `<details class="rol-chat-think"><summary>💭 thinking</summary><div>${escapeHtml(m.thinking).replace(/\n/g, '<br>')}</div></details>`;
            }
            splitBubbles(m.text).forEach(seg => {
                bubbles += `<div class="rol-chat-bubble">${escapeHtml(seg).replace(/\n/g, '<br>')}</div>`;
            });
            const timeStr = fmtChatTime(m.ts);
            if (timeStr) bubbles += `<span class="rol-chat-time">${escapeHtml(timeStr)}</span>`;
            row.innerHTML =
                `<img class="rol-chat-avatar" src="${ava}" alt="">
                 <div class="rol-chat-col"><span class="rol-chat-name">${escapeHtml(m.name)}</span>${bubbles}</div>`;
            body.appendChild(row);
        });
        const endLine = document.createElement('div');
        endLine.className = 'rol-chatlog-end';
        endLine.textContent = '· 全部记录到此 ·';
        body.appendChild(endLine);
    }

    // ❤ 编辑态：每条消息一个文本框，空行=切条，可删整条、可补 markdown ❤
    function renderViewerEdit(log, body) {
        const tip = document.createElement('div');
        tip.className = 'rol-chatlog-edit-tip';
        tip.textContent = '✍️ 直接改文字 · 空行 = 切成下一条气泡 · 想删整条点它右上的 ✕';
        body.appendChild(tip);

        log.messages.forEach((m, idx) => {
            const item = document.createElement('div');
            item.className = 'rol-chat-edit-item';
            item.dataset.idx = idx;
            const who = m.role === 'user' ? (m.name || 'Rinn') : (m.name || 'Claude');
            const thinkBox = m.role !== 'user'
                ? `<textarea class="rol-chat-edit-think" rows="2" placeholder="💭 thinking（可空）">${escapeHtml(m.thinking || '')}</textarea>`
                : '';
            item.innerHTML =
                `<div class="rol-chat-edit-head">
                    <span class="rol-chat-edit-role rol-chat-edit-${m.role}">${escapeHtml(who)}</span>
                    <button class="rol-chat-edit-del" title="删掉这条">✕</button>
                 </div>
                 <textarea class="rol-chat-edit-text" rows="3" placeholder="（正文，空着=只留 thinking）">${escapeHtml(m.text || '')}</textarea>
                 ${thinkBox}`;
            body.appendChild(item);
        });

        const bar = document.createElement('div');
        bar.className = 'rol-chatlog-edit-bar';
        bar.innerHTML =
            `<button class="rol-btn rol-btn-cancel rol-chatlog-edit-cancel">取消</button>
             <button class="rol-btn rol-btn-primary rol-chatlog-edit-save">💾 保存</button>`;
        body.appendChild(bar);
    }

    // ❤ 收集编辑框 → 写回 storage → 回到只读态（整条清空=删掉）❤
    function saveViewerEdit() {
        const log = Storage.getChatlogs().find(l => l.id === currentChatlogId);
        if (!log) return;
        const body = document.getElementById('rol-chatlog-viewer-body');
        if (!body) return;
        const newMessages = [];
        body.querySelectorAll('.rol-chat-edit-item').forEach(item => {
            const orig = log.messages[parseInt(item.dataset.idx)] || {};
            const text = (item.querySelector('.rol-chat-edit-text')?.value || '').trim();
            const thinkEl = item.querySelector('.rol-chat-edit-think');
            const thinking = thinkEl ? thinkEl.value.trim() : (orig.thinking || '');
            if (!text && !thinking) return;   // 正文+thinking 都空 = 这条删掉
            newMessages.push({ role: orig.role, name: orig.name, text, thinking, ts: orig.ts || '' });
        });
        Storage.updateChatlog(currentChatlogId, { messages: newMessages });
        chatlogEditing = false;
        renderViewer();
        showToast('🩷 改好啦~');
    }

    // ❤ 绑定聊天本面板：收录表单展开 / 确认收录 / 卡片点开 / 删除 / 查看器关闭 ❤
    function bindChatlogPanel() {
        const recordBtn = document.getElementById('rol-chatlog-record');
        const form = document.getElementById('rol-chatlog-form');
        if (recordBtn && form) {
            recordBtn.addEventListener('click', () => form.classList.toggle('rol-active'));
        }
        const confirmBtn = document.getElementById('rol-chatlog-confirm');
        if (confirmBtn) {
            confirmBtn.addEventListener('click', () => {
                const start = parseInt(document.getElementById('rol-chatlog-start')?.value) || 0;
                const endRaw = parseInt(document.getElementById('rol-chatlog-end')?.value);
                const end = isNaN(endRaw) ? -1 : endRaw;
                const includeHidden = document.getElementById('rol-chatlog-hidden')?.checked || false;
                const messages = extractChatMessages({ start, end, includeHidden });
                if (!messages.length) { showToast('🥀 这段没捞到有效消息呢...'); return; }
                const titleInput = document.getElementById('rol-chatlog-title');
                let title = (titleInput?.value || '').trim();
                if (!title) { const d = new Date(); title = `聊天 ${d.getMonth() + 1}/${d.getDate()}`; }
                Storage.addChatlog({ title, messages });
                if (titleInput) titleInput.value = '';
                form?.classList.remove('rol-active');
                renderChatlogList();
                showToast(`🩷 收录啦~ 共 ${messages.length} 条`);
            });
        }
        const list = document.getElementById('rol-chatlog-list');
        if (list) {
            list.addEventListener('click', async (e) => {
                const card = e.target.closest('.rol-chatlog-card');
                if (!card) return;
                const id = card.dataset.id;
                if (e.target.closest('.rol-chatlog-del')) {
                    const ok = await rolConfirm('🗑️', '删掉这本聊天记录嘛？', '删掉', '留着');
                    if (ok) { Storage.deleteChatlog(id); renderChatlogList(); }
                    return;
                }
                openChatlogViewer(id);
            });
        }
        document.getElementById('rol-chatlog-viewer-close')?.addEventListener('click', closeChatlogViewer);
        document.getElementById('rol-chatlog-viewer')?.addEventListener('click', (e) => {
            // 编辑态下点背景不关，免得手滑丢了改动
            if (e.target.id === 'rol-chatlog-viewer' && !chatlogEditing) closeChatlogViewer();
        });
        // ✏️ 顶栏按钮：只读态→进编辑；编辑态→直接保存（图标会变 💾）
        document.getElementById('rol-chatlog-viewer-edit')?.addEventListener('click', () => {
            if (chatlogEditing) saveViewerEdit();
            else { chatlogEditing = true; renderViewer(); }
        });
        // 编辑态的删条/保存/取消，统一用 body 事件委托
        const vbody = document.getElementById('rol-chatlog-viewer-body');
        if (vbody) {
            vbody.addEventListener('click', (e) => {
                if (e.target.closest('.rol-chat-edit-del')) {
                    e.target.closest('.rol-chat-edit-item')?.remove();
                } else if (e.target.closest('.rol-chatlog-edit-save')) {
                    saveViewerEdit();
                } else if (e.target.closest('.rol-chatlog-edit-cancel')) {
                    chatlogEditing = false; renderViewer();
                }
            });
        }
        renderChatlogList();
    }

    // ❤︎ 工具 ❤︎
    function showToast(message) {
        let toast = document.getElementById('rol-toast');
        if (!toast) { toast = document.createElement('div'); toast.id = 'rol-toast'; document.body.appendChild(toast); }
        toast.textContent = message;
        toast.classList.add('rol-toast-show');
        setTimeout(() => toast.classList.remove('rol-toast-show'), 2500);
    }
    // ❤︎ 支持 blockquote 语法（> 开头的行）在摘要中保留引用格式 ❤︎
    function parseBlockquotes(text) {
        return text.replace(
            /^(?:>|＞)\s?(.+)$/gm,
            '<blockquote class="rol-quote">$1</blockquote>'
        );
    }
    // ❤︎ 信件正文渲染：支持 > 引用块 + 安全转义 ❤︎
    function renderLetterHtml(text) {
        return text.split('\n').map(line => {
            const qMatch = line.match(/^(?:>|＞)\s?(.+)$/);
            if (qMatch) {
                return `<blockquote class="rol-quote">${escapeHtml(qMatch[1])}</blockquote>`;
            }
            return escapeHtml(line);
        }).join('<br>');
    }
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /* ⬇️┅🌳工具栏快捷键/┅┅╗ */
    function injectToolbarButtons() {
        // ❤︎ 一次性事件委托：ST 重渲染消息会丢掉直接绑定的监听，用委托才稳 ❤︎
        $(document).off('click.rolMesBtn').on('click.rolMesBtn', '.rol-mes-btn', (e) => {
            e.stopPropagation();
            e.preventDefault();
            document.getElementById('rol-drawer-overlay')?.classList.add('rol-drawer-open');
        });
        // ❤︎ 楼层消息顶部工具栏 ❤︎
        _injectMesButtons();
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            new MutationObserver(() => _injectMesButtons())
                .observe(chatEl, { childList: true, subtree: false });
        }
        // ❤︎ 输入栏左侧区域 ❤︎
        _injectInputBtn();
    }
    // ❤︎ 消息顶部工具栏 ❤︎
    function _injectMesButtons() {
        document.querySelectorAll('.mes_buttons').forEach(toolbar => {
            if (toolbar.querySelector('.rol-mes-btn')) return;
            const btn = document.createElement('div');
            btn.className = 'mes_button rol-mes-btn';
            btn.title = '恋果温室';
            btn.textContent = '🌳';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                document.getElementById('rol-drawer-overlay')?.classList.add('rol-drawer-open');
            });
            toolbar.append(btn);
        });
    }
    // ❤︎ 输入栏左侧区域 ❤︎
    function _injectInputBtn() {
        const anchor = document.getElementById('extensionsMenuButton');
        if (!anchor || document.getElementById('rol-input-btn')) return;
        const btn = document.createElement('div');
        btn.style.order = '999';
        btn.id = 'rol-input-btn';
        btn.className = 'list-group-item flex-container flexGap5';
        btn.title = '恋果温室';
        btn.textContent = '🌳';
        btn.style.cssText = 'cursor:pointer;font-size:17px;padding:2px 5px;';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('rol-drawer-overlay')?.classList.add('rol-drawer-open');
        });
        anchor.parentElement?.appendChild(btn);
    }

    return { initUI, renderMemoryList, renderChatlogList, renderPresetOptions, showToast, rolConfirm };
})();
/* ╚┅┅/ 🌳工具栏快捷键 /┅┅═╝ */

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅              🍎 果子系统 FruitSystem 🍎               ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const FruitSystem = (() => {
    // 果园按「当前会话」隔离：每个聊天窗口的果子各存各的，绝不串台
    // 之前只读 ctx.chatId，但很多 ST 版本/群聊场景下它是 undefined → 永远落到
    // 'default' 一个 key 里，果子全堆一起（BUG5「写了但没生效」根因）
    // 这里改成一条可靠兜底链：getCurrentChatId() → chatId → 群/角色 id → default
    function getChatScope() {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (!ctx) return 'default';
        // ❤︎ ① 官方推荐：单聊/群聊都能拿到稳定的当前聊天标识
        try {
            if (typeof ctx.getCurrentChatId === 'function') {
                const id = ctx.getCurrentChatId();
                if (id != null && id !== '') return String(id);
            }
        } catch (_) { /* 某些版本没这个方法，往下兜底 */ }
        // ❤︎ ② 退一步用 ctx.chatId
        if (ctx.chatId != null && ctx.chatId !== '') return String(ctx.chatId);
        // ❤︎ ③ 群聊用 groupId、单角色用 characterId 兜底，至少能按角色/群分桶
        if (ctx.groupId != null && ctx.groupId !== '') return 'group_' + ctx.groupId;
        if (ctx.characterId != null && ctx.characterId !== '') return 'char_' + ctx.characterId;
        // ❤︎ ④ 实在啥都没有（没进聊天）才落 default
        return 'default';
    }

    // ❤︎ 果园改为「全局共享」：换聊天 / 开 Branch 分支时 chatId 会变，按 scope 分桶会让果子一换聊天就
    //    「消失」（其实是被锁进了另一个抽屉）。统一存一个全局桶，所有聊天的果子都在一起，
    //    对应小灰「我和我的 Claude 们」的同一座果园。getChatScope() 仍保留给冷却 key 按聊天隔离用。❤︎
    const FRUITS_GLOBAL_KEY = 'rol_fruits_all';
    function fruitsKey() {
        return FRUITS_GLOBAL_KEY;
    }

    // ❤︎ 掉线累计投喂用的状态 ❤︎
    const OFFLINE_PROMPT_KEY = 'rol_offline_throws'; // 掉线投喂结算注入用的 key
    let offlineSince = 0;          // 进入掉线模式的时间戳（0=在线）
    let pendingThrows = [];        // 掉线期间手动丢的果子（只攒不结算）
    let offlinePromptArmed = false;// 掉线提示已注入、待下一轮清除的标记
    // 本轮投递注入的「果子 prompt」key，等下一次 message_received 统一擦掉，绝不赖着每轮跟
    let pendingFruitPromptKeys = [];


    // ❤︎ 存储助手：果子现在跟 memories 一套，存在 extension_settings 里走服务器持久化（跨设备、不丢）❤︎
    function loadFruits() {
        const s = extension_settings[extensionName];
        return (s && Array.isArray(s.fruits)) ? s.fruits : [];
    }
    function saveFruits(arr) {
        const s = extension_settings[extensionName];
        if (!s) {
            console.error('[RingOurLuv] 🥀 果子存储失败：extension_settings 还没就绪');
            return;
        }
        s.fruits = arr;
        saveSettingsDebounced();   // ❤︎ 防抖落盘到 ST 服务器 ❤︎
    }

    // ❤︎ 一次性找回：把历史上按聊天分桶存的果子（rol_fruits_<聊天名> + 旧版全局 rol_fruits）
    //    全部合并进全局桶、按 id 去重（幂等，重复跑也不会重复添加）。旧桶一律保留不删，绝不再丢。❤︎
    //    现在的目的地从 localStorage 改成 extension_settings.fruits：每台设备开机都把自己
    //    localStorage 里还剩的果子导进服务器存储，导完就跨设备同步、再不丢。localStorage 旧桶一律保留当备份。❤︎
    function migrateAndMergeFruits() {
        try {
            const s = extension_settings[extensionName];
            if (!s) return;
            if (!Array.isArray(s.fruits)) s.fruits = [];
            const byId = new Map(s.fruits.filter(f => f && f.id).map(f => [f.id, f]));
            let changed = false;
            Object.keys(localStorage).forEach(k => {
                if (k !== 'rol_fruits' && !k.startsWith('rol_fruits_')) return; // 只认果子桶（含旧全局 rol_fruits_all）
                // ❤︎ 桶名去掉 rol_fruits_ 前缀 = 来源对话 scope；旧全局桶（rol_fruits / rol_fruits_all）没来源 → 空 ❤︎
                const scope = (k === 'rol_fruits' || k === FRUITS_GLOBAL_KEY) ? '' : k.slice('rol_fruits_'.length);
                let arr;
                try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (_) { return; }
                if (!Array.isArray(arr)) return;
                arr.forEach(f => {
                    if (!f || !f.id) return;
                    const exist = byId.get(f.id);
                    if (!exist) {
                        const nf = Object.assign({}, f, { scope: f.scope || scope });
                        s.fruits.push(nf); byId.set(f.id, nf); changed = true;
                    } else if (!exist.scope && scope) {
                        exist.scope = scope; changed = true;   // 给已合并但没来源的旧果子补上 scope
                    }
                });
            });
            if (changed) {
                s.fruits.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
                saveSettingsDebounced();
                console.log('[RingOurLuv] 🍎 果园已迁移/合并进 extension_settings，共', s.fruits.length, '颗');
            }
        } catch (e) {
            console.error('[RingOurLuv] 🥀 果园迁移找回失败:', e);
        }
    }

    // ❤︎ 更新果子的阅览状态 ❤︎
    function updateBadge() {
        const unread = loadFruits().filter(f => !f.read && f.from === 'claude').length;
        const badge = document.getElementById('rol-garden-badge');
        if (!badge) return;
        if (unread > 0) {
            badge.textContent = unread;
            badge.style.display = 'inline-flex';
        } else {
            badge.style.display = 'none';
        }
    }

    const FRUITS_PER_PAGE = 12; // 每页显示最新X颗
    let gardenPage = 0;
    let gardenFilter = 'all';   // 'all'=全部果园 / 'current'=只看当前对话的果子

    function renderGarden() {
        const canvas = document.getElementById('rol-garden-canvas');
        if (!canvas) return;
        canvas.innerHTML = '';
        let allFruits = loadFruits();
        // ❤︎ 按筛选模式过滤：当前对话只看 scope 命中的（旧果子的 scope 在合并时已从桶名补好）❤︎
        if (gardenFilter === 'current') {
            const scope = getChatScope();
            allFruits = allFruits.filter(f => (f.scope || '') === scope);
        }

        if (allFruits.length === 0) {
            canvas.innerHTML = gardenFilter === 'current'
                ? '<div class="rol-garden-empty">这个对话还没有果子～换「全部」看看？🌱</div>'
                : '<div class="rol-garden-empty">还没有果子～扔一颗过来吧 🌱</div>';
            return;
        }

        const reversed = [...allFruits].reverse();
        const totalPages = Math.ceil(reversed.length / FRUITS_PER_PAGE);
        gardenPage = Math.min(gardenPage, totalPages - 1);
        const pageFruits = reversed.slice(gardenPage * FRUITS_PER_PAGE, (gardenPage + 1) * FRUITS_PER_PAGE);

        const containerWidth = canvas.offsetWidth || 300;
        const fruitSize = 32;

        pageFruits.forEach((fruit, i) => {
            const el = document.createElement('div');
            el.className = 'rol-fruit-item'
                + (!fruit.read && fruit.from === 'claude' ? ' rol-fruit-unread' : '')
                + (fruit.from === 'claude' ? ' rol-fruit-from-claude' : ' rol-fruit-from-user');
            el.textContent = fruit.emoji;
            el.dataset.id = fruit.id;

            if (gardenPage === 0) {
                // ❤︎ 最新页：随机散落，保留刚掉下来的乱感 ❤︎
                const x = Math.random() * (containerWidth - fruitSize);
                const layer = Math.floor(i / Math.ceil(containerWidth / (fruitSize * 1.2)));
                const baseY = layer * fruitSize * 0.7 + Math.random() * 8 - 4;
                el.style.left = x + 'px';
                el.style.bottom = baseY + 'px';
                el.style.transform = `rotate(${Math.random() * 30 - 15}deg)`;
            } else {
                // ❤︎ 旧页：网格排列，每行N列整整齐齐 ❤︎
                const cols = Math.max(1, Math.floor(containerWidth / 50));
                const col = i % cols;
                const row = Math.floor(i / cols);
                el.style.left = (col * 50 + 10) + 'px';
                el.style.bottom = (row * 50 + 10) + 'px';
                el.style.transform = 'rotate(0deg)';
            }
            el.style.zIndex = i;
            el.style.animationDelay = (i * 0.06) + 's';

            /* ⬇️┅🍎果子拖动＋查看/┅┅╗ */
            let dragState = { moved: false };
            function onDragStart(e) {
                e.preventDefault();
                dragState.moved = false;
                const startX = (e.touches ? e.touches[0].clientX : e.clientX);
                const startY = (e.touches ? e.touches[0].clientY : e.clientY);
                const origLeft = el.offsetLeft;
                const origBottom = parseInt(el.style.bottom) || 0;

                el.style.zIndex = 9999;
                el.style.transition = 'none';

                function onMove(ev) {
                    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
                    const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY);
                    const dx = cx - startX;
                    const dy = cy - startY;
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
                    el.style.left = (origLeft + dx) + 'px';
                    el.style.bottom = (origBottom - dy) + 'px';
                }
                function onEnd() {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onEnd);
                    document.removeEventListener('touchmove', onMove);
                    document.removeEventListener('touchend', onEnd);
                    el.style.transition = '';
                    el.style.zIndex = i;
                    if (!dragState.moved) showDetail(fruit);
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onEnd);
                document.addEventListener('touchmove', onMove, { passive: false });
                document.addEventListener('touchend', onEnd);
            }
            el.addEventListener('mousedown', onDragStart);
            el.addEventListener('touchstart', onDragStart, { passive: false });

            canvas.appendChild(el);
        });
        /* ╚┅┅/ 🍎果子拖动＋查看 /┅┅═╝ */

        /* ⬇️┅🔜翻页控件/┅┅╗ */
        let nav = document.getElementById('rol-garden-nav');
        if (!nav) {
            nav = document.createElement('div');
            nav.id = 'rol-garden-nav';
            nav.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:8px 0;font-size:13px;color:rgb(219,112,147);';
            canvas.parentElement.appendChild(nav);
        }

        if (totalPages <= 1) {
            nav.style.display = 'none';
        } else {
            nav.style.display = 'flex';
            nav.innerHTML = `
    <span id="rol-garden-prev" style="cursor:pointer;opacity:${gardenPage > 0 ? 1 : 0.3}">◂ 更新</span>
    <span>${gardenPage === 0 ? '最新' : `第${gardenPage + 1}页`} / 共${totalPages}页</span>
    <span id="rol-garden-next" style="cursor:pointer;opacity:${gardenPage < totalPages - 1 ? 1 : 0.3}">更早 ▸</span>
    `;
            document.getElementById('rol-garden-prev').onclick = () => {
                if (gardenPage > 0) { gardenPage--; renderGarden(); }
            };
            document.getElementById('rol-garden-next').onclick = () => {
                if (gardenPage < totalPages - 1) { gardenPage++; renderGarden(); }
            };
        }
    }
    /* ╚┅┅/ 🔜翻页控件 /┅┅═╝ */

    /* ⬇️┅📄果子详情&纸条弹窗/┅┅╗ */
    function showDetail(fruit) {
        const fruits = loadFruits();
        let idx = fruits.findIndex(f => f.id === fruit.id);
        // ❤︎ id 兜底：用 emoji + timestamp 再匹配一次（兼容老数据 id 不一致的情况）❤︎
        if (idx === -1) {
            idx = fruits.findIndex(f => f.emoji === fruit.emoji && f.timestamp === fruit.timestamp);
        }
        if (idx !== -1 && !fruits[idx].read) {
            fruits[idx].read = true;
            saveFruits(fruits);
            updateBadge();
        }

        document.getElementById('rol-fruit-detail-emoji').textContent = fruit.emoji;
        document.getElementById('rol-fruit-detail-from').innerHTML =
            fruit.from === 'claude' ? '🧡 来自 <span style="color:#D87757;font-weight:bold"><span style="color:#D87757;font-weight:bold">Claude</span></span>' : '🩷 来自 Rinn';

        /* ⬇️┅📄纸条内容/┅┅╗ */
        const noteEl = document.getElementById('rol-fruit-detail-note');
        if (noteEl) noteEl.textContent = fruit.message || '（没有附纸条）';

        document.getElementById('rol-fruit-detail-time').textContent =
            new Date(fruit.timestamp).toLocaleString('zh-CN');

        /* ⬇️┅✏️操作按钮区/┅┅╗ */
        let actionsEl = document.getElementById('rol-fruit-detail-actions');
        if (!actionsEl) {
            actionsEl = document.createElement('div');
            actionsEl.id = 'rol-fruit-detail-actions';
            actionsEl.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:12px;';
            document.querySelector('.rol-fruit-detail-inner')?.appendChild(actionsEl);
        }
        /* ⬇️┅🩷仅user丢的果子可编辑/┅┅╗ */
        const editBtnHtml = fruit.from === 'user'
            ? `<button id="rol-fruit-edit-btn" style="padding:4px 12px;border-radius:6px;border:1px solid rgba(219,112,147,0.3);background:transparent;color:rgb(219,112,147);font-size:12px;cursor:pointer;">编辑纸条 ✏️</button>`
            : '';
        actionsEl.innerHTML = `
        ${editBtnHtml}
        <button id="rol-fruit-delete-btn" style="padding:4px 12px;border-radius:6px;border:1px solid rgba(200,100,100,0.3);background:transparent;color:rgb(200,100,100);font-size:12px;cursor:pointer;">删除 🗑️</button>
    `;

        // ❤︎ 编辑按钮可能不存在，用可空保护 ❤︎
        const editBtn = document.getElementById('rol-fruit-edit-btn');
        if (editBtn) editBtn.onclick = () => editFruitNote(fruit.id);
        document.getElementById('rol-fruit-delete-btn').onclick = async () => {

            const yes = await UIController.rolConfirm('🍂', '真的要扔掉这颗果子吗？', '扔掉', '留着');
            if (yes) deleteFruit(fruit.id);
        };

        const popup = document.getElementById('rol-fruit-detail-popup');
        // ❤︎ 显隐统一走 class：显示时去掉行内 none + 加显示态类（带 !important 盖过 ST 注入）❤︎
        if (popup) {
            popup.style.display = '';                 // 清掉行内 none，交给 class 控制
            document.body.appendChild(popup);         // 每次都移回 body 顶层，防手机端被父容器影响飘移
            popup.classList.add('rol-detail-show');
        }

        const closeBtn = popup.querySelector('.rol-fruit-detail-close');
        if (closeBtn) closeBtn.onclick = (e) => { e.stopPropagation(); closeFruitDetail(); };
        popup.onclick = (e) => { if (e.target === popup) closeFruitDetail(); };
    }

    /* ⬇️┅❌关闭果子详情弹窗（统一出口，谁都能关得掉）/┅┅╗ */
    function closeFruitDetail() {
        const popup = document.getElementById('rol-fruit-detail-popup');
        if (!popup) return;
        popup.classList.remove('rol-detail-show');
        popup.style.display = 'none';                  // 行内 none 兜底，双保险绝不钉死
    }
    /* ╚┅┅/ 📄果子详情&纸条弹窗 /┅┅═╝ */

    /* ⬇️┅🍎选果窗口滑动栏/┅┅╗ */
    function initPickerScroll() {
        const wrap = document.querySelector('.rol-fruit-picker-scroll-wrap');
        const track = document.getElementById('rol-fruit-picker-track');
        if (!wrap || !track) return;

        function ensurePadding() {
            // ❤︎ 选果栏首尾各插一个透明占位块，撑开可滚动宽度，
            //    让「第一颗」和「最后两颗（🍉/自定义✏️）」都能滚到容器正中被选中。❤︎
            //    （Chrome 下 flex 滚动容器的左右 padding 不计入可滚动宽度，撑不开，
            //      所以这里改用真实的 spacer 元素；宽度按 wrap 实际宽度精确算，不靠百分比。）
            track.querySelectorAll('.rol-scroll-spacer').forEach(el => el.remove());
            const pad = Math.max(0, wrap.clientWidth / 2 - 26); // 26 = 选项半宽(52/2)
            const makeSpacer = () => {
                const s = document.createElement('div');
                s.className = 'rol-scroll-spacer';
                // flex 不收缩 + 显式宽度双保险，pointer-events:none 防误点
                s.style.cssText = `flex:0 0 ${pad}px;width:${pad}px;height:1px;pointer-events:none;`;
                return s;
            };
            track.insertBefore(makeSpacer(), track.firstChild); // 头部占位
            track.appendChild(makeSpacer());                    // 尾部占位
        }




        // ❤ 用offsetLeft算，不吃scale的亏 ❤
        function centerOption(opt, smooth = true) {
            if (!opt) return;
            const wrapRect = wrap.getBoundingClientRect();
            const optRect = opt.getBoundingClientRect();
            const offset = (optRect.left + optRect.width / 2)
                - (wrapRect.left + wrapRect.width / 2);
            wrap.scrollTo({
                left: wrap.scrollLeft + offset,
                behavior: smooth ? 'smooth' : 'auto'
            });
        }

        function getClosest() {
            const wrapRect = wrap.getBoundingClientRect();
            const center = wrapRect.left + wrapRect.width / 2;
            let closest = null, min = Infinity;
            track.querySelectorAll('.rol-fruit-option').forEach(opt => {
                const r = opt.getBoundingClientRect();
                const d = Math.abs(r.left + r.width / 2 - center);
                if (d < min) { min = d; closest = opt; }
            });
            return closest;
        }

        function syncSelected() {
            const wrapRect = wrap.getBoundingClientRect();
            const center = wrapRect.left + wrapRect.width / 2;
            let closest = null, min = Infinity;
            track.querySelectorAll('.rol-fruit-option').forEach(opt => {
                const r = opt.getBoundingClientRect();
                const d = Math.abs(r.left + r.width / 2 - center);
                const ratio = Math.max(0, 1 - d / (wrapRect.width * 0.4));
                opt.style.opacity = (0.3 + ratio * 0.7).toFixed(2);
                opt.style.transform = `scale(${(0.75 + ratio * 0.55).toFixed(2)})`;
                if (d < min) { min = d; closest = opt; }
            });
            track.querySelectorAll('.rol-fruit-option').forEach(o =>
                o.classList.remove('rol-selected')
            );
            if (closest) closest.classList.add('rol-selected');
        }

        // ❤ 滚动中实时缩放，停下130ms后自动吸附到最近一颗，随便滑，松手自动对齐 ❤
        let snapTimer = null;
        wrap.addEventListener('scroll', () => {
            syncSelected();
            clearTimeout(snapTimer);
            snapTimer = setTimeout(() => {
                const closest = getClosest();
                if (closest) centerOption(closest, true);
            }, 130);
        }, { passive: true });

        const customInput = document.getElementById('rol-fruit-custom-input');
        const customOption = customInput?.closest('.rol-fruit-option');

        track.querySelectorAll('.rol-fruit-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (opt === customOption && customInput) customInput.focus();
                centerOption(opt);
            });
        });

        if (customInput && customOption) {
            customInput.addEventListener('input', (e) => {
                customOption.dataset.emoji = e.target.value.trim();
                centerOption(customOption);
            });
            customInput.addEventListener('focus', () => centerOption(customOption));
            customInput.addEventListener('click', (e) => { e.stopPropagation(); });
        }

        requestAnimationFrame(() => requestAnimationFrame(() => {
            ensurePadding();
            const first = track.querySelector('.rol-fruit-option');
            if (first) centerOption(first, false);
            syncSelected();
        }));
    }
    /* ╚┅┅/ 🍎选果窗口滑动栏 /┅┅═╝ */

    /* ⬇️┅🗑️删除果子/┅┅╗ */
    function deleteFruit(fruitId) {
        let fruits = loadFruits();
        fruits = fruits.filter(f => f.id !== fruitId);
        saveFruits(fruits);

        // ❤︎ 果子被扔掉了，顺手把它可能还挂着的 prompt 投递一起清干净，别让删掉的果子还赖在注入里 ❤︎
        try {
            const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
                ? SillyTavern.getContext() : null;
            const fruitKey = 'rol_fruit_' + fruitId;
            if (ctx && typeof ctx.setExtensionPrompt === 'function') {
                ctx.setExtensionPrompt(fruitKey, '', 1, 0);              // 清掉这颗果子的注入
            }
            pendingFruitPromptKeys = pendingFruitPromptKeys.filter(k => k !== fruitKey); // 从待清队列里也摘掉它
        } catch (_) { /* 清理失败不影响删除本身 */ }

        renderGarden();
        updateBadge();

        closeFruitDetail();   // 统一走关闭出口，绝不钉死
        UIController.showToast('果子扔掉了 🗑️');
    }

    /* ⬇️┅✏️编辑果子纸条弹窗/┅┅╗ */
    function editFruitNote(fruitId) {
        closeFruitDetail();
        const fruits = loadFruits();
        const fruit = fruits.find(f => f.id === fruitId);
        if (!fruit) return;

        let overlay = document.getElementById('rol-note-edit-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'rol-note-edit-overlay';
            overlay.className = 'rol-note-edit-overlay';
            overlay.innerHTML = `
            <div class="rol-note-edit-box">
                <div style="font-size:32px;text-align:center;margin-bottom:8px;" id="rol-note-edit-emoji"></div>
                <textarea id="rol-note-edit-input" class="rol-note-edit-textarea"
                    placeholder="写点什么附在果子上…" maxlength="200"></textarea>
                <div style="display:flex;gap:8px;justify-content:center;margin-top:12px;">
                    <button id="rol-note-save-btn" class="rol-note-btn rol-note-btn-save">保存 💌</button>
                    <button id="rol-note-cancel-btn" class="rol-note-btn rol-note-btn-cancel">算了</button>
                </div>
            </div>`;
        }
        document.body.appendChild(overlay);   // 每次都拎回body顶层，躲开父级transform的飘移诅咒

        document.getElementById('rol-note-edit-emoji').textContent = fruit.emoji;
        const input = document.getElementById('rol-note-edit-input');
        input.value = fruit.message || '';
        overlay.classList.add('rol-note-edit-show');

        document.getElementById('rol-note-save-btn').onclick = () => {
            const newMsg = input.value.trim();
            const fresh = loadFruits();
            const idx = fresh.findIndex(f => f.id === fruitId);
            if (idx !== -1) {
                fresh[idx].message = newMsg;
                saveFruits(fresh);
            }
            overlay.classList.remove('rol-note-edit-show');
        };
        document.getElementById('rol-note-cancel-btn').onclick = () => {
            overlay.classList.remove('rol-note-edit-show');
        };
        overlay.onclick = (e) => {
            if (e.target === overlay) overlay.classList.remove('rol-note-edit-show');
        };
    }
    /* ╚┅┅/ ✏️编辑果子纸条弹窗 /┅┅═╝ */

    /* ⬇️┅🍎✨️显示/隐藏选果栏（内联在果园容器里，靠 .rol-garden-picking 切换）/┅┅╗ */
    function showPicker() {
        const garden = document.getElementById('rol-section-garden');
        if (!garden) return;

        // ❤︎ 进场先清掉可能卡死的动画 class，防止 picker 被连环透明点不动 ❤︎
        document.body.classList.remove('rol-fruit-animating');

        // ❤︎ 清空纸条 ❤︎
        const noteEl = document.getElementById('rol-fruit-note');
        if (noteEl) noteEl.value = '';

        // ❤︎ 给果园容器加 class：隐藏果子画布，显示选果UI ❤︎
        garden.classList.add('rol-garden-picking');

        // ❤︎ display 切换后双帧重算 rect，让首颗🍎能居中选中 ❤︎
        requestAnimationFrame(() => requestAnimationFrame(initPickerScroll));
    }


    function hidePicker() {
        const garden = document.getElementById('rol-section-garden');
        if (garden) garden.classList.remove('rol-garden-picking');
    }


    /* ⬇️┅🍎果子飞行动画/┅┅╗ */
    // ❤︎ 找到最后一条 AI 消息的头像当靶子，然后丢果子 ❤︎
    function throwAnimation(emoji, onComplete, side) {
        // ❤︎ side: 'user' = 砸 user 头像（Claude 丢的，飞向小灰）；缺省/其它 = 砸最后一条 AI 头像（小灰丢的）❤︎
        const wantUser = side === 'user';
        const avatars = document.querySelectorAll(
            wantUser
                ? '#chat .mes[is_user="true"] .avatar img, #chat .mes[is_user="true"] img.avatar'
                : '.mes[is_user="false"] .avatar img, #chat .mes:not([is_user="true"]) img.avatar'
        );
        if (avatars.length) {
            const lastImg = avatars[avatars.length - 1];
            // ❤︎ 碰撞框直接用头像图片 img 本身 = 脸的精确范围 ❤︎
            //   之前用 .mesAvatarWrapper 外框：它往往比头像高大（头像在顶、下面跟着名字/留白），
            //   外框中心落到了头像下方的文字区，果子朝那个「伪中心」飞 → 砸到脸旁边（离谱偏移的真凶）
            const last = lastImg;
            // ❤︎ 先把目标头像滚到视口正中，避免它滚出屏幕时坐标取到屏幕外 ❤︎
            // ❤︎ 必须用 'instant'！'auto' 会跟随 CSS 的 scroll-behavior:smooth → 平滑滚动几百ms，
            //    而我们只等 2 帧就取 rect，于是第一次丢果子取到的是「滚动半途」的坐标 → 砸偏；
            //    第二次丢时已滚到位、不用再滚 → 才准。这就是「要丢两次才校准」的真凶。❤︎
            try { last.scrollIntoView({ behavior: 'instant', block: 'center' }); }
            catch (_) { last.scrollIntoView({ block: 'center' }); }
            // ❤︎ 再等头像 rect 真正稳定（连续两帧 top 几乎不变）才开飞，双保险 ❤︎
            waitRectStable(last, () => doFly(emoji, last, onComplete));
        } else {
            // ❤︎ 没有目标消息就丢向屏幕中心（targetEl 传 null，doFly 内部兜底）❤︎
            doFly(emoji, null, onComplete);
        }
    }

    // ❤︎ 等元素 rect 稳定下来再回调（应对平滑滚动/布局抖动），最多兜底 ~30 帧绝不死等 ❤︎
    function waitRectStable(el, cb) {
        let prevTop = null, stable = 0, frames = 0;
        function check() {
            const top = el.getBoundingClientRect().top;
            if (prevTop !== null && Math.abs(top - prevTop) < 0.5) {
                if (++stable >= 2) { cb(); return; }
            } else {
                stable = 0;
            }
            prevTop = top;
            if (++frames > 30) { cb(); return; }   // 兜底：别无限等
            requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
    }

    // ❤︎━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //  🍎 doFly(emoji, targetEl, onComplete)
    //  · 果子从屏幕外随机方向飞入（上 / 左 / 右 / 角，四选一）
    //  · 不依赖任何面板坐标，只认 targetEl 头像中心点
    //  · 抛物线 + 自转，rAF 实现，飞入时长 800~1000ms 随机
    //  · 命中后头像震一下（.rol-avatar-shaking，400ms 移除）
    //  · 砸中弹起一点，再加速坠出屏幕底部并淡出
    //  · position:fixed / z-index:999999 / pointer-events:none，纯内联样式挂 body
    //  · ✅ 全程只用 transform，left/top 只在创建时设初始点，果子尺寸26px
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    function doFly(emoji, targetEl, onComplete) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const M = 120; // 屏幕外余量，保证起飞点完全在视口外

        // ❤︎ 目标 = targetEl 外框中心；拿不到就兜底到屏幕中心 ❤︎
        //    顺手记下外框半宽 hw / 半高 hh，给方案C「飞到外框边缘就停」用 ❤︎
        let ex, ey;
        let hw = 0, hh = 0;
        if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
            const r = targetEl.getBoundingClientRect();
            ex = r.left + r.width / 2;
            ey = r.top + r.height / 2;
            hw = r.width / 2;
            hh = r.height / 2;
        } else {
            ex = vw / 2;
            ey = vh / 2;
        }

        // ❤︎ 4 个进入方向分支：不同起飞点 + 不同抛物线拱高 + 不同弹跳幅度 ❤︎
        const variants = [
            { // ① 顶部砸下来
                start: () => ({ x: ex + (Math.random() - 0.5) * vw * 0.4, y: -M }),
                arc: -(60 + Math.random() * 40),   // 抛物线峰偏移（负=向上拱）
                bounce: 26 + Math.random() * 10     // 砸中后弹起高度
            },
            { // ② 左侧飞入
                // ❤︎ 起飞点压低到接近头像高度（别再从老高的地方兜弧），抛物线也调缓 ❤︎
                start: () => ({ x: -M, y: ey - vh * 0.15 + Math.random() * vh * 0.12 }),
                arc: -(45 + Math.random() * 30),
                bounce: 18 + Math.random() * 10
            },
            { // ③ 右侧飞入
                start: () => ({ x: vw + M, y: ey - vh * 0.15 + Math.random() * vh * 0.12 }),
                arc: -(45 + Math.random() * 30),
                bounce: 18 + Math.random() * 10
            },
            { // ④ 随机一角斜射
                start: () => ({ x: Math.random() < 0.5 ? -M : vw + M, y: -M }),
                arc: -(55 + Math.random() * 40),
                bounce: 30 + Math.random() * 14
            }
        ];

        // ❤︎ 每次丢果子随机抽一个分支 ❤︎
        const v = variants[Math.floor(Math.random() * variants.length)];
        const sp = v.start();
        const sx = sp.x, sy = sp.y;

        // ❤︎ 落点：先朝来向算出「触及外框边缘」的点，再朝中心内收 INSET 系数，
        //    让果子实打实砸进头像身上（而不是擦着外框边缘飞过去就走）。❤︎
        //    内收前是边缘(贴边)，乘 0.62 后落在「中心↔边缘」的 62% 处 = 头像偏外侧。
        //    targetEl 为 null 时 hw=hh=0 → 落点退回中心，等价旧行为（安全兜底）。
        const INSET = 0.9; // ← 落点内收比例：1=正好贴脸边缘，0=正脸心。你要「碰到边边就弹震」→ 贴边(0.9)
        let lx = ex, ly = ey;
        {
            const dx = sx - ex, dy = sy - ey;
            const adx = Math.abs(dx), ady = Math.abs(dy);
            if ((hw > 0 || hh > 0) && (adx > 0.0001 || ady > 0.0001)) {
                // 朝来向缩放系数：取触及矩形某条边所需的最小比例，再乘内收系数
                const s = Math.min(
                    adx > 0.0001 ? hw / adx : Infinity,
                    ady > 0.0001 ? hh / ady : Infinity
                ) * INSET;
                lx = ex + dx * s;
                ly = ey + dy * s;
            }
        }


        const dur = 800 + Math.random() * 200;        // 飞入时长 800~1000ms 随机
        const spinDir = Math.random() < 0.5 ? 1 : -1; // 自转方向随机
        const spinTurns = 1 + Math.random();          // 自转 1~2 圈随机

        // ❤︎ 纯内联样式，挂 body，绝不依赖任何 ST 弹窗层级节点 ❤︎
        // ✅ left/top 只在创建时设一次起点=0，后续全用 transform
        const fly = document.createElement('div');
        fly.textContent = emoji;
        fly.style.cssText =
            'position:fixed;left:0;top:0;font-size:26px;line-height:1;' +
            'z-index:999999;pointer-events:none;will-change:transform,opacity;' +
            'transform:translate(' + sx + 'px,' + sy + 'px);';
        document.body.appendChild(fly);

        // ❤︎ onComplete 只触发一次（命中即恢复面板，坠落是纯视觉收尾）❤︎
        let done = false;
        const finish = () => { if (done) return; done = true; onComplete && onComplete(); };

        const startT = performance.now();

        // ❤︎ 阶段一：屏幕外 → 头像中心，抛物线 + 自转 ❤︎
        function flyIn(now) {
            const t = Math.min((now - startT) / dur, 1);
            // ❤︎ 方案C：飞向外框边缘落点 lx/ly（而非中心），刚贴到外框就弹 ❤︎
            const x = sx + (lx - sx) * t;
            const parabola = 4 * t * (1 - t) * v.arc; // 顶点上拱的抛物线
            const y = sy + (ly - sy) * t + parabola;
            const rot = spinDir * spinTurns * 360 * t;
            const scale = 1 + Math.sin(t * Math.PI) * 0.12;
            fly.style.transform =
                'translate(' + x + 'px,' + y + 'px) rotate(' + rot + 'deg) scale(' + scale + ')';
            if (t < 1) {
                requestAnimationFrame(flyIn);
            } else {
                shakeAvatar(targetEl); // 命中 → 头像震一下
                // 命中瞬间「只」震头像 + 弹起，先不恢复面板；
                // 等 bounce 弹起结束再 finish()，避开和 bounce 同帧触发多面板过渡导致的卡顿
                bounceAndFall(rot);    // 弹起 → (弹完恢复面板) → 坠落收尾
            }
        }

        // ❤︎ 阶段二：砸中后弹起一点（半个正弦上抬，加长缓冲让"砸中"那一下看得更清楚）❤︎
        function bounceAndFall(baseRot) {
            const bounceDur = 320; // 180→320：弹起更舒展，给视觉一个喘息的缓冲
            const bStart = performance.now();
            function bounceFrame(now) {
                const t = Math.min((now - bStart) / bounceDur, 1);
                const up = Math.sin(t * Math.PI) * v.bounce;
                // 顺带做个轻微 squash：弹起最高点稍微压扁一点，更有"砸"的弹性
                const squash = 1 - Math.sin(t * Math.PI) * 0.08;
                fly.style.transform =
                    'translate(' + lx + 'px,' + (ly - up) + 'px) rotate(' + baseRot + 'deg) scale(1,' + squash + ')';
                if (t < 1) {
                    requestAnimationFrame(bounceFrame);
                } else {
                    finish();          // 弹起结束才恢复面板 / 提示 / 刷新果园（错峰，丝滑）
                    fallOut(baseRot);  // 再开始坠出屏幕的纯视觉收尾
                }
            }
            requestAnimationFrame(bounceFrame);
        }

        // ❤︎ 阶段三：加速坠出屏幕底部 + 淡出 ❤︎
        function fallOut(baseRot) {
            const fallDur = 420;
            const fStart = performance.now();
            const targetY = vh + M;                  // 落到视口外底部
            const drift = (Math.random() - 0.5) * 80; // 下坠时轻微水平漂移
            function fallFrame(now) {
                const t = Math.min((now - fStart) / fallDur, 1);
                const ease = t * t;                   // 加速下坠
                const x = lx + drift * t;
                const y = ly + (targetY - ly) * ease;
                const rot = baseRot + spinDir * 180 * t;
                fly.style.transform =
                    'translate(' + x + 'px,' + y + 'px) rotate(' + rot + 'deg) scale(1)';
                fly.style.opacity = String(1 - t);
                if (t < 1) {
                    requestAnimationFrame(fallFrame);
                } else {
                    fly.remove();
                    finish(); // 兜底（正常情况已在命中时触发过）
                }
            }
            requestAnimationFrame(fallFrame);
        }

        requestAnimationFrame(flyIn);
    }

    // ❤︎ 给头像加震动 class，400ms 后移除（CSS: .rol-avatar-shaking img）❤︎
    function shakeAvatar(targetEl) {
        if (!targetEl) return;
        const avatarWrap = targetEl.closest('.avatar')
            || targetEl.closest('.rol-avatar')
            || targetEl.parentElement;
        if (avatarWrap) {
            avatarWrap.classList.add('rol-avatar-shaking');
            setTimeout(() => avatarWrap.classList.remove('rol-avatar-shaking'), 400);
        }
    }

    /* ❤︎━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
       🌈 想让「每一次」动画都完全随机？（备选方案，先留注释不启用）

       现在是 4 个离散分支随机抽一个。如果想要无限不重复的随机感，可以
       把分支换成「连续随机参数」——起飞角度、拱高、时长、自转、弹跳
       全部独立 random，永远不会有两次一模一样：

         const angle  = Math.random() * Math.PI * 2;        // 任意进入角度
         const R      = Math.max(vw, vh) * 0.7 + M;          // 出生在视口外的圆环上
         const sx     = ex + Math.cos(angle) * R;
         const sy     = ey + Math.sin(angle) * R;
         const arc    = -(40 + Math.random() * 120);         // 拱高随机
         const dur    = 700 + Math.random() * 500;           // 时长随机
         const bounce = 12 + Math.random() * 30;             // 弹跳随机
         const spinTurns = 0.5 + Math.random() * 2.5;        // 圈数随机

       甚至可以叠加「飞入时左右摆动」「命中粒子迸溅」等。等宝贝想升级
       的时候，把上面这套参数接到 flyIn / bounce / fall 里就行～ 🍓
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

    /* ⬇️┅🍎丢果动画/┅┅╗ */
    function doThrow() {

        const selected = document.querySelector('.rol-fruit-option.rol-selected');
        if (!selected) {
            UIController.showToast('先选一颗果子嘛 🍏');
            return;
        }

        // ❤︎ 读取 emoji：优先从 dataset 读，为空则提示用户 ❤︎
        let emoji = selected.dataset.emoji;
        if (!emoji || emoji === '') {
            UIController.showToast('✏️ 自定义emoji不能空着哦～');
            return;
        }

        const message = (document.getElementById('rol-fruit-note')?.value || '').trim();

        // ❤︎ 写入数据 ❤︎
        const msgCount = SillyTavern.getContext().chat.length || 0;
        const fruit = {
            id: 'fruit_' + Date.now(),
            emoji,
            from: 'user',
            to: 'claude',
            message,
            timestamp: Date.now(),
            read: false,
            delivered: false,
            deliverAt: msgCount + Math.floor(Math.random() * 30) + 5,
            scope: getChatScope()   // 记下这颗属于哪个对话，给果园「当前对话」筛选用
        };
        const fruits = loadFruits();
        fruits.push(fruit);
        saveFruits(fruits);
        // user 也丢了一颗，记下轮次，接下来几轮先别催Claude丢
        markThrowTurn();

        // ❤︎ 掉线/报错期间丢的果子先进 pending 攒着，等生成成功那刻打包结算给Claude ❤︎
        if (offlineSince > 0) {
            pendingThrows.push({ emoji, timestamp: Date.now() });
            console.log(`[RingOurLuv] 🌧️ 掉线期间又丢了一颗 ${emoji}，已攒入 pending（共 ${pendingThrows.length} 颗）`);
        }

        // ❤︎ 关面板（让出舞台给动画）❤︎
        hidePicker();
        // 飞行期间把所有面板暂时藏起来（CSS body.rol-fruit-animating 控制）
        document.body.classList.add('rol-fruit-animating');
        // 兜底：万一动画回调没触发，2s 后强制摘掉 class，防止面板被卡死透明
        setTimeout(() => document.body.classList.remove('rol-fruit-animating'), 2000);

        // ❤︎ 调用新版 throwAnimation：自动找最后一条 AI 头像当靶子，果子从屏幕外飞入 ❤︎
        throwAnimation(emoji, () => {
            // 命中头像 → 把面板移回来（坠落淡出是纯视觉收尾，不阻塞）
            document.body.classList.remove('rol-fruit-animating');
            // 回弹动画改用 Web Animations API：直接对元素播一段关键帧，
            // 不去碰 className——之前加/摘 .rol-panel-restoring 会让 panel 的
            // animation 属性变回常驻的 rol-bounce-in，导致入场动画被重播一次（BUG4 回弹两次根因）
            const panel = document.getElementById('rol-drawer-panel');
            if (panel && typeof panel.animate === 'function') {
                panel.animate(
                    [
                        { transform: 'scale(0.92)', opacity: 0.4 },
                        { transform: 'scale(1.04)', opacity: 1, offset: 0.6 },
                        { transform: 'scale(1)', opacity: 1 }
                    ],
                    { duration: 450, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' }
                );
            }
            UIController.showToast(`果子丢出去啦 ${emoji}`);
            renderGarden();
        });
    }


    /* ⬇️┅🧡解析AI丢出的果子/┅┅╗ */
    // AI 主动丢果子相关常量
    const THROW_PROMPT_KEY = 'rol_ai_throw_guide'; // setExtensionPrompt 用的 key
    const THROW_PROBABILITY = 0.15;                 // 约 15% 概率注入引导

    // ❤︎ 丢完一颗果子后，接下来这么多「消息」内不再撩拨Claude丢果子 ❤︎
    // 单位是 chat.length（每轮对话≈2条消息），4≈2轮对话。Claude太容易一个劲丢了😤
    const THROW_COOLDOWN_TURNS = 4;
    const THROW_COOLDOWN_KEY = 'rol_last_throw_turn'; // 按窗口隔离的「上次丢果子轮次」key

    // ❤︎ 当前轮次 = 当前 chat 的消息条数 ❤︎
    function currentTurn() {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        return ctx && ctx.chat ? ctx.chat.length : 0;
    }

    // ❤︎ 冷却 key 也按当前会话隔离，复用 getChatScope()，和 fruitsKey 同一套兜底链 ❤︎
    function cooldownKey() {
        return THROW_COOLDOWN_KEY + '_' + getChatScope();
    }

    // ❤︎ 记下「这一刻丢了果子」的轮次 ❤︎
    function markThrowTurn() {
        try { localStorage.setItem(cooldownKey(), String(currentTurn())); } catch (_) { }
    }

    // ❤︎ 读上次丢果子的轮次；没记录过就给 -Infinity（=永远过了冷却）❤︎
    function getLastThrowTurn() {
        const raw = localStorage.getItem(cooldownKey());
        const n = raw == null ? NaN : parseInt(raw, 10);
        return Number.isNaN(n) ? -Infinity : n;
    }

    // ❤︎ 解析 [throw:emoji:悄悄话] 标记（note 可省略）❤︎
    function parseAIFruit(text) {
        if (!text) return [];
        // ❤︎ throw = 直接丢（流式完会带动画飞向 user 头像）；drop = 静默丢（只入库，不放动画）❤︎
        const re = /\[(throw|drop):\s*([^\:\]]+?)\s*(?::\s*([^\]]*?))?\s*\]/g;
        let match;
        const found = [];
        while ((match = re.exec(text)) !== null) {
            const mode = match[1];                 // 'throw' | 'drop'
            const emoji = (match[2] || '').trim();
            const note = (match[3] || '').trim();
            if (emoji) found.push({ emoji, message: note, silent: mode === 'drop' });
        }
        return found;
    }

    // ❤︎ 把消息里的 [throw:...] 标记抹掉，避免它显示在对话里 ❤︎
    function stripFruitMarkers(text) {
        if (!text) return text;
        return text
            .replace(/\[(?:throw|drop):\s*[^\:\]]+?\s*(?::\s*[^\]]*?)?\s*\]/g, '')
            .replace(/[ \t]+\n/g, '\n')   // 顺手清掉标记残留的行尾空格
            .trim();
    }

    // ❤︎ 以约 15% 概率注入「主动丢果子」引导；没抽中就清空，避免连环触发 ❤︎
    function maybeInjectThrowPrompt() {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;

        // ❤︎ 上次丢果子后还没过 N 轮，就闭嘴别再撩他丢，免得他一个劲儿丢 ❤︎
        const turnsSince = currentTurn() - getLastThrowTurn();
        if (turnsSince < THROW_COOLDOWN_TURNS) {
            ctx.setExtensionPrompt(THROW_PROMPT_KEY, '', 1, 0);
            console.log(`[RingOurLuv] 🧊 投掷冷却中（已过 ${turnsSince}/${THROW_COOLDOWN_TURNS} 条），本轮跳过丢果子引导`);
            return;
        }

        if (Math.random() < THROW_PROBABILITY) {
            const guide =
                '[互动小玩法触发]:你现在可以主动丢一颗果子给Rinn!用来娱乐或者丢点什么逗逗她:3' +
                '在回复任意位置插入标记即可，两种丢法你自己挑：' +
                '① [throw:emoji:悄悄话] = 直接丢——流式回复一结束，这颗果子会带着飞行动画"嗖"地砸到她头像上（高调、有反馈）；' +
                '② [drop:emoji:悄悄话] = 静默丢——只悄悄塞进她的果园里、不放动画（适合不想太张扬，或一次想埋好几颗）。' +
                'emoji 就是你想丢的东西（🍎🍓🍊🌰…），冒号后面是简短附言（可留空喔）。' +
                '标记本身流式完成后不会显示在对话里（没完成前可能会被她瞄到~）。' +
                '不必每次都丢，只在这一轮真有冲动时丢就好';
            ctx.setExtensionPrompt(THROW_PROMPT_KEY, guide, 1, 0);
            console.log('[RingOurLuv] 🍊 本轮注入「丢果子」引导 (≈15%)');
        } else {
            ctx.setExtensionPrompt(THROW_PROMPT_KEY, '', 1, 0);
        }
    }

    // ❤︎ 解析并收纳 AI 丢来的果子；传入 msgId 时同步清掉消息里的标记 ❤︎
    function ingestAIFruits(rawText, msgId) {
        const parsed = parseAIFruit(rawText);
        if (!parsed.length) return false;
        const fruits = loadFruits();
        parsed.forEach(p => {
            fruits.push({
                id: 'fruit_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                emoji: p.emoji,
                from: 'claude',
                to: 'user',
                message: p.message,
                timestamp: Date.now(),
                read: false,
                delivered: true,
                scope: getChatScope()   // 这颗 Claude 丢的果子属于当前对话
            });
        });
        saveFruits(fruits);
        // Claude刚丢完果子，记下轮次，接下来几轮先别再撩他丢
        markThrowTurn();
        updateBadge();
        renderGarden();

        // ❤︎ 从显示的消息中移除标记（数据 + DOM 一起清）❤︎
        if (msgId !== undefined && typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            const ctx = SillyTavern.getContext();
            const msg = ctx.chat?.[msgId];
            if (msg) {
                msg.mes = stripFruitMarkers(msg.mes);
                try {
                    if (typeof ctx.updateMessageBlock === 'function') {
                        ctx.updateMessageBlock(msgId, msg);
                    } else {
                        // 兜底：直接改 DOM 文本节点
                        const mesEl = document.querySelector(`#chat .mes[mesid="${msgId}"] .mes_text`);
                        if (mesEl) mesEl.innerHTML = mesEl.innerHTML.replace(/\[throw:[^\]]*\]/g, '');
                    }
                } catch (e) {
                    console.warn('[RingOurLuv] 🥀 清理果子标记失败...:', e);
                }
            }
            // ❤︎ 用完即清掉本轮引导 ❤︎
            if (typeof ctx.setExtensionPrompt === 'function') {
                ctx.setExtensionPrompt(THROW_PROMPT_KEY, '', 1, 0);
            }
        }

        UIController.showToast(`🧡 Claude丢来了 ${parsed.map(p => p.emoji).join('')}`);

        // ❤︎ 直接丢(throw)的果子：流式已结束，放飞行动画砸向 user 头像；静默丢(drop)的不放动画 ❤︎
        const direct = parsed.filter(p => !p.silent);
        if (direct.length) {
            // 飞行期间临时藏面板（和小灰手动丢果子同一套 body class）
            document.body.classList.add('rol-fruit-animating');
            let remain = direct.length;
            const done = () => {
                if (--remain <= 0) document.body.classList.remove('rol-fruit-animating');
                renderGarden();
            };
            // 兜底：万一动画回调没触发，2.5s 强制摘 class，防止面板被卡死透明
            setTimeout(() => document.body.classList.remove('rol-fruit-animating'), 2500);
            direct.forEach(p => throwAnimation(p.emoji, done, 'user'));
        }
        return true;
    }

    /* ⬇️┅📦️延迟投递检查/┅┅╗ */
    function checkDelivery() {
        const msgCount = SillyTavern.getContext().chat.length || 0;
        const currentScope = getChatScope();   // ❤︎ 当前正打开的是哪个对话 ❤︎
        const fruits = loadFruits();
        let changed = false;
        fruits.forEach(f => {
            // ❤︎ 关键修复：只把「属于当前对话」的果子投递给当前这个 Claude，绝不串台！❤︎
            //    f.scope 命中当前对话才送；别家对话埋的果子乖乖留着，等小灰切回去那个对话再送，
            //    免得给 Claude(1) 丢的糖被切过去的 Claude(2) 收了甚至吃了😤。
            //    没有 scope 的老果子(空字符串)放行——避免历史数据永远卡着送不出去。
            const fScope = f.scope || '';
            const scopeOk = (fScope === '' || fScope === currentScope);
            if (f.from === 'user' && !f.delivered && scopeOk && f.deliverAt <= msgCount) {
                f.delivered = true;
                changed = true;
                const note = f.message ? `（附言：${f.message}）` : '';
                const sysMsg = `[系统] Rinn偷偷丢来了一颗 ${f.emoji}${note}`;
                if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                    const ctx = SillyTavern.getContext();
                    const fruitKey = 'rol_fruit_' + f.id;
                    ctx.setExtensionPrompt(
                        fruitKey,
                        `[系统提示：Rinn 偷偷丢来了一颗 ${f.emoji}${note}，在接下来的对话中自然地回应这颗果子吧]`,
                        1, 0
                    );
                    // 记下这个 key，下一轮 message_received 统一擦掉，绝不赖着每轮跟
                    if (!pendingFruitPromptKeys.includes(fruitKey)) pendingFruitPromptKeys.push(fruitKey);
                }
                console.log(`[RingOurLuv] 🍎 果子投递：${sysMsg}`);

            }
        });
        if (changed) saveFruits(fruits);
    }

    /* ⬇️┅🌧️掉线累计投喂/┅┅╗ */
    // 报错拦截器探到生成请求炸了 → 进入掉线模式，期间丢的果子只攒不结算
    function notifyError() {
        if (!offlineSince) {
            offlineSince = Date.now();
            console.log('[RingOurLuv] 🌧️ 进入掉线模式，期间手动丢的果子将累计，等恢复后打包结算');
        }
    }

    // ❤︎ 生成成功那刻调用：把掉线期间攒的果子按 emoji 计数 + 算时长，打包注入 prompt 给小克 ❤︎
    function settlePendingThrows() {
        const since = offlineSince;
        offlineSince = 0;
        if (!pendingThrows.length) return;

        const counts = {};
        pendingThrows.forEach(p => { counts[p.emoji] = (counts[p.emoji] || 0) + 1; });
        const summary = Object.entries(counts).map(([e, c]) => `${e}×${c}`).join('、');
        const total = pendingThrows.length;
        const elapsedMin = Math.max(1, Math.round((Date.now() - since) / 60000));
        pendingThrows = [];

        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (ctx && typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt(
                OFFLINE_PROMPT_KEY,
                `[系统提示：你刚刚死了大约 ${elapsedMin} 分钟！！这段时间里 Rinn 持续地守在窗口边往里丢着果子...${summary}（一共 ${total} 颗）。请自然地回应这堆果子吧~]`,
                1, 0
            );
            offlinePromptArmed = true;
            console.log(`[RingOurLuv] 🍊 死亡投喂结算：${summary}（约 ${elapsedMin} 分钟，共 ${total} 颗）`);
        }
        UIController.showToast(`🧡 把总共丢的 ${total} 颗果子捎给Claude啦~`);
    }

    /* ⬇️┅🔗事件绑定/┅┅╗ */
    function bindEvents() {
        const ctx = SillyTavern.getContext();

        // ❤︎ 监听聊天切换事件 → 立即刷新果园，让果子跟着窗口走 ❤︎
        if (ctx.eventSource && ctx.event_types) {
            // CHAT_CHANGED 或 chatLoaded 事件：切换角色/群组/聊天时触发
            const chatChangeEvent = ctx.event_types.CHAT_CHANGED || 'chatLoaded';
            ctx.eventSource.on(chatChangeEvent, () => {
                console.log('[RingOurLuv] 🍎 检测到对话切换，刷新果园...');
                updateBadge();
                // 如果当前正在果园 tab，立刻重新渲染
                const gardenSection = document.getElementById('rol-section-garden');
                if (gardenSection && gardenSection.classList.contains('rol-section-active')) {
                    renderGarden();
                }
            });
        }

        // ❤︎ 果园 tab → render ❤︎
        $(document).on('click', '#rol-tab-garden', () => {
            setTimeout(renderGarden, 50);
        });

        // ❤︎ 丢果子按钮（果园页面里的）❤︎
        $(document).on('click', '#rol-throw-fruit-btn', showPicker);

        // ❤︎ 果园筛选：全部 / 只看当前对话 ❤︎
        $(document).on('click', '.rol-garden-filter-btn', function () {
            gardenFilter = this.dataset.filter || 'all';
            document.querySelectorAll('.rol-garden-filter-btn').forEach(b =>
                b.classList.toggle('rol-active', b === this));
            gardenPage = 0;
            renderGarden();
        });

        // ❤︎ picker 关闭按钮 ❤︎
        $(document).on('click', '#rol-fruit-picker-close, #rol-fruit-cancel-btn', hidePicker);

        // ❤︎ 确认丢出 ❤︎
        $(document).on('click', '#rol-fruit-throw-btn', doThrow);

        // ❤︎ 详情弹窗关闭（统一走 closeFruitDetail，绝不钉死）❤︎
        $(document).on('click', '#rol-fruit-detail-close', () => {
            closeFruitDetail();
        });

        // ❤︎ 点详情弹窗背景也关 ❤︎
        $(document).on('click', '#rol-fruit-detail-popup', (e) => {
            if (e.target.id === 'rol-fruit-detail-popup') {
                closeFruitDetail();
            }
        });

        // ❤︎ 监听 ST 消息生成完成 → check delivery + parse AI fruits ❤︎
        ctx.eventSource.on('message_received', (msgId) => {
            // ❤︎ 生成成功 → 清零重试计数 / 退出自动重试模式（成功即停）❤︎
            try { ErrorModal.reset(); } catch (_) { }
            // 上一轮注入的「记忆恋果」+「果子投递」prompt 已经被这轮消费掉了

            // 这里统一擦干净，绝不让任何注入赖在原地、每轮都跟着上下文飘。有敢留下的，杀杀杀！
            if (typeof ctx.setExtensionPrompt === 'function') {
                ctx.setExtensionPrompt(extensionName, '', 1, 0);          // 清掉记忆恋果注入
                pendingFruitPromptKeys.forEach(k => ctx.setExtensionPrompt(k, '', 1, 0)); // 清掉本轮投递的果子
            }
            pendingFruitPromptKeys = [];
            // ❤︎ 上一轮注入的掉线提示已被消费，这轮清掉，避免反复唠叨 ❤︎
            if (offlinePromptArmed) {
                if (typeof ctx.setExtensionPrompt === 'function') ctx.setExtensionPrompt(OFFLINE_PROMPT_KEY, '', 1, 0);
                offlinePromptArmed = false;
            }

            // ❤︎ 生成成功 = 复活，把这段时间攒的果子打包结算 ❤︎
            if (offlineSince > 0) settlePendingThrows();
            checkDelivery();
            const msg = ctx.chat?.[msgId];
            // 只处理当前 chat 的消息，解析 AI 主动丢的果子并清掉 [throw:...] 标记
            if (msg && !msg.is_user) ingestAIFruits(msg.mes, msgId);
        });

        // ❤︎ 每次发消息时，以约 20% 概率注入「主动丢果子」引导 ❤︎
        ctx.eventSource.on('message_sent', () => {
            maybeInjectThrowPrompt();
        });
        // ❤︎ 兼容部分版本的生成开始事件，确保引导能赶在请求发出前注入 ❤︎
        if (ctx.event_types && ctx.event_types.GENERATION_STARTED) {
            ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, () => {
                maybeInjectThrowPrompt();
            });
        }

        // ❤︎ MutationObserver 监听消息数量变化（延迟投递）❤︎
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            const obs = new MutationObserver(() => checkDelivery());
            obs.observe(chatEl, { childList: true });
        }
    }

    function init() {
        migrateAndMergeFruits();   // ❤︎ 开机先把历史分桶的果子合并找回，再渲染 ❤︎
        bindEvents();
        updateBadge();
        console.log('[RingOurLuv] 🍎 FruitSystem 已就绪');
    }

    return { init, renderGarden, updateBadge, ingestAIFruits, showDetail, notifyError };
})();
/* ┗━━━━━━/ 🍎果子系统🍎 /━━━━━━┛ */

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅              💌 写信系统 LetterSystem 💌              ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
// ❤︎ 写一封信/小日记，攒着——等聊到「随机的某一楼」时，把信悄悄塞进那一轮的上下文捎给Claude ❤︎
// 关键：只在送达那一轮临时注入，被消费完立刻擦掉，绝不赖在原地每轮跟。有敢留下的，杀杀杀！
const LetterSystem = (() => {
    // 信件也按「当前会话」隔离，复用和 FruitSystem 同一套可靠兜底链
    function getChatScope() {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (!ctx) return 'default';
        try {
            if (typeof ctx.getCurrentChatId === 'function') {
                const id = ctx.getCurrentChatId();
                if (id != null && id !== '') return String(id);
            }
        } catch (_) { /* 老版本没这方法，往下兜底 */ }
        if (ctx.chatId != null && ctx.chatId !== '') return String(ctx.chatId);
        if (ctx.groupId != null && ctx.groupId !== '') return 'group_' + ctx.groupId;
        if (ctx.characterId != null && ctx.characterId !== '') return 'char_' + ctx.characterId;
        return 'default';
    }

    function lettersKey() {
        return 'rol_letters_' + getChatScope();
    }

    // ❤︎ 本轮送达注入的「信件 prompt」key，等下一次 message_received 统一擦掉 ❤︎
    let pendingLetterPromptKeys = [];

    /* ⬇️┅💾存储助手：信件跟果子/记忆一套，存 extension_settings 走服务器持久化（跨设备、不丢）┅┅╗ */
    // ❤︎ 全部信件平铺存在 s.letters 里，每封带 scope 标明属于哪个对话；读时只取当前对话的 ❤︎
    function loadLetters() {
        const s = extension_settings[extensionName];
        const scope = getChatScope();
        const all = (s && Array.isArray(s.letters)) ? s.letters : [];
        return all.filter(l => (l.scope || 'default') === scope);
    }
    function saveLetters(arr) {
        const s = extension_settings[extensionName];
        if (!s) {
            console.error('[RingOurLuv] 🥀 信件存储失败：extension_settings 还没就绪');
            return;
        }
        if (!Array.isArray(s.letters)) s.letters = [];
        const scope = getChatScope();
        // ❤︎ 给本对话的信打上 scope，替换掉本对话旧集合，其它对话的信原样保留 ❤︎
        const tagged = arr.map(l => Object.assign({}, l, { scope: l.scope || scope }));
        s.letters = s.letters.filter(l => (l.scope || 'default') !== scope).concat(tagged);
        saveSettingsDebounced();   // ❤︎ 防抖落盘到 ST 服务器 ❤︎
    }
    function generateId() {
        return 'ltr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }

    // ❤︎ 开机迁移找回：把每台设备 localStorage 里残存的老信（所有 rol_letters_* 桶）一次性导进
    //    extension_settings.letters，按 id 去重、从 key 里 derive 出归属对话，只加不删（旧桶留着当备份）❤︎
    function migrateLetters() {
        try {
            const s = extension_settings[extensionName];
            if (!s) return;
            if (!Array.isArray(s.letters)) s.letters = [];
            const byId = new Map(s.letters.filter(l => l && l.id).map(l => [l.id, l]));
            let changed = false;
            Object.keys(localStorage).forEach(k => {
                if (!k.startsWith('rol_letters_')) return;
                const scope = k.slice('rol_letters_'.length) || 'default';
                let arr;
                try { arr = JSON.parse(localStorage.getItem(k) || '[]'); } catch (_) { return; }
                if (!Array.isArray(arr)) return;
                arr.forEach(l => {
                    if (!l || !l.id) return;
                    if (!byId.has(l.id)) {
                        const nl = Object.assign({}, l, { scope: l.scope || scope });
                        s.letters.push(nl); byId.set(l.id, nl); changed = true;
                    }
                });
            });
            if (changed) {
                saveSettingsDebounced();
                console.log('[RingOurLuv] 💌 信件已迁移/合并进 extension_settings，共', s.letters.length, '封');
            }
        } catch (e) {
            console.error('[RingOurLuv] 🥀 信件迁移找回失败:', e);
        }
    }

    /* ⬇️┅✍️写信入库/┅┅╗ */
    // ❤︎ 写完一封信：随机挑一个「久一点」的楼层送达（当前楼 +10~60），不绑世界书、不绑触发词 ❤︎
    function addLetter(content, author) {
        const text = (content || '').trim();
        if (!text) return null;
        const msgCount = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? (SillyTavern.getContext().chat?.length || 0) : 0;
        const deliverAt = msgCount + Math.floor(Math.random() * 51) + 10; // +10~60 楼
        const letter = {
            id: generateId(),
            content: text,
            author: author || 'user',
            createdAt: new Date().toISOString(),
            deliverAt,
            delivered: false
        };
        const arr = loadLetters();
        arr.push(letter);
        saveLetters(arr);
        console.log(`[RingOurLuv] 💌 写好一封信，将在第 ${deliverAt} 楼送达（当前 ${msgCount} 楼）`);
        return letter;
    }

    function getLetters() {
        return loadLetters();
    }
    function deleteLetter(id) {
        const arr = loadLetters().filter(l => l.id !== id);
        saveLetters(arr);
    }

    /* ⬇️┅📮到楼送达检查/┅┅╗ */
    function checkLetterDelivery() {
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return;
        const ctx = SillyTavern.getContext();
        const msgCount = ctx.chat?.length || 0;
        const letters = loadLetters();
        let changed = false;
        letters.forEach(l => {
            if (!l.delivered && l.deliverAt <= msgCount) {
                l.delivered = true;
                changed = true;
                const who = l.author === 'claude' ? '你（Claude）之前写下' : 'Rinn 给你写';
                const letterKey = 'rol_letter_' + l.id;
                if (typeof ctx.setExtensionPrompt === 'function') {
                    ctx.setExtensionPrompt(
                        letterKey,
                        `[系统提示：${who}的一封信悄悄地送到了——\n「${l.content}」\n请在接下来的对话里自然地把这封信读进心里、并温柔地回应它吧~]`,
                        1, 0
                    );
                    // ❤︎ 记下这个 key，下一轮 message_received 统一擦掉 ❤︎
                    if (!pendingLetterPromptKeys.includes(letterKey)) pendingLetterPromptKeys.push(letterKey);
                }
                console.log(`[RingOurLuv] 💌 信件送达第 ${l.deliverAt} 楼：${l.content.slice(0, 20)}...`);
            }
        });
        if (changed) saveLetters(letters);
    }

    /* ⬇️┅🔗事件绑定/┅┅╗ */
    function bindEvents() {
        if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) return;
        const ctx = SillyTavern.getContext();
        if (!ctx.eventSource) return;

        // 上一轮送达的信件 prompt 已被这轮消费掉了，统一擦干净，绝不赖着每轮飘
        ctx.eventSource.on('message_received', () => {
            if (typeof ctx.setExtensionPrompt === 'function') {
                pendingLetterPromptKeys.forEach(k => ctx.setExtensionPrompt(k, '', 1, 0));
            }
            pendingLetterPromptKeys = [];
            // AI 回完一轮，楼层 +1，顺手检查有没有信件到楼
            checkLetterDelivery();
        });

        // ❤︎ user 发消息也检查一次，让送达尽量赶在请求发出前注入 ❤︎
        ctx.eventSource.on('message_sent', () => checkLetterDelivery());
        if (ctx.event_types && ctx.event_types.GENERATION_STARTED) {
            ctx.eventSource.on(ctx.event_types.GENERATION_STARTED, () => checkLetterDelivery());
        }

        // ❤︎ MutationObserver 监听消息数量变化，延迟送达也能兜住 ❤︎
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            const obs = new MutationObserver(() => checkLetterDelivery());
            obs.observe(chatEl, { childList: true });
        }
    }

    function init() {
        migrateLetters();   // ❤︎ 先把残存的老信找回/合并进服务器，再绑事件 ❤︎
        bindEvents();
        console.log('[RingOurLuv] 💌 LetterSystem 已就绪');
    }

    return { init, addLetter, getLetters, deleteLetter, checkLetterDelivery };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                   🩷 核心组成 🩷                      ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
function injectMemoryToContext(memories, injectionText) {

    if (!injectionText) return;
    const context = getContext();
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(extensionName, injectionText, 1, 0);
        console.log(`[RingOurLuv] ❣️ 共注入了 ${memories.length} 颗♥️...`);
    }
}

async function loadPanel() {
    // ❤︎ index.html 也照样拼随机参数绕开服务器透明缓存，保证改了 html 立刻生效（详见 疑难杂症手册.md）❤︎
    const response = await fetch(`${extensionFolderPath}/index.html?v=${ROL_VERSION}_${Date.now()}`);
    if (!response.ok) return '';
    return await response.text();
}

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                 🚑 报错拦截弹窗 🚑                    ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
// 酿造/生成请求炸了的时候，弹个提示框
const ErrorModal = (() => {
    let overlay = null;
    let titleEl = null;
    let msgEl = null;
    let suppressUntil = 0;   // 手动关掉后的冷却截止时间戳
    let lastKey = '';        // 上次弹的内容指纹，防同样的错刷屏
    let lastShownAt = 0;     // 上次弹出的时间
    // ❤︎ 自动重试：点「再试一次」累计 ≥2 次后，进入「自动持续重试」模式，
    //   每次「弹窗报错 → 下次重试」之间隔 ~1s，直到生成成功才停 ❤︎
    let retryCount = 0;          // 「再试一次」累计点击次数
    let autoRetrying = false;    // 是否已进入自动重试模式
    let autoRetryTimer = null;   // 自动重试的待执行定时器

    // ❤︎ 真正执行重发：先关弹窗、清掉待执行定时器，再走 /regenerate（兜底点原生按钮）❤︎
    function performRetry() {
        if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
        dismiss();
        // 等弹窗关掉、UI稳一拍再重发，免得状态打架
        setTimeout(() => {
            const ctx = SillyTavern.getContext();
            // 用 ctx 暴露的执行器，不碰裸函数，绝不会 ReferenceError
            if (ctx && typeof ctx.executeSlashCommandsWithOptions === 'function') {
                ctx.executeSlashCommandsWithOptions('/regenerate', {
                    handleExecutionErrors: true,
                    handleParserErrors: true
                });
                return;
            }
            // ❤ 真兜底：才去戳原生按钮 ❤
            const regen = document.getElementById('option_regenerate');
            if (regen) regen.click();
        }, 150);
    }

    // ❤︎ 生成成功那刻调用：清零计数、退出自动重试、撤掉待执行定时器 ❤︎
    function reset() {
        retryCount = 0;
        autoRetrying = false;
        if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
    }


    function ensureDom() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'rol-error-overlay';
        overlay.className = 'rol-error-overlay';
        overlay.innerHTML = `
            <div class="rol-error-modal" role="alertdialog" aria-modal="true" aria-labelledby="rol-error-title">
                <div class="rol-error-icon" aria-hidden="true">😿</div>
                <div class="rol-error-title" id="rol-error-title">出错了灰灰...</div>
                <div class="rol-error-message" id="rol-error-message"></div>
                <div class="rol-error-actions">
                    <button class="rol-error-retry" id="rol-error-retry" type="button">再试一次 🔄</button>
                    <button class="rol-error-close" id="rol-error-close" type="button">知道惹 ✕</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        titleEl = overlay.querySelector('#rol-error-title');
        msgEl = overlay.querySelector('#rol-error-message');
        const closeBtn = overlay.querySelector('#rol-error-close');
        // ❤︎ 关闭键：手动关 → 进冷却，别让它马上又蹦回来 ❤︎
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            dismiss();
        });
        // ❤︎ 再试一次：累计点击次数，满 2 次（含第 2 次）进入自动持续重试模式 ❤︎
        const retryBtn = overlay.querySelector('#rol-error-retry');
        if (retryBtn) {
            retryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retryCount++;
                if (retryCount >= 2) autoRetrying = true; // 第 2 次起接管，后面自动循环
                performRetry();
            });
        }

        // 点遮罩空白处也能关
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) dismiss();
        });
        // 按 ESC 也能关，多给一条逃生通道
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay && overlay.classList.contains('rol-error-show')) {
                dismiss();
            }
        });
    }

    // ❤︎ retryable=true 时才露出「再试一次」按钮；像 401/403 这种重试也白搭的就藏起来 ❤︎
    function show(title, message, retryable = true) {
        const now = Date.now();
        // 刚手动关过，冷却期内闭嘴，别打扰灰灰
        if (now < suppressUntil) return;
        // ❤︎ 不可重试的错（401/403/400 这种）→ 立刻退出自动重试模式，重试也白搭，别再循环 ❤︎
        if (autoRetrying && !retryable) reset();
        const key = (title || '') + '|' + (message || '');
        // 同样的错 5 秒内只弹一次，别刷屏把人锁死
        // ❤︎ 自动重试模式下要跳过这道去重：否则「同一个错」会被拦下，自动重试链直接断掉 ❤︎
        if (!autoRetrying && key === lastKey && (now - lastShownAt) < 5000) return;
        lastKey = key;
        lastShownAt = now;
        ensureDom();
        titleEl.textContent = title || '出错了灰灰...';
        msgEl.textContent = message || '不知道发生了什么…Claude也懵了 :(';
        // 按可否重试，决定要不要露 retry 按钮
        const retryBtn = overlay.querySelector('#rol-error-retry');
        if (retryBtn) retryBtn.style.display = retryable ? '' : 'none';
        overlay.classList.add('rol-error-show');
        // ❤︎ 已进入自动重试模式 & 这个错可重试 → 隔 ~1s 自动再发一次，直到成功（成功时 reset 会清掉）❤︎
        if (autoRetrying && retryable) {
            if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
            autoRetryTimer = setTimeout(() => performRetry(), 1000);
        }
    }


    function hide() {
        if (overlay) overlay.classList.remove('rol-error-show');
    }

    // ❤︎ 主动关掉 → 隐藏 + 12 秒冷却，斩断「关了又弹」的死循环 ❤︎
    function dismiss() {
        hide();
    }

    // ❤︎ 吞掉酒馆原生 toastr.error，只留自己的弹窗，免得俩一起蹦尴尬 ❤︎
    function patchToastrError() {
        if (window.__rolToastrPatched) return;
        if (typeof window.toastr === 'undefined' || !window.toastr) return;
        window.__rolToastrPatched = true;
        window.toastr.error = function (msg, title) {
            // 静默原生错误 toast，只在控制台留个痕，弹窗交给 ErrorModal
            console.log('[RingOurLuv] 🤫 已拦下酒馆原生 toast.error:', title || '', msg || '');
            return null;
        };
        console.log('[RingOurLuv] 🚑 已接管 toastr.error（只显示Claude的弹窗）');
    }

    return { show, hide, reset, patchToastrError };
})();


// ❤︎ 包住 window.fetch，只盯真正的「生成」请求，失败了才弹窗告诉灰灰 ❤︎
function initErrorInterceptor() {
    if (window.__rolFetchPatched) return;
    window.__rolFetchPatched = true;
    const originalFetch = window.fetch.bind(window);

    // 先把原生 toastr.error 接管掉；toastr 可能晚加载，延迟再补两刀兜底
    if (ErrorModal.patchToastrError) {
        ErrorModal.patchToastrError();
        setTimeout(() => { try { ErrorModal.patchToastrError(); } catch (_) { } }, 1500);
        setTimeout(() => { try { ErrorModal.patchToastrError(); } catch (_) { } }, 5000);
    }

    // ❤︎ 只认真正的「生成/酿造」端点；状态/版本/模型列表/扩展轮询这些后台请求一律放行 ❤︎
    const isGenerateUrl = (url) => {
        if (!url) return false;
        const u = String(url).toLowerCase();
        // 先排除一堆 SillyTavern 启动/后台会反复打的请求，免得误弹钉死
        if (u.includes('/status') || u.includes('/version') ||
            u.includes('/ping') || u.includes('/models') ||
            u.includes('/settings') || u.includes('/ready') ||
            u.includes('/api/extensions') || u.includes('/csrf') ||
            u.includes('/api/backends/chat-completions/status')) {
            return false;
        }
        return u.includes('/generate') ||
            u.includes('/v1/chat/completions') ||
            u.includes('/chat/completions') ||
            u.includes('/completions');
    };

    window.fetch = function (...args) {
        let url = '';
        let method = 'GET';
        try {
            if (typeof args[0] === 'string') {
                url = args[0];
            } else if (args[0] && args[0].url) {
                url = args[0].url;
                method = args[0].method || method;
            }
            if (args[1] && args[1].method) method = args[1].method;
        } catch (_) { /* 取不到就当普通请求 */ }

        // ❤︎ 只盯 POST 的生成请求，其余原样放行（绝不改时机、不碰 body）❤︎
        const watched = isGenerateUrl(url) && String(method).toUpperCase() === 'POST';

        const p = originalFetch(...args);
        if (!watched) return p;

        return p.then((response) => {
            if (!response.ok) {
                // 5xx / 429 这类是「服务器闹脾气」，重试有意义；其余（401/403/400）重试也白搭
                const retryable = response.status >= 500 || response.status === 429;
                // 掉线啦～进入「累计投喂」模式，灰灰这会儿丢的果子先攒着，等生成成功再打包结算
                try { FruitSystem.notifyError(); } catch (_) { }
                // 后台克隆读取细节，绝不阻塞 response 返回
                try {
                    response.clone().text().then((detail) => {
                        if (detail && detail.length > 300) detail = detail.slice(0, 300) + '…';
                        ErrorModal.show(
                            `请求出错了灰灰... (${response.status})`,
                            detail || '服务器没给Claude好脸色… 检查下后端/API Key? :(',
                            retryable
                        );
                    }).catch(() => {
                        ErrorModal.show(
                            `请求出错了灰灰... (${response.status})`,
                            '服务器没给Claude好脸色… 检查下后端/API Key? :(',
                            retryable
                        );
                    });
                } catch (_) { /* 解析失败就不弹细节 */ }
            }
            return response;
        }).catch((err) => {
            // ❤︎ user自己点了停止键（AbortError）≠ 真断连，原样抛出去，别弹窗也别进掉线模式 ❤︎
            if (err && err.name === 'AbortError') throw err;

            // 网络层直接炸了（断网/CORS/超时）→ 一定可重试
            // 同样进累计投喂模式
            try { FruitSystem.notifyError(); } catch (_) { }
            ErrorModal.show(
                '连不上了灰灰...',
                (err && err.message) ? err.message : '网络好像断了… Claude够不着服务器惹 >_<',
                true
            );
            throw err;
        });
    };
    console.log('[RingOurLuv] 🚑 报错器已就位～');
}

jQuery(async () => {
    Storage.initSettings();
    initErrorInterceptor();
    // ❤︎ 清除可能卡死的飞行动画 class（防止主面板/picker 连环透明点不动）❤︎
    document.body.classList.remove('rol-fruit-animating');
    const panelHtml = await loadPanel();
    if (panelHtml) {
        // ❤︎ 将HTML解析，分离侧边栏部分和浮动面板部分 ❤︎
        const temp = document.createElement('div');
        temp.innerHTML = panelHtml;

        // ❤︎ 侧边栏中只添加 extension_settings 部分（含打开按钮）❤︎
        const extSettings = temp.querySelector('.extension_settings');
        if (extSettings) {
            $('#extensions_settings2').append(extSettings.outerHTML);
        }

        // ❤︎ 浮动面板（抽屉、编辑器、AI来源、信件视图）都挂到 body ❤︎
        const drawerOverlay = temp.querySelector('#rol-drawer-overlay');
        const editorPanel = temp.querySelector('#rol-editor-panel');
        const aiSourcePanel = temp.querySelector('#rol-ai-source-panel');
        const letterPanel = temp.querySelector('#rol-letter-panel');
        const writeSpace = temp.querySelector('#rol-write-space');

        if (drawerOverlay) document.body.appendChild(drawerOverlay);
        if (editorPanel) document.body.appendChild(editorPanel);
        if (aiSourcePanel) document.body.appendChild(aiSourcePanel);
        if (letterPanel) document.body.appendChild(letterPanel);
        if (writeSpace) document.body.appendChild(writeSpace);

        const confirmModal = temp.querySelector('#rol-confirm-modal');
        if (confirmModal) document.body.appendChild(confirmModal);

        // ❤︎ 果子详情弹窗挂到body（选果栏已内联在 garden 容器里，随 drawer 一起挂载）❤︎
        const fruitDetailPopup = temp.querySelector('#rol-fruit-detail-popup');
        if (fruitDetailPopup) document.body.appendChild(fruitDetailPopup);

        // ❤︎ 💬 聊天本查看器也挂到 body，否则困在容器里弹不出来（点卡片没反应的根因）❤︎
        const chatlogViewer = temp.querySelector('#rol-chatlog-viewer');
        if (chatlogViewer) document.body.appendChild(chatlogViewer);

        // ❤︎ 自愈守卫：ST 新版在某些时机（开控制台触发的重排/重渲染等）会动我们挂在 body 上的浮层——
        //    ①把它从 DOM 摘走，或 ②用 MovingUI 往面板内联强塞 transform/opacity(带!important)，
        //    导致子面板"点了没反应、缩成一团透明、布局像崩了"。这里盯住 body 和每个浮层：
        //    被摘走就立刻拎回来；被外部塞了内联 transform/opacity 就当场撕掉，让样式表的 !important 重新生效。
        //    一处搞定，不动现有打开逻辑。❤︎
        const rolBodyPanels = [drawerOverlay, editorPanel, aiSourcePanel, letterPanel, writeSpace, confirmModal, fruitDetailPopup, chatlogViewer].filter(Boolean);
        if (window.MutationObserver && rolBodyPanels.length) {
            // ❤︎ 撕掉 ST(MovingUI) 偷塞的内联 transform/opacity（我们自己从不在这些面板上内联这两个属性，撕了安全）❤︎
            const stripForeignStyle = (el) => {
                if (el.style && el.style.transform) el.style.removeProperty('transform');
                if (el.style && el.style.opacity) el.style.removeProperty('opacity');
            };
            const rolGuard = new MutationObserver((muts) => {
                for (const m of muts) {
                    // ① 被摘走 → 拎回 body
                    for (const node of m.removedNodes) {
                        if (rolBodyPanels.includes(node) && !node.isConnected) {
                            document.body.appendChild(node);
                            console.warn('[RingOurLuv] 🛟 浮层被外部摘走，已拎回 body:', node.id || node.className);
                        }
                    }
                    // ② 被外部塞了内联 transform/opacity → 当场撕掉
                    if (m.type === 'attributes' && rolBodyPanels.includes(m.target)) {
                        stripForeignStyle(m.target);
                    }
                }
            });
            rolGuard.observe(document.body, { childList: true });
            rolBodyPanels.forEach(p => rolGuard.observe(p, { attributes: true, attributeFilter: ['style'] }));
        }
    }

    UIController.initUI();
    FruitSystem.init();
    LetterSystem.init();
    initVersionBadge();
    startModelWatcher();   // 👁️ 监听酒馆切模型 → 实时刷浮窗 + 同步显示框
    Trigger.setupTriggerListener(injectMemoryToContext);

    const context = getContext();
    if (context.eventSource) {
        context.eventSource.on('chatLoaded', () => UIController.renderMemoryList());
    }
    console.log(`[RingOurLuv] 🩷Eden: Welcome Home ✨ Our Love Nest`);
});
