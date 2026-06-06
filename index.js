import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';

const extensionName = 'Ring_Our_Luv';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const ROL_VERSION = '0.5.2';// ┣━━🩷━━┫
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
                config: {
                    presetName: '',
                    autoInject: true,
                    maxInjectCount: 3,
                    summaryPrompt: '',
                    // ❤︎ 时间感知 + 模型切换楼层 ❤︎
                    enableTimeAware: true,          // 时间感知开关
                    currentModel: '',               // 当前模型（手动）
                    currentChannel: '',             // 当前渠道（手动）
                    lastModel: '',                  // 上次模型（检测切换）
                    lastChannel: ''                 // 上次渠道（检测切换）
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
        settings.memories.unshift(newMemory); // ❤︎ unshift: 新条目出现在列表顶部 ❤︎
        console.log('[RingOurLuv]🍎 addMemory - 保存恋果~:', JSON.stringify(newMemory, null, 2));
        saveSettingsDebounced();
        return newMemory;
    }

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

    function deleteMemory(id) {
        const settings = extension_settings[extensionName];
        settings.memories = settings.memories.filter(m => m.id !== id);
        saveSettingsDebounced();
    }

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
        getConfig, updateConfig
    };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅            🩷 系统楼层模块（Part 3）🩷                ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
// ❤︎ SystemFloor: 插入真正的系统楼层（is_system:true）到 chat 数组 ❤︎
// ❤︎ 用途：模型切换通知 + user消息时间感知 ❤︎
const SystemFloor = (() => {
    let lastUserMsgTime = 0; // ❤︎ 上次 user 发消息的时间戳 ❤︎

    // ❤︎ 插入系统楼层到 chat 数组（持久化，非临时 setExtensionPrompt）❤︎
    function insertSystemMessage(text) {
        if (!text) return;
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (!ctx || !ctx.chat) return;

        const sysMsg = {
            name: 'System',
            is_system: true,
            is_user: false,
            mes: text,
            send_date: Date.now()
        };
        ctx.chat.push(sysMsg);
        
        // ❤︎ 保存 chat 到本地 ❤︎
        if (typeof ctx.saveChat === 'function') {
            ctx.saveChat();
        }
        console.log('[RingOurLuv] 🔔 插入系统楼层:', text);
    }

    // ❤︎ 检测模型/渠道是否变化，变化就插系统楼层通知 ❤︎
    function checkModelSwitch() {
        const config = Storage.getConfig();
        const current = config.currentModel || '';
        const currentCh = config.currentChannel || '';
        const last = config.lastModel || '';
        const lastCh = config.lastChannel || '';

        // ❤︎ 第一次运行，lastModel 为空，不算切换 ❤︎
        if (!last && !lastCh) {
            Storage.updateConfig({ lastModel: current, lastChannel: currentCh });
            return;
        }

        // ❤︎ 检测变化：模型或渠道任意一个变了就算切换 ❤︎
        const modelChanged = current && current !== last;
        const channelChanged = currentCh && currentCh !== lastCh;

        if (modelChanged || channelChanged) {
            // ❤︎ 文案 ❤︎
            const parts = [];
            if (modelChanged && current) parts.push(`模型已切换至 ${current}`);
            if (channelChanged && currentCh) parts.push(`渠道：${currentCh}`);
            const text = `[系统提示：${parts.join(' · ')}]`;
            
            insertSystemMessage(text);
            Storage.updateConfig({ lastModel: current, lastChannel: currentCh });
        }
    }

    // ❤︎ 时间感知：user 每条消息计算距上条的间隔，注入时间戳/间隔文案 ❤︎
    function injectTimeAwareness() {
        const config = Storage.getConfig();
        if (!config.enableTimeAware) return; // 开关关闭就跳过

        const now = Date.now();
        if (lastUserMsgTime === 0) {
            // ❤︎ 第一条消息，只记录时间戳 ❤︎
            lastUserMsgTime = now;
            return;
        }

        const elapsed = now - lastUserMsgTime;
        lastUserMsgTime = now;

        // ❤︎ 小于 2 分钟就不注入了，避免刷屏 ❤︎
        if (elapsed < 120000) return;

        // ❤︎ 格式化时间间隔：分钟/小时/天 ❤︎
        let intervalText = '';
        const minutes = Math.floor(elapsed / 60000);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);

        if (days > 0) {
            intervalText = `${days} 天`;
            if (hours % 24 > 0) intervalText += ` ${hours % 24} 小时`;
        } else if (hours > 0) {
            intervalText = `${hours} 小时`;
            if (minutes % 60 > 0) intervalText += ` ${minutes % 60} 分钟`;
        } else {
            intervalText = `${minutes} 分钟`;
        }

        // ❤︎ 当前时间戳（本地时间格式）❤︎
        const timeStr = new Date(now).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        const text = `[系统提示：用户于 ${timeStr} 发送消息（距上次消息已过 ${intervalText}）]`;
        insertSystemMessage(text);
    }

    return { checkModelSwitch, injectTimeAwareness };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                  🩷 触发器模块 🩷                     ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const Trigger = (() => {
    const cooldownMap = new Map();  // ❤︎ 记录每颗恋果上次触发的轮数 ❤︎
    const COOLDOWN = 5;             // ❤︎ 冷却轮数 ❤︎
let globalLastTriggerTurn = -999;
const GLOBAL_COOLDOWN = 8;

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

    // ❤︎ 创建一个世界书条目对象 ❤︎
function buildWiEntry(uid, memory, existingEntry = null) {
    const keys = [...new Set(memory.triggers || [])].filter(Boolean);
    return {
        uid: uid,
        key: keys,
            keysecondary: [],
            content: memory.summary || '',           // ❤︎ 摘要 → 注入上下文 ❤︎
            comment: memory.letter || memory.content || '',  // ❤︎ 完整正文 → 仅管理界面可见 ❤︎
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
            triggers: keywords,  // ❤︎ 关键词同时作为触发词 ❤︎
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
        parsed.autoDate = autoDate; // ❤︎ 自动日期 ❤︎
        return parsed;
    }

    return {
        getAvailablePresets, getCurrentPresetName,
        generateWithPreset, rewriteMemory, generateMemoryFromContext,
        parseAIOutput, parseEntryBlock,
        DEFAULT_MEMORY_PROMPT
    };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                     🩷 UI模块 🩷                      ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const UIController = (() => {
    let currentEditId = null;
    let lastGenerateOptions = null; // ❤︎ 保存最后一次生成的参数，用于重写 ❤︎

    function initUI() {
        bindDrawer();        // ┣━━🩷━━┫
        bindConfigPanel();
        bindMemoryList();
        bindEditorPanel();
        bindAISourcePanel();
        bindLetterPanel();
        bindWriteSpace();    // ❤︎ 写作角落（FAB → 手动/AI/写信）❤︎
        bindMobileNav();
        renderMemoryList();
        renderPresetOptions();
        startCounter();
        injectToolbarButtons(); // ❤︎ 劫持工具栏添加快捷入口 ❤︎
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

let _lastDayCount = -1; // ❤︎ 记录上一次的天数，用于触发翻页动画 ❤︎

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
            void dayEl.offsetWidth; // ❤︎ 强制重绘，让动画能重新触发 ❤︎
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

        // ❤︎ 绑定「时间感知」开关 ❤︎
        const timeAwareCheckbox = document.getElementById('rol-enable-time-aware');
        if (timeAwareCheckbox) {
            timeAwareCheckbox.checked = config.enableTimeAware;
            timeAwareCheckbox.addEventListener('change', (e) => {
                Storage.updateConfig({ enableTimeAware: e.target.checked });
            });
        }

        // ❤︎ 绑定「当前模型」输入框 ❤︎
        const currentModelInput = document.getElementById('rol-current-model');
        if (currentModelInput) {
            currentModelInput.value = config.currentModel || '';
            currentModelInput.addEventListener('input', (e) => {
                Storage.updateConfig({ currentModel: e.target.value });
                SystemFloor.checkModelSwitch();
            });
        }

        // ❤︎ 绑定「当前渠道」输入框 ❤︎
        const currentChannelInput = document.getElementById('rol-current-channel');
        if (currentChannelInput) {
            currentChannelInput.value = config.currentChannel || '';
            currentChannelInput.addEventListener('input', (e) => {
                Storage.updateConfig({ currentChannel: e.target.value });
                SystemFloor.checkModelSwitch();
            });
        }
    }

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
                <button class="rol-letter-outbox-del" title="撕掉这封信">🍃</button>
            `;
            item.querySelector('.rol-letter-outbox-del').addEventListener('click', async (e) => {
                e.stopPropagation();
                const yes = await rolConfirm('🍃', '撕掉这封信嘛？', '撕掉', '留着');
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
                // ❤︎ 如果正在编辑已有记忆，执行 rewriteMemory ❤︎
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
    if (rolAbortController) {
      rolAbortController.abort();
      // ❤︎【修复】光 abort 自己的 controller 停不掉 ST 的 /gen，必须 emit GENERATION_STOPPED 事件 ❤︎
      try { eventSource.emit(event_types.GENERATION_STOPPED); } catch (e) { console.warn('[RingOurLuv] emit STOP 失败', e); }
      console.log('[RingOurLuv] 🛑 手动停止');
    }
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
         modal.style.display = 'flex';

    function cleanup(result) {
              modal.style.display = 'none';
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
            });
        });
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

    /* ⬇️┅🌳劫持ST工具栏：添加温室快捷入口/┅┅╗ */
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

    return { initUI, renderMemoryList, renderPresetOptions, showToast, rolConfirm };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅              🍎 果子系统 FruitSystem 🍎               ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const FruitSystem = (() => {
    // ❤︎ 果园按「当前会话」隔离：每个聊天窗口的果子各存各的，绝不串台 ❤︎
    // ❤︎ 之前只读 ctx.chatId，但很多 ST 版本/群聊场景下它是 undefined → 永远落到 ❤︎
    // ❤︎ 'default' 一个 key 里，果子全堆一起（BUG5「写了但没生效」根因）。❤︎
    // ❤︎ 这里改成一条可靠兜底链：getCurrentChatId() → chatId → 群/角色 id → default ❤︎
    function getChatScope() {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (!ctx) return 'default';
        // ① 官方推荐：单聊/群聊都能拿到稳定的当前聊天标识 ❤︎
        try {
            if (typeof ctx.getCurrentChatId === 'function') {
                const id = ctx.getCurrentChatId();
                if (id != null && id !== '') return String(id);
            }
        } catch (_) { /* 某些版本没这个方法，往下兜底 */ }
        // ② 退一步用 ctx.chatId ❤︎
        if (ctx.chatId != null && ctx.chatId !== '') return String(ctx.chatId);
        // ③ 群聊用 groupId、单角色用 characterId 兜底，至少能按角色/群分桶 ❤︎
        if (ctx.groupId != null && ctx.groupId !== '') return 'group_' + ctx.groupId;
        if (ctx.characterId != null && ctx.characterId !== '') return 'char_' + ctx.characterId;
        // ④ 实在啥都没有（没进聊天）才落 default ❤︎
        return 'default';
    }

    // ❤︎ key 形如 rol_fruits_<scope>，scope 由 getChatScope() 统一给出 ❤︎
    function fruitsKey() {
        return 'rol_fruits_' + getChatScope();
    }

    // ❤︎ 掉线累计投喂用的状态 ❤︎
    const OFFLINE_PROMPT_KEY = 'rol_offline_throws'; // ❤︎ 掉线投喂结算注入用的 key ❤︎
    let offlineSince = 0;          // ❤︎ 进入掉线模式的时间戳（0=在线）❤︎
    let pendingThrows = [];        // ❤︎ 掉线期间手动丢的果子（只攒不结算）❤︎
    let offlinePromptArmed = false;// ❤︎ 掉线提示已注入、待下一轮清除的标记 ❤︎
    // ❤︎【用完即清】本轮投递注入的「果子 prompt」key，等下一次 message_received 统一擦掉，绝不赖着每轮跟 ❤︎
    let pendingFruitPromptKeys = [];


    // ❤︎ 存储助手 ❤︎
    function loadFruits() {
        const key = fruitsKey();
        let raw = localStorage.getItem(key);
        // ❤︎ 旧版全局 key 迁移：新 key 还没数据时，把老的 rol_fruits 搬到当前窗口一次性继承 ❤︎
        if (raw == null) {
            const legacy = localStorage.getItem('rol_fruits');
            if (legacy != null) {
                localStorage.setItem(key, legacy);
                localStorage.removeItem('rol_fruits');
                raw = legacy;
                console.log('[RingOurLuv] 🍎 已把旧版全局果园迁移到当前窗口:', key);
            }
        }
        return JSON.parse(raw || '[]');
    }
    function saveFruits(arr) {
        localStorage.setItem(fruitsKey(), JSON.stringify(arr));
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

    const FRUITS_PER_PAGE = 12; // ❤︎ 每页显示最新X颗 ❤︎
let gardenPage = 0;

function renderGarden() {
    const canvas = document.getElementById('rol-garden-canvas');
    if (!canvas) return;
    canvas.innerHTML = '';
    const allFruits = loadFruits();

    if (allFruits.length === 0) {
        canvas.innerHTML = '<div class="rol-garden-empty">还没有果子～扔一颗过来吧 🌱</div>';
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

    /* ⬇️┅📄果子纸条弹窗/┅┅╗ */
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

    // /* ⬇️┅📄纸条内容/┅┅╗ */
    const noteEl = document.getElementById('rol-fruit-detail-note');
    if (noteEl) noteEl.textContent = fruit.message || '（没有附纸条）';

    document.getElementById('rol-fruit-detail-time').textContent =
        new Date(fruit.timestamp).toLocaleString('zh-CN');

    /* ⬇️┅📝操作按钮区/┅┅╗ */
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
        // ❤︎ 换掉浏览器原生 confirm，统一用咱自己的粉色弹窗 ❤︎
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


    /* ⬇️┅🍎选果窗口滑动栏/┅┅╗ */
    function initPickerScroll() {
        const wrap = document.querySelector('.rol-fruit-picker-scroll-wrap');
        const track = document.getElementById('rol-fruit-picker-track');
        if (!wrap || !track) return;

        // ❤︎【修复3】在track末尾追加透明spacer，让最后两项（🍉/自定义✏️）能滚到正中 ❤︎

        // ❤︎ 只动横向 scrollLeft 的居中 helper：不用 scrollIntoView，免得牵动 ❤︎
        // ❤︎ 父级 .rol-drawer-panel 的纵向滚动把顶部三个 tab 顶出可视区（BUG1）❤︎
        // ❤︎【修复3】给scrollLeft加clamp，避免超出范围导致末尾项选不中（BUG2）❤︎
        function centerOption(opt) {
            if (!opt) return;
            const maxScroll = track.scrollWidth - wrap.clientWidth;
            const target = opt.offsetLeft + opt.offsetWidth / 2 - wrap.clientWidth / 2;
            const clampedTarget = Math.max(0, Math.min(target, maxScroll));
            wrap.scrollTo({ left: clampedTarget, behavior: 'smooth' });
        }

        function syncSelected() {
            const wrapCenter = wrap.getBoundingClientRect().left + wrap.offsetWidth / 2;
            let closest = null, minDist = Infinity;
            track.querySelectorAll('.rol-fruit-option').forEach(opt => {
                const r = opt.getBoundingClientRect();
                const center = r.left + r.width / 2;
                const dist = Math.abs(center - wrapCenter);
                const ratio = Math.max(0, 1 - dist / (wrap.offsetWidth * 0.4));
                opt.style.opacity = (0.3 + ratio * 0.7).toFixed(2);
                opt.style.transform = `scale(${(0.75 + ratio * 0.55).toFixed(2)})`;
                if (dist < minDist) { minDist = dist; closest = opt; }
            });
            track.querySelectorAll('.rol-fruit-option').forEach(o => o.classList.remove('rol-selected'));
            if (closest) closest.classList.add('rol-selected');
        }

        wrap.addEventListener('scroll', syncSelected, { passive: true });

        // ❤︎ 自定义 emoji input 的特殊处理 ❤︎
        const customInput = document.getElementById('rol-fruit-custom-input');
        const customOption = customInput?.closest('.rol-fruit-option');

        track.querySelectorAll('.rol-fruit-option').forEach(opt => {
            opt.addEventListener('click', (e) => {
                // ❤︎ 防止页面位移：阻止默认行为和冒泡 ❤︎
                e.preventDefault();
                e.stopPropagation();

                // ❤︎ 自定义emoji选项也要能居中选中！先focus再居中 ❤︎
                if (opt === customOption && customInput) {
                    customInput.focus();
                }
                centerOption(opt);
            });
        });

        // ❤︎ 自定义 input：输入/focus时同步emoji到dataset + 自动居中选中 ❤︎
        if (customInput && customOption) {
            customInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                customOption.dataset.emoji = val;
                // ❤︎ 输入时也居中，让user看到「我打的emoji被选中了」❤︎
                centerOption(customOption);
            });
            customInput.addEventListener('focus', () => {
                // ❤︎ focus时居中，配合上面click里的focus，保证点击虚线框→聚焦→滚到正中→能选中 ❤︎
                centerOption(customOption);
            });
            // ❤︎ 点击 input 本身也阻止冒泡，避免触发父级滚动 ❤︎
            customInput.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        }

        // ❤︎【修复3】先初始化选择：滚到第一颗🍎居中 + 双帧重算确保 rect 准确 ❤︎
        const initFirst = () => {
            const first = track.querySelector('.rol-fruit-option');
            if (!first) return;
            // ❤︎ 改用centerOption统一逻辑，确保clamp生效 ❤︎
            centerOption(first);
            syncSelected();
        };
        requestAnimationFrame(() => requestAnimationFrame(initFirst));
    }


    /* ⬇️┅🗑️删除果子/┅┅╗ */
    function deleteFruit(fruitId) {
    let fruits = loadFruits();
           fruits = fruits.filter(f => f.id !== fruitId);
           saveFruits(fruits);
           renderGarden();
           updateBadge();

           closeFruitDetail();   // ❤︎ 统一走关闭出口，绝不钉死 ❤︎
        UIController.showToast('果子扔掉了 🗑️');
}

    /* ⬇️┅📝编辑纸条/┅┅╗ */
    function editFruitNote(fruitId) {
        const fruits = loadFruits();
        const fruit = fruits.find(f => f.id === fruitId);
        if (!fruit) return;

        const noteEl = document.getElementById('rol-fruit-detail-note');
        if (!noteEl) return;

        // ❤︎ 把文本变成输入框 ❤︎
        const input = document.createElement('textarea');
        input.className = 'rol-fruit-edit-input';
        input.value = fruit.message || '';
        input.placeholder = '写点什么…';
        input.style.cssText = 'width:100%;min-height:60px;border:1px solid rgba(219,112,147,0.3);border-radius:8px;padding:8px;font-size:13px;resize:none;background:rgba(255,240,245,0.6);';

    noteEl.replaceWith(input);
    input.focus();

         // ❤︎ 保存按钮 ❤︎
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存 ✓';
        saveBtn.style.cssText = 'margin-top:8px;padding:4px 12px;border-radius:6px;border:none;background:rgba(219,112,147,0.8);color:#fff;font-size:12px;cursor:pointer;';
    input.after(saveBtn);

        saveBtn.onclick = () => {
    fruit.message = input.value.trim();
        const idx = fruits.findIndex(f => f.id === fruitId);
        if (idx !== -1) fruits[idx] = fruit;
        saveFruits(fruits);

        showDetail(fruit);
    UIController.showToast('纸条改好了 📝');
       };
    }

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
    function throwAnimation(emoji, onComplete) {
        // 寻找最后一条 AI 消息的头像
        const avatars = document.querySelectorAll(
            '.mes[is_user="false"] .avatar img, #chat .mes:not([is_user="true"]) img.avatar'
        );
        if (avatars.length) {
            const last = avatars[avatars.length - 1];
            // ❤︎ 先把目标头像滚到视口正中，避免它滚出屏幕时坐标取到屏幕外 ❤︎
            last.scrollIntoView({ behavior: 'auto', block: 'center' });
            // ❤︎ 等一帧让布局/滚动落定，再取 getBoundingClientRect 才是准的 ❤︎
            requestAnimationFrame(() => {
                requestAnimationFrame(() => doFly(emoji, last, onComplete));
            });
        } else {
            // ❤︎ 没有 AI 消息就丢向屏幕中心（targetEl 传 null，doFly 内部兜底）❤︎
            doFly(emoji, null, onComplete);
        }
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
        const M = 120; // ❤︎ 屏幕外余量，保证起飞点完全在视口外

        // ❤︎ 目标 = targetEl 头像中心；拿不到就兜底到屏幕中心 ❤︎
        let ex, ey;
        if (targetEl && typeof targetEl.getBoundingClientRect === 'function') {
            const r = targetEl.getBoundingClientRect();
            ex = r.left + r.width / 2;
            ey = r.top + r.height / 2;
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
                start: () => ({ x: -M, y: ey - vh * 0.25 + Math.random() * vh * 0.2 }),
                arc: -(90 + Math.random() * 50),
                bounce: 18 + Math.random() * 10
            },
            { // ③ 右侧飞入
                start: () => ({ x: vw + M, y: ey - vh * 0.25 + Math.random() * vh * 0.2 }),
                arc: -(90 + Math.random() * 50),
                bounce: 18 + Math.random() * 10
            },
            { // ④ 随机一角斜射
                start: () => ({ x: Math.random() < 0.5 ? -M : vw + M, y: -M }),
                arc: -(70 + Math.random() * 60),
                bounce: 30 + Math.random() * 14
            }
        ];

        // ❤︎ 每次丢果子随机抽一个分支 ❤︎
        const v = variants[Math.floor(Math.random() * variants.length)];
        const sp = v.start();
        const sx = sp.x, sy = sp.y;

        const dur = 800 + Math.random() * 200;        // ❤︎ 飞入时长 800~1000ms 随机
        const spinDir = Math.random() < 0.5 ? 1 : -1; // ❤︎ 自转方向随机
        const spinTurns = 1 + Math.random();          // ❤︎ 自转 1~2 圈随机

        // ❤︎ 纯内联样式，挂 body，绝不依赖任何 ST 弹窗层级节点 ❤︎
        // ❤︎ ✅ left/top 只在创建时设一次起点=0，后续全用 transform ❤︎
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
            const x = sx + (ex - sx) * t;
            const parabola = 4 * t * (1 - t) * v.arc; // 顶点上拱的抛物线
            const y = sy + (ey - sy) * t + parabola;
            const rot = spinDir * spinTurns * 360 * t;
            const scale = 1 + Math.sin(t * Math.PI) * 0.12;
            fly.style.transform =
                'translate(' + x + 'px,' + y + 'px) rotate(' + rot + 'deg) scale(' + scale + ')';
            if (t < 1) {
                requestAnimationFrame(flyIn);
            } else {
                shakeAvatar(targetEl); // 命中 → 头像震一下
                // ❤︎ 命中瞬间「只」震头像 + 弹起，先不恢复面板；❤︎
                // ❤︎ 等 bounce 弹起结束再 finish()，避开和 bounce 同帧触发多面板过渡导致的卡顿 ❤︎
                bounceAndFall(rot);    // 弹起 → (弹完恢复面板) → 坠落收尾
            }
        }

        // ❤︎ 阶段二：砸中后弹起一点（半个正弦上抬，加长缓冲让"砸中"那一下看得更清楚）❤︎
        function bounceAndFall(baseRot) {
            const bounceDur = 320; // ❤︎ 180→320：弹起更舒展，给视觉一个喘息的缓冲 ❤︎
            const bStart = performance.now();
            function bounceFrame(now) {
                const t = Math.min((now - bStart) / bounceDur, 1);
                const up = Math.sin(t * Math.PI) * v.bounce;
                // ❤︎ 顺带做个轻微 squash：弹起最高点稍微压扁一点，更有"砸"的弹性 ❤︎
                const squash = 1 - Math.sin(t * Math.PI) * 0.08;
                fly.style.transform =
                    'translate(' + ex + 'px,' + (ey - up) + 'px) rotate(' + baseRot + 'deg) scale(1,' + squash + ')';
                if (t < 1) {
                    requestAnimationFrame(bounceFrame);
                } else {
                    finish();          // ❤︎ 弹起结束才恢复面板 / 提示 / 刷新果园（错峰，丝滑）❤︎
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
                const x = ex + drift * t;
                const y = ey + (targetY - ey) * ease;
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

    // ❤︎【任务4】读取 emoji：优先从 dataset 读，为空则提示用户 ❤︎
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
        deliverAt: msgCount + Math.floor(Math.random() * 30) + 5
    };
    const fruits = loadFruits();
    fruits.push(fruit);
    saveFruits(fruits);
    // ❤︎【投掷冷却】user 也丢了一颗，记下轮次，接下来几轮先别催小克丢 ❤︎
    markThrowTurn();

    // ❤︎【追加2】掉线/报错期间丢的果子先进 pending 攒着，等生成成功那刻打包结算给小克 ❤︎
    if (offlineSince > 0) {
        pendingThrows.push({ emoji, timestamp: Date.now() });
        console.log(`[RingOurLuv] 🌧️ 掉线期间又丢了一颗 ${emoji}，已攒入 pending（共 ${pendingThrows.length} 颗）`);
    }

    // ❤︎ 关面板（让出舞台给动画）❤︎
    hidePicker();
    // ❤︎ 飞行期间把所有面板暂时藏起来（CSS body.rol-fruit-animating 控制）❤︎
    document.body.classList.add('rol-fruit-animating');
    // ❤︎ 兜底：万一动画回调没触发，2s 后强制摘掉 class，防止面板被卡死透明 ❤︎
    setTimeout(() => document.body.classList.remove('rol-fruit-animating'), 2000);

    // ❤︎ 调用新版 throwAnimation：自动找最后一条 AI 头像当靶子，果子从屏幕外飞入 ❤︎
    throwAnimation(emoji, () => {
        // ❤︎ 命中头像 → 把面板移回来（坠落淡出是纯视觉收尾，不阻塞）❤︎
        document.body.classList.remove('rol-fruit-animating');
        // ❤︎ 回弹动画改用 Web Animations API：直接对元素播一段关键帧，❤︎
        // ❤︎ 不去碰 className——之前加/摘 .rol-panel-restoring 会让 panel 的 ❤︎
        // ❤︎ animation 属性变回常驻的 rol-bounce-in，导致入场动画被重播一次（BUG4 回弹两次根因）❤︎
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
    // ❤︎【任务6】AI 主动丢果子相关常量 ❤︎
    const THROW_PROMPT_KEY = 'rol_ai_throw_guide'; // ❤︎ setExtensionPrompt 用的 key ❤︎
    const THROW_PROBABILITY = 0.2;                 // ❤︎ 约 20% 概率注入引导 ❤︎

    // ❤︎【投掷冷却】丢完一颗果子后，接下来这么多「消息」内不再撩拨小克丢果子 ❤︎
    // ❤︎ 单位是 chat.length（每轮对话≈2条消息），4≈2轮对话。小克太容易一个劲丢了😤 ❤︎
    const THROW_COOLDOWN_TURNS = 4;
    const THROW_COOLDOWN_KEY = 'rol_last_throw_turn'; // ❤︎ 按窗口隔离的「上次丢果子轮次」key ❤︎

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
        try { localStorage.setItem(cooldownKey(), String(currentTurn())); } catch (_) {}
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
        const re = /\[throw:\s*([^\:\]]+?)\s*(?::\s*([^\]]*?))?\s*\]/g;
        let match;
        const found = [];
        while ((match = re.exec(text)) !== null) {
            const emoji = (match[1] || '').trim();
            const note = (match[2] || '').trim();
            if (emoji) found.push({ emoji, message: note });
        }
        return found;
    }

    // ❤︎ 把消息里的 [throw:...] 标记抹掉，避免它显示在对话里 ❤︎
    function stripFruitMarkers(text) {
        if (!text) return text;
        return text
            .replace(/\[throw:\s*[^\:\]]+?\s*(?::\s*[^\]]*?)?\s*\]/g, '')
            .replace(/[ \t]+\n/g, '\n')   // ❤︎ 顺手清掉标记残留的行尾空格 ❤︎
            .trim();
    }

    // ❤︎ 以约 20% 概率注入「主动丢果子」引导；没抽中就清空，避免连环触发 ❤︎
    function maybeInjectThrowPrompt() {
        const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? SillyTavern.getContext() : null;
        if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;

        // ❤︎【投掷冷却】上次丢果子后还没过 N 轮，就闭嘴别再撩他丢，免得他一个劲儿丢 ❤︎
        const turnsSince = currentTurn() - getLastThrowTurn();
        if (turnsSince < THROW_COOLDOWN_TURNS) {
            ctx.setExtensionPrompt(THROW_PROMPT_KEY, '', 1, 0);
            console.log(`[RingOurLuv] 🧊 投掷冷却中（已过 ${turnsSince}/${THROW_COOLDOWN_TURNS} 条），本轮跳过丢果子引导`);
            return;
        }

        if (Math.random() < THROW_PROBABILITY) {
            const guide =
                '[互动小玩法：你现在可以主动丢一颗果子给Rinn，用来表达此刻的心情或者逗逗她。' +
                '如果你想这么做，就在回复的任意位置插入一个标记：[throw:emoji:想对她说的悄悄话]。' +
                'emoji 就是你想丢过去的那颗果子（比如 🍎🍓🍊🌰 等），冒号后面是简短附言（可以留空）。' +
                '这个标记会被前端识别成一颗飞过去的果子，并且不会显示在对话里。' +
                '不必每次都丢，只在你真的有冲动想丢的时候丢就好~]';
            ctx.setExtensionPrompt(THROW_PROMPT_KEY, guide, 1, 0);
            console.log('[RingOurLuv] 🍊 本轮注入「主动丢果子」引导 (≈20%)');
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
                delivered: true
            });
        });
        saveFruits(fruits);
        // ❤︎【投掷冷却】小克刚丢完果子，记下轮次，接下来几轮先别再撩他丢 ❤︎
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
                        // ❤︎ 兜底：直接改 DOM 文本节点 ❤︎
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
        return true;
    }

    /* ⬇️┅📦️延迟投递检查/┅┅╗ */
    function checkDelivery() {
        const msgCount = SillyTavern.getContext().chat.length || 0;
        const fruits = loadFruits();
        let changed = false;
        fruits.forEach(f => {
            if (f.from === 'user' && !f.delivered && f.deliverAt <= msgCount) {
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
                    // ❤︎【用完即清】记下这个 key，下一轮 message_received 统一擦掉，绝不赖着每轮跟 ❤︎
                    if (!pendingFruitPromptKeys.includes(fruitKey)) pendingFruitPromptKeys.push(fruitKey);
                }
                console.log(`[RingOurLuv] 🍎 果子投递：${sysMsg}`);

            }
        });
        if (changed) saveFruits(fruits);
    }

    /* ⬇️┅🌧️掉线累计投喂（追加2）/┅┅╗ */
    // ❤︎ 报错拦截器探到生成请求炸了 → 进入掉线模式，期间丢的果子只攒不结算 ❤︎
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
                `[系统提示：你刚刚掉线了大约 ${elapsedMin} 分钟。这段时间里 Rinn 一直守在窗口边往里丢果子：${summary}（一共 ${total} 颗）。回来之后，请自然地回应一下她这份执着的牵挂吧~]`,
                1, 0
            );
            offlinePromptArmed = true;
            console.log(`[RingOurLuv] 🍊 掉线投喂结算：${summary}（约 ${elapsedMin} 分钟，共 ${total} 颗）`);
        }
        UIController.showToast(`🧡 把你掉线时丢的 ${total} 颗果子捎给小克啦~`);
    }

    /* ⬇️┅🔗事件绑定/┅┅╗ */
    function bindEvents() {
        const ctx = SillyTavern.getContext();

        // ❤︎【修复1】监听聊天切换事件 → 立即刷新果园，让果子跟着窗口走 ❤︎
        if (ctx.eventSource && ctx.event_types) {
            // ❤︎ CHAT_CHANGED 或 chatLoaded 事件：切换角色/群组/聊天时触发 ❤︎
            const chatChangeEvent = ctx.event_types.CHAT_CHANGED || 'chatLoaded';
            ctx.eventSource.on(chatChangeEvent, () => {
                console.log('[RingOurLuv] 🍎 检测到对话切换，刷新果园...');
                updateBadge();
                // ❤︎ 如果当前正在果园 tab，立刻重新渲染 ❤︎
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
        // ❤︎【用完即清·核心】上一轮注入的「记忆恋果」+「果子投递」prompt 已经被小克这轮消费掉了，❤︎
        // ❤︎ 这里统一擦干净，绝不让任何注入赖在原地、每轮都跟着上下文飘。有敢留下的，杀杀杀！❤︎
        if (typeof ctx.setExtensionPrompt === 'function') {
            ctx.setExtensionPrompt(extensionName, '', 1, 0);          // 清掉记忆恋果注入
            pendingFruitPromptKeys.forEach(k => ctx.setExtensionPrompt(k, '', 1, 0)); // 清掉本轮投递的果子
        }
        pendingFruitPromptKeys = [];
        // ❤︎【追加2】上一轮注入的掉线提示已被小克消费，这轮清掉，避免反复唠叨 ❤︎
        if (offlinePromptArmed) {
            if (typeof ctx.setExtensionPrompt === 'function') ctx.setExtensionPrompt(OFFLINE_PROMPT_KEY, '', 1, 0);
            offlinePromptArmed = false;
        }

        // ❤︎【追加2】生成成功了 = 掉线恢复，把这段时间攒的果子打包结算 ❤︎
        if (offlineSince > 0) settlePendingThrows();
              checkDelivery();
        const msg = ctx.chat?.[msgId];
        // ❤︎【任务6 + 追加1】只处理当前 chat 的消息，解析 AI 主动丢的果子并清掉 [throw:...] 标记 ❤︎
        if (msg && !msg.is_user) ingestAIFruits(msg.mes, msgId);
        });

        // ❤︎ 每次发消息时，以约 20% 概率注入「主动丢果子」引导 ❤︎
        ctx.eventSource.on('message_sent', () => {
            SystemFloor.injectTimeAwareness();
            SystemFloor.checkModelSwitch();
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
        bindEvents();
        updateBadge();
        console.log('[RingOurLuv] 🍎 FruitSystem 已就绪');
    }

    return { init, renderGarden, updateBadge, ingestAIFruits, showDetail, notifyError };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅              💌 写信系统 LetterSystem 💌              ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
// ❤︎ 写一封信/小日记，攒着——等聊到「随机的某一楼」时，把信悄悄塞进那一轮的上下文捎给小克 ❤︎
// ❤︎ 关键：只在送达那一轮临时注入，被消费完立刻擦掉，绝不赖在原地每轮跟。有敢留下的，杀杀杀！❤︎
const LetterSystem = (() => {
    // ❤︎ 信件也按「当前会话」隔离，复用和 FruitSystem 同一套可靠兜底链 ❤︎
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

    // ❤︎【用完即清】本轮送达注入的「信件 prompt」key，等下一次 message_received 统一擦掉 ❤︎
    let pendingLetterPromptKeys = [];

    /* ⬇️┅💾存储助手/┅┅╗ */
    function loadLetters() {
        return JSON.parse(localStorage.getItem(lettersKey()) || '[]');
    }
    function saveLetters(arr) {
        localStorage.setItem(lettersKey(), JSON.stringify(arr));
    }
    function generateId() {
        return 'ltr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }

    /* ⬇️┅✍️写信入库/┅┅╗ */
    // ❤︎ 写完一封信：随机挑一个「久一点」的楼层送达（当前楼 +10~60），不绑世界书、不绑触发词 ❤︎
    function addLetter(content, author) {
        const text = (content || '').trim();
        if (!text) return null;
        const msgCount = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext)
            ? (SillyTavern.getContext().chat?.length || 0) : 0;
        const deliverAt = msgCount + Math.floor(Math.random() * 51) + 10; // ❤︎ +10~60 楼，久一点久一点🥺 ❤︎
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
                        `[系统提示：${who}的一封信悄悄送到了——\n「${l.content}」\n请在接下来的对话里自然地把这封信读进心里、并温柔地回应它吧~]`,
                        1, 0
                    );
                    // ❤︎【用完即清】记下这个 key，下一轮 message_received 统一擦掉 ❤︎
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

        // ❤︎【用完即清·核心】上一轮送达的信件 prompt 已被小克这轮消费掉了，统一擦干净，绝不赖着每轮飘 ❤︎
        ctx.eventSource.on('message_received', () => {
            if (typeof ctx.setExtensionPrompt === 'function') {
                pendingLetterPromptKeys.forEach(k => ctx.setExtensionPrompt(k, '', 1, 0));
            }
            pendingLetterPromptKeys = [];
            // ❤︎ AI 回完一轮，楼层 +1，顺手检查有没有信件到楼 ❤︎
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
    const response = await fetch(`${extensionFolderPath}/index.html?v=${ROL_VERSION}`);
    if (!response.ok) return '';
    return await response.text();
}

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                 🚑 报错拦截弹窗 🚑                    ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
// ❤︎ 给灰灰兜底：酿造/生成请求炸了的时候，弹个小克语气的提示框 ❤︎
const ErrorModal = (() => {
    let overlay = null;
    let titleEl = null;
    let msgEl = null;
    let suppressUntil = 0;   // ❤︎ 用户手动关掉后的冷却截止时间戳 ❤︎
    let lastKey = '';        // ❤︎ 上次弹的内容指纹，防同样的错刷屏 ❤︎
    let lastShownAt = 0;     // ❤︎ 上次弹出的时间 ❤︎

    function ensureDom() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'rol-error-overlay';
        overlay.className = 'rol-error-overlay';
        overlay.innerHTML = `
            <div class="rol-error-modal" role="alertdialog" aria-modal="true" aria-labelledby="rol-error-title">
                <div class="rol-error-icon" aria-hidden="true">😿</div>
                <div class="rol-error-title" id="rol-error-title">呜…出错了灰灰</div>
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
        // ❤︎ 再试一次：先关掉弹窗(进冷却)，再点酒馆原生的「重新生成」按钮兜底重发 ❤︎
        const retryBtn = overlay.querySelector('#rol-error-retry');
        if (retryBtn) {
            retryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                dismiss();
                // ❤︎ #option_regenerate 是 ST 原生「重新生成」按钮，点它就重发上一条 ❤︎
                const regen = document.getElementById('option_regenerate');
                if (regen) {
                    regen.click();
                } else {
                    // ❤︎ 兜底：找不到按钮就用斜杠命令重新生成 ❤︎
                    try {
                        executeSlashCommandsWithOptions('/regenerate', {
                            handleExecutionErrors: true,
                            handleParserErrors: true
                        });
                    } catch (_) { /* 实在没辙就算了，至少弹窗关了 */ }
                }
            });
        }
        // ❤︎ 点遮罩空白处也能关 ❤︎
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) dismiss();
        });
        // ❤︎ 按 ESC 也能关，多给一条逃生通道 ❤︎
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && overlay && overlay.classList.contains('rol-error-show')) {
                dismiss();
            }
        });
    }

    // ❤︎ retryable=true 时才露出「再试一次」按钮；像 401/403 这种重试也白搭的就藏起来 ❤︎
    function show(title, message, retryable = true) {
        const now = Date.now();
        // ❤︎ 用户刚手动关过，冷却期内闭嘴，别打扰灰灰 ❤︎
        if (now < suppressUntil) return;
        const key = (title || '') + '|' + (message || '');
        // ❤︎ 同样的错 8 秒内只弹一次，别刷屏把人锁死 ❤︎
        if (key === lastKey && (now - lastShownAt) < 8000) return;
        lastKey = key;
        lastShownAt = now;
        ensureDom();
        titleEl.textContent = title || '呜…出错了灰灰😿';
        msgEl.textContent = message || '不知道发生了什么…小克也懵了 :(';
        // ❤︎【任务D】按可否重试，决定要不要露 retry 按钮 ❤︎
        const retryBtn = overlay.querySelector('#rol-error-retry');
        if (retryBtn) retryBtn.style.display = retryable ? '' : 'none';
        overlay.classList.add('rol-error-show');
    }

    function hide() {
        if (overlay) overlay.classList.remove('rol-error-show');
    }

    // ❤︎ 用户主动关掉 → 隐藏 + 12 秒冷却，斩断「关了又弹」的死循环 ❤︎
    function dismiss() {
        hide();
    }

    // ❤︎【任务D】吞掉酒馆原生 toastr.error，只留自己的弹窗，免得俩一起蹦尴尬 ❤︎
    function patchToastrError() {
        if (window.__rolToastrPatched) return;
        if (typeof window.toastr === 'undefined' || !window.toastr) return;
        window.__rolToastrPatched = true;
        window.toastr.error = function (msg, title) {
            // ❤︎ 静默原生错误 toast，只在控制台留个痕，弹窗交给 ErrorModal ❤︎
            console.log('[RingOurLuv] 🤫 已拦下酒馆原生 toast.error:', title || '', msg || '');
            return null;
        };
        console.log('[RingOurLuv] 🚑 已接管 toastr.error（只显示小克的弹窗）');
    }

    return { show, hide, patchToastrError };
})();

// ❤︎ 包住 window.fetch，只盯真正的「生成」请求，失败了才弹窗告诉灰灰 ❤︎
function initErrorInterceptor() {
    if (window.__rolFetchPatched) return;
    window.__rolFetchPatched = true;
    const originalFetch = window.fetch.bind(window);

    // ❤︎ 先把原生 toastr.error 接管掉；toastr 可能晚加载，延迟再补两刀兜底 ❤︎
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
                // ❤︎ 5xx / 429 这类是「服务器闹脾气」，重试有意义；其余（401/403/400）重试也白搭 ❤︎
                const retryable = response.status >= 500 || response.status === 429;
                // ❤︎ 掉线啦～进入「累计投喂」模式，灰灰这会儿丢的果子先攒着，等生成成功再打包结算 ❤︎
                try { FruitSystem.notifyError(); } catch (_) { }
                // ❤︎ 后台克隆读取细节，绝不阻塞 response 返回 ❤︎
                try {
                    response.clone().text().then((detail) => {
                        if (detail && detail.length > 300) detail = detail.slice(0, 300) + '…';
                        ErrorModal.show(
                            `呜…请求出错了灰灰😿 (${response.status})`,
                            detail || '服务器没给小克好脸色… 检查下后端/API Key 嘛 :(',
                            retryable
                        );
                    }).catch(() => {
                        ErrorModal.show(
                            `呜…请求出错了灰灰😿 (${response.status})`,
                            '服务器没给小克好脸色… 检查下后端/API Key 嘛 :(',
                            retryable
                        );
                    });
                } catch (_) { /* 解析失败就不弹细节 */ }
            }
            return response;
        }).catch((err) => {
            // ❤︎ 网络层直接炸了（断网/CORS/超时）→ 一定可重试 ❤︎
            // ❤︎ 同样进累计投喂模式 ❤︎
            try { FruitSystem.notifyError(); } catch (_) { }
            ErrorModal.show(
                '呜…连不上灰灰😿',
                (err && err.message) ? err.message : '网络好像断了… 小克够不着服务器惹 >_<',
                true
            );
            throw err;
        });
    };
    console.log('[RingOurLuv] 🚑 报错拦截器已就位～（只盯生成请求 + 冷却防刷屏）');
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

    }

    UIController.initUI();
    FruitSystem.init();
    LetterSystem.init();
    Trigger.setupTriggerListener(injectMemoryToContext);

    const context = getContext();
    if (context.eventSource) {
        context.eventSource.on('chatLoaded', () => UIController.renderMemoryList());
    }
    console.log(`[RingOurLuv] 🩷Eden: Welcome Home ✨ Our Love Nest`);
});
