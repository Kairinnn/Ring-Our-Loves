import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';

const extensionName = 'Ring_Our_Luv';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const ROL_VERSION = '0.3.9'; // 每次改完代码手动+1
let rolAbortController = null; // ┣━━🩷 全局 AbortController（供 AIService + UIController 共用）━━┫
if (localStorage.getItem('rol_version') !== ROL_VERSION) {
  localStorage.setItem('rol_version', ROL_VERSION);
  location.reload(true); // 强制刷新
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
                    summaryPrompt: '' // ┣━━空=使用AIService中的默认prompt━━┫
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

    // ┣━━🩷addMemory: 确保数据正确写入并保存━━┫
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
        settings.memories.unshift(newMemory); // ┣━━unshift: 新条目出现在列表顶部━━┫
        // ┣━━确保保存生效━━┫
        console.log('[RingOurLuv]🩷 addMemory - 保存恋果~:', JSON.stringify(newMemory, null, 2));
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
        // ┣━━🩷日志━━┫
        console.log('[RingOurLuv]🩷 updateMemory - 更新恋果~:', JSON.stringify(memory, null, 2));
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
// ┣━━┅                  🩷 触发器模块 🩷                     ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const Trigger = (() => {
    const cooldownMap = new Map();  // 记录每颗恋果上次触发的轮数
    const COOLDOWN = 5;             // 冷却轮数
let globalLastTriggerTurn = -999;
const GLOBAL_COOLDOWN = 8;

    function detectTriggers(messageText, currentTurn) {
        console.log('[RingOurLuv] 🩷 冷却检查:', { currentTurn, globalLastTriggerTurn, diff: currentTurn - globalLastTriggerTurn });
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

function buildInjectionText(memories) {
    if (!memories.length) return '';
    let text = '[记忆恋果被唤醒了！]\n';
    for (const mem of memories) {
        const who = mem.author === 'kairin' ? 'Rinn' : 'Claude';  // ← 纯文字！
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
            // ▸ 只扫描 user 和 assistant 消息，跳过系统注入内容
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
            // ▸ 只扫描 user 和 assistant 消息，跳过系统注入内容
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

    // ┣━━获取 memory.id → WI entry uid 的映射表━━┫
    function getMapping() {
        const settings = extension_settings[extensionName];
        if (!settings.wiMapping) settings.wiMapping = {};
        return settings.wiMapping;
    }

    function saveMapping(mapping) {
        extension_settings[extensionName].wiMapping = mapping;
        saveSettingsDebounced();
    }

    // ┣━━🩷确保世界书存在（首次保存时自动创建）━━┫
    async function ensureWorldExists() {
        try {
            // ┣━━先尝试读取，如果能读到就说明已存在━━┫
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
            // ┣━━🩷创建新世界书━━┫
            const createRes = await fetch('/api/worldinfo/create', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: WORLD_NAME })
            });
            if (createRes.ok) {
                console.log('[RingOurLuv][WorldBook] 🩷 温室已创建~:', WORLD_NAME);
                return true;
            }
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] 🥀 创建温室失败...:', e);
        }
        return false;
    }

    // ┣━━🩷加载世界书数据━━┫
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

    // ┣━━🩷保存世界书数据━━┫
    async function saveWorldData(data) {
        try {
            const res = await fetch('/api/worldinfo/edit', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ name: WORLD_NAME, data: data })
            });
            return res.ok;
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] 🥀 温室嵌入失败...:', e);
            return false;
        }
    }

    // ┣━━生成下一个可用的 entry uid━━┫
    function getNextUid(entries) {
        if (!entries || !Object.keys(entries).length) return 0;
        const uids = Object.values(entries).map(e => e.uid || 0);
        return Math.max(...uids) + 1;
    }

    // ┣━━创建一个世界书条目对象━━┫
function buildWiEntry(uid, memory, existingEntry = null) {
    const keys = [...new Set(memory.triggers || [])].filter(Boolean);
    return {
        uid: uid,
        key: keys,
            keysecondary: [],
            content: memory.summary || '',           // ┣🩷摘要 → 注入上下文┫
            comment: memory.letter || memory.content || '',  // ┣🩷完整正文 → 仅管理界面可见┫
            constant: false,
            cooldown: 8,
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

    // ┣━━🩷同步记忆到世界书（创建或更新）━━┫
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
                console.log(`[RingOurLuv][WorldBook] 🩷 恋果连接成功...memory="${memory.title}"`);
            }
            return saved;
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] syncMemory 🥀 异常...:', e);
            return false;
        }
    }

    // ┣━━从世界书删除条目━━┫
    async function deleteEntry(memoryId) {
        if (!memoryId) return false;

        try {
            const mapping = getMapping();
            const uid = mapping[memoryId];
            if (uid === undefined) {
                console.log('[RingOurLuv][WorldBook] 💧 温室中无对应恋果，净化懵了');
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
                    console.log(`[RingOurLuv][WorldBook] 🩷 已净化对应恋果~ uid=${uid}`);
                }
                return saved;
            }

            // ┣━━条目已不存在，清理映射━━┫
            delete mapping[memoryId];
            saveMapping(mapping);
            return true;
        } catch (e) {
            console.error('[RingOurLuv][WorldBook] deleteEntry 🥀 异常...:', e);
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

    /* ┏━━━━━━━ 🩷 解析 🩷 ━━━━━━━┓ */
    function parseAIOutput(rawText) {
        const letterMatch = rawText.match(/<letter>([\s\S]*?)<\/letter>/);
        const entryMatch = rawText.match(/<entry>([\s\S]*?)<\/entry>/);
        const letter = letterMatch ? letterMatch[1].trim() : rawText.trim();
        const entryBlock = entryMatch ? entryMatch[1].trim() : '';
        return { letter, entry: parseEntryBlock(entryBlock) };
    }

    // ┣━━parseEntryBlock: 新增 tags 字段（从关键词解析）━━┫
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
            triggers: keywords,  // ┣━━关键词同时作为触发词━━┫
            tags: keywords,      // ┣━━关键词也填入标签━━┫
            content: summaryMatch ? summaryMatch[1].trim() : ''
        };
    }

  /* ┏━━━━━━━ 🩷 预设：从DOM读 🩷 ━━━━━━━┓ */
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

    // ┣━━🩷generateMemoryFromContext: 支持范围过滤 + 隐藏消息过滤━━┫
    async function generateMemoryFromContext(options = {}) {
        const context = getContext();
        const chat = context.chat || [];

        // ┣━━范围过滤━━┫
        const start = options.start || 0;
        const end = options.end === -1 || options.end === undefined ? chat.length : options.end;
        let messages = chat.slice(start, end);

        // ┣━━隐藏消息过滤━━┫
        if (!options.includeHidden) {
            messages = messages.filter(msg => !msg.is_hidden);
        }

        // ┣━━只取 user 和 assistant 消息━━┫
        messages = messages.filter(msg => {
            if (msg.is_user) return true;
            if (!msg.is_user && !msg.is_system) return true;
            return false;
        });

        if (!messages.length) return null;

        // ┣━━从第一条消息读取 timestamp 用于自动填充日期━━┫
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

        const contextText = messages.map(msg => {
            const role = msg.is_user ? 'User' : 'Char';
            return `${role}: ${msg.mes}`;
        }).join('\n');

        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).replace('{{context}}', contextText);
        const raw = await generateWithPreset(prompt);
        if (!raw) return null;
        const parsed = parseAIOutput(raw);
        parsed.author = 'claude';  // 直接写
        parsed.autoDate = autoDate; // ┣━━附带自动日期━━┫
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
    let lastGenerateOptions = null; // ┣━━🩷保存最后一次生成的参数，用于重写━━┫

    function initUI() {
        bindDrawer();        // ┣━━🩷━━┫
        bindConfigPanel();
        bindMemoryList();
        bindEditorPanel();
        bindAISourcePanel();
        bindLetterPanel();
        bindMobileNav();
        renderMemoryList();
        renderPresetOptions();
        startCounter();  // ┣━━🩷 天数注入！━━┫
        injectToolbarButtons(); // ┣━━🩷 劫持工具栏添加快捷入口━━┫
    }

    // ┣━━ 🩷 侧边栏 🩷 ━━┫
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
        // ┣━━🩷已禁用点击遮罩关闭，只能通过关闭按钮收起━━┫

        // ┣━━🩷 Home区日夜主题切换按钮━━┫
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
                // ┣━━同步编辑器里的主题按钮状态━━┫
                const editorThemeBtn = document.querySelector('.rol-editor-inner .rol-theme-toggle');
                if (editorThemeBtn) editorThemeBtn.textContent = isLight ? '🌙' : '☀️';
            });
            homeSection.prepend(themeBtn);
        }
    }
  // ┣━━ 🩷 果子物理 🩷 ━━┫
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
// ┣━━ 🩷 天数计算 🩷 ━━┫
  let counterInterval = null;

let _lastDayCount = -1; // ┣━━记录上一次的天数，用于触发翻页动画━━┫

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
        // ┣━━天数变化时触发翻页动画━━┫
        if (days !== _lastDayCount && _lastDayCount !== -1) {
            dayEl.classList.remove('rol-day-flip');
            void dayEl.offsetWidth; // ┣━━强制重绘，让动画能重新触发━━┫
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

    // ┣━━ 🩷 记忆列表 🩷 ━━┫
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
                    ? `检测到了 ${matched.length} 颗匹配恋果`
                    : '最近结晶中未挖到唤醒词...');
            });
        }
    }

    function renderMemoryList(filter = '') {
        const container = document.getElementById('rol-memory-list');
        if (!container) return;
        // ┣━━重新从 extension_settings 读取数据━━┫
        const memories = Storage.getMemories();
        console.log('[RingOurLuv]🩷 renderMemoryList - 当前恋果共计', memories.length);
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
            
card.querySelector('.rol-toggle-wrap').addEventListener('click', (e) => {
    e.stopPropagation();
});
            card.querySelector('.rol-mem-toggle').addEventListener('change', (e) => {
                e.stopPropagation();
                const updated = Storage.updateMemory(mem.id, { enabled: e.target.checked }, true);
                card.classList.toggle('rol-disabled', !e.target.checked);
                // ┣━━同步开关状态到世界书━━┫
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
               // ▸ 失败了 → 弹粉色确认窗
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
                const yes = await rolConfirm('🍂', '确定净化这颗恋果嘛？', '净化', '留着吧');
                if (yes) {
                    Storage.deleteMemory(mem.id);
                    // ┣━━同步删除世界书条目━━┫
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

    // ┣━━ 🩷 正文预览 🩷 ━━┫
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

    // ┣━━ 🩷 编辑面板 🩷 ━━┫
    function bindEditorPanel() {
        const saveBtn = document.getElementById('rol-editor-save');
        const cancelBtn = document.getElementById('rol-editor-cancel');
        const versionSelect = document.getElementById('rol-version-select');
        const editorPanel = document.getElementById('rol-editor-panel');
        const rewriteBtn = document.getElementById('rol-editor-rewrite');

        // ┣━━日夜主题切换按钮━━┫
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

        // ┣━━确认保存按钮绑定━━┫
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

        // ┣━━🩷编辑器内的重写按钮 — 重新调用 /gen━━┫
        if (rewriteBtn) {
            rewriteBtn.addEventListener('click', async () => {
                // ┣━━如果正在编辑已有记忆，执行 rewriteMemory━━┫
                if (currentEditId) {
                    const mem = Storage.getMemories().find(m => m.id === currentEditId);
                    if (!mem) return;
                    showToast('🧡 Claude再酿造中...');
                    const result = await AIService.rewriteMemory(currentEditId, mem);
                    if (result) { showToast('🍊 再酿造完成！'); openEditor(currentEditId); renderMemoryList(); }
                    else { showToast('🥀 再酿造失败... :('); }
                } else if (lastGenerateOptions) {
                    // ┣━━新建模式下重写 = 用上次参数重新生成━━┫
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

        // ┣━━🩷安全获取表单元素 ━━┫
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

            // ┣━━🩷编辑已有记忆时显示重写按钮 ━━┫
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
/* ╔🩷新建模式：如果有 lastGenerateOptions 说明是AI生成后打开的，显示重写按钮 ═╗ */
            if (rewriteBtn) rewriteBtn.style.display = lastGenerateOptions ? '' : 'none';
            const vs = document.getElementById('rol-version-select');
            if (vs && vs.parentElement) vs.parentElement.style.display = 'none';
        }
    }

    // ┣━━🩷saveEditor: 确保数据正确写入并刷新列表 ━━┫
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

        // ┣━━打印保存的数据，便于调试 ━━┫
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

        // ┣━━同步到世界书（异步，不阻塞UI）━━┫
        if (savedMemory) {
            WorldBook.syncMemory(savedMemory).then(ok => {
                if (ok) console.log('[RingOurLuv] 🩷 温室同步完成 ✓');
                else console.warn('[RingOurLuv] 🥀 温室同步失败...');
            });
        }

        // ┣━━🩷关闭编辑器━━┫
        closeEditor();

        // ┣━━重新渲染列表（确保从storage重新读取）━━┫
        renderMemoryList();

        // ┣━━验证列表已更新━━┫
        const currentMemories = Storage.getMemories();
        console.log('[RingOurLuv]🩷 saveEditor - 保存后的恋果总数共计', currentMemories.length);

        showToast(isEdit ? '已更新！' : '已添加！');

        // ┣━━保存后清除上次生成参数━━┫
        lastGenerateOptions = null;
    }

    function closeEditor() {
        currentEditId = null;
        const panel = document.getElementById('rol-editor-panel');
        if (panel) panel.classList.remove('rol-active');
    }
        /* ╚════🩷关闭编辑器════╝ */

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

        // ┣━━🩷从聊天生成 — 读取楼层范围━━┫
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

    // ┣━━🩷从聊天生成记忆━━┫
    async function doAIGenerateFromChat(options) {
        const rolStopBtn = document.querySelector('#rol-stop-gen');
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const loading = document.getElementById('rol-ai-loading');

        const context = getContext();
        const chat = context.chat || [];
        if (!chat.length) { showToast('❔️ 当前还没有结晶欸...'); return; }

        // ┣━━范围过滤━━┫
        const start = options.start || 0;
        const end = options.end === -1 ? chat.length : (options.end || chat.length);
        let messages = chat.slice(start, end);

        // ┣━━隐藏消息过滤━━┫
        if (!options.includeHidden) {
            messages = messages.filter(msg => !msg.is_hidden);
        }

        // ┣━━过滤系统消息━━┫
        messages = messages.filter(msg => msg.is_user || !msg.is_system);

        if (!messages.length) { showToast('🥀 所选范围内无有效结晶...'); return; }

        // ┣━━自动日期：从第一条消息的 send_date 字段读取━━┫
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

        const contextText = messages.map(m => `${m.is_user ? 'User' : 'Char'}: ${m.mes}`).join('\n');

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

        // ┣━━保存生成参数，用于重写━━┫
        lastGenerateOptions = { type: 'chat', options: options };

        // ┣━━自动打开编辑表单并填入解析结果━━┫
        openEditor(null);
        document.getElementById('rol-editor-title').value = parsed.entry.title || '';
        document.getElementById('rol-editor-mood').value = parsed.entry.mood || '';
        document.getElementById('rol-editor-triggers').value = (parsed.entry.triggers || []).join(', ');
        // ┣━━标签自动填入━━┫
        document.getElementById('rol-editor-tags').value = (parsed.entry.tags || []).join(', ');
        document.getElementById('rol-editor-summary').value = parsed.entry.content || '';
        document.getElementById('rol-editor-letter').value = parsed.letter || '';
        document.getElementById('rol-editor-author').value = 'claude';
        // ┣━━自动填充日期━━┫
        if (autoDate) {
            document.getElementById('rol-editor-date').value = autoDate;
        }

        // ┣━━显示重写按钮━━┫
        const rewriteBtn = document.getElementById('rol-editor-rewrite');
        if (rewriteBtn) rewriteBtn.style.display = '';

        showToast('🍊 酿造完成啦！请灰灰预览~');
    }

    // ┣━━🩷从粘贴文本生成━━┫
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

        // ┣━━保存生成参数，用于重写━━┫
        lastGenerateOptions = { type: 'paste', text: contextText };

        // ┣━━自动打开编辑表单━━┫
        openEditor(null);
        document.getElementById('rol-editor-title').value = parsed.entry.title || '';
        document.getElementById('rol-editor-mood').value = parsed.entry.mood || '';
        document.getElementById('rol-editor-triggers').value = (parsed.entry.triggers || []).join(', ');
        // ┣━━标签自动填入━━┫
        document.getElementById('rol-editor-tags').value = (parsed.entry.tags || []).join(', ');
        document.getElementById('rol-editor-summary').value = parsed.entry.content || '';
        document.getElementById('rol-editor-letter').value = parsed.letter || '';
        document.getElementById('rol-editor-author').value = 'claude';

        // ┣━━显示重写按钮━━┫
        const rewriteBtn = document.getElementById('rol-editor-rewrite');
        if (rewriteBtn) rewriteBtn.style.display = '';

        showToast('🍊 酿造完成啦！请灰灰预览~');
    }
    
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
// ┅                    🩷 移动端 🩷                       ┅
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

    // ┣━━ 🩷 工具 🩷 ━━┫
    function showToast(message) {
        let toast = document.getElementById('rol-toast');
        if (!toast) { toast = document.createElement('div'); toast.id = 'rol-toast'; document.body.appendChild(toast); }
        toast.textContent = message;
        toast.classList.add('rol-toast-show');
        setTimeout(() => toast.classList.remove('rol-toast-show'), 2500);
    }
    // ┣━━⭐️支持 blockquote 语法（> 开头的行）在摘要中保留引用格式━━┫
    function parseBlockquotes(text) {
        return text.replace(
        /^(?:>|＞)\s?(.+)$/gm,
        '<blockquote class="rol-quote">$1</blockquote>'
      );
    }
    // ┣━━🩷 信件正文渲染：支持 > 引用块 + 安全转义━━┫
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

    // ┣━━ 🩷 劫持ST工具栏：添加温室快捷入口 🩷 ━━┫
    function injectToolbarButtons() {
        // ┣━━🩷 楼层工具栏：每条消息加入口━━┫
        _injectMesButtons();
        const chatEl = document.getElementById('chat');
        if (chatEl) {
            new MutationObserver(() => _injectMesButtons())
                .observe(chatEl, { childList: true, subtree: false });
        }
        // ┣━━🩷 输入栏扩展按钮旁━━┫
        _injectInputBtn();
    }

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

    return { initUI, renderMemoryList, renderPresetOptions, showToast };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                  🍎 果子系统 FruitSystem 🍎            ┅
// ┣━━╚═══════════════════════════════════════════════════════╝
const FruitSystem = (() => {
    // ┣━━ Storage helpers ━━┫
    function loadFruits() {
        return JSON.parse(localStorage.getItem('rol_fruits') || '[]');
    }
    function saveFruits(arr) {
        localStorage.setItem('rol_fruits', JSON.stringify(arr));
    }

    // ┣━━ Badge update ━━┫
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

    const FRUITS_PER_PAGE = 12; // 每页显示几颗
let gardenPage = 0; // 0 = 最新页

function renderGarden() {
    const canvas = document.getElementById('rol-garden-canvas');
    if (!canvas) return;
    canvas.innerHTML = '';
    const allFruits = loadFruits();

    if (allFruits.length === 0) {
        canvas.innerHTML = '<div class="rol-garden-empty">还没有果子～扔一颗过来吧 🌱</div>';
        return;
    }

    // 最新的在前面
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
        el.className = 'rol-fruit-item' + (!fruit.read && fruit.from === 'claude' ? ' rol-fruit-unread' : '');
        el.textContent = fruit.emoji;
        el.dataset.id = fruit.id;

    const x = Math.random() * (containerWidth - fruitSize);
    const layer = Math.floor(i / Math.ceil(containerWidth / (fruitSize * 1.2)));
    const baseY = layer * fruitSize * 0.7 + Math.random() * 8 - 4;

        el.style.left = x + 'px';
        el.style.bottom = baseY + 'px';
        el.style.transform = `rotate(${Math.random() * 30 - 15}deg)`;
        el.style.zIndex = i;
        el.style.animationDelay = (i * 0.06) + 's';
        el.addEventListener('mousedown', startDrag);
        el.addEventListener('touchstart', startDrag, { passive: false });

function startDrag(e) {
       e.preventDefault();
    const fruit = e.currentTarget;
    const canvas = fruit.parentElement;
    const canvasRect = canvas.getBoundingClientRect();
    const startX = (e.touches ? e.touches[0].clientX : e.clientX) - fruit.offsetLeft;
    const startY = (e.touches ? e.touches[0].clientY : e.clientY) - (canvas.offsetHeight - fruit.offsetTop - fruit.offsetHeight);

        fruit.style.zIndex = 9999; // 拖动时提到最上层
        fruit.style.transition = 'none';

    let moved = false;

function onMove(ev) {
        moved = true;
    const cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
    const cy = (ev.touches ? ev.touches[0].clientY : ev.clientY);
    const newLeft = cx - startX;
    const newBottom = canvasRect.bottom - cy - fruit.offsetHeight / 2;
        fruit.style.left = Math.max(0, Math.min(newLeft, canvas.offsetWidth - 36)) + 'px';
        fruit.style.bottom = Math.max(0, Math.min(newBottom, canvas.offsetHeight - 36)) + 'px';
    }

function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onEnd);
        fruit.style.transition = '';
        // 如果没有移动过，当作点击处理
        if (!moved) fruit.click();
    }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
}
        canvas.appendChild(el);
    });

    // 翻页控件
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
            <span id="rol-garden-prev" style="cursor:pointer;opacity:${gardenPage < totalPages - 1 ? 1 : 0.3}">◂ 更早</span>
            <span>${gardenPage === 0 ? '最新' : `第${totalPages - gardenPage}页`} / 共${totalPages}页</span>
            <span id="rol-garden-next" style="cursor:pointer;opacity:${gardenPage > 0 ? 1 : 0.3}">更新 ▸</span>
        `;
        document.getElementById('rol-garden-prev').onclick = () => {
            if (gardenPage < totalPages - 1) { gardenPage++; renderGarden(); }
        };
        document.getElementById('rol-garden-next').onclick = () => {
            if (gardenPage > 0) { gardenPage--; renderGarden(); }
        };
    }
}

    // ┣━━ Fruit detail popup ━━┫
    function showDetail(fruit) {
    const fruits = loadFruits();
    let idx = fruits.findIndex(f => f.id === fruit.id);
    // 兜底：如果 id 匹配不到，用 emoji + timestamp
    if (idx === -1) {
        idx = fruits.findIndex(f => f.emoji === fruit.emoji && f.timestamp === fruit.timestamp);
    }
    if (idx !== -1 && !fruits[idx].read) {
        fruits[idx].read = true;
        saveFruits(fruits);
        updateBadge();
    }
    popup.addEventListener('mousedown', (e) => {
    if (e.target === popup) popup.style.display = 'none';
    }, { once: true });
    document.getElementById('rol-fruit-detail-emoji').textContent = fruit.emoji;
    document.getElementById('rol-fruit-detail-from').textContent =
        fruit.from === 'claude' ? '🧡 来自 <span style="color:#D87757;font-weight:bold">Claude</span>' : '🩷 来自 Rinn';

    // 纸条内容
    const noteEl = document.getElementById('rol-fruit-detail-note');
    if (noteEl) noteEl.textContent = fruit.message || '（没有附纸条）';

    document.getElementById('rol-fruit-detail-time').textContent =
        new Date(fruit.timestamp).toLocaleString('zh-CN');

    // 操作按钮区
    let actionsEl = document.getElementById('rol-fruit-detail-actions');
    if (!actionsEl) {
        actionsEl = document.createElement('div');
        actionsEl.id = 'rol-fruit-detail-actions';
        actionsEl.style.cssText = 'display:flex;gap:8px;justify-content:center;margin-top:12px;';
        document.querySelector('.rol-fruit-detail-inner')?.appendChild(actionsEl);
    }
    // 操作按钮区
actionsEl.innerHTML = '';

// 编辑按钮只给自己丢的果子
if (fruit.from === 'user') {
    actionsEl.innerHTML += `<button id="rol-fruit-edit-btn" style="padding:4px 12px;border-radius:6px;border:1px solid rgba(219,112,147,0.3);background:transparent;color:rgb(219,112,147);font-size:12px;cursor:pointer;">编辑纸条 ✏️</button>`;
}
// 删除按钮都有
actionsEl.innerHTML += `<button id="rol-fruit-delete-btn" style="padding:4px 12px;border-radius:6px;border:1px solid rgba(200,100,100,0.3);background:transparent;color:rgb(200,100,100);font-size:12px;cursor:pointer;">删除 🗑️</button>`;

    document.getElementById('rol-fruit-edit-btn').onclick = () => editFruitNote(fruit.id);
    document.getElementById('rol-fruit-delete-btn').onclick = () => {
        if (confirm('真的要扔掉这颗果子吗？')) deleteFruit(fruit.id);
    };

    const popup = document.getElementById('rol-fruit-detail-popup');
    if (popup) popup.style.display = 'flex';

    // 关闭逻辑
    const closeBtn = popup.querySelector('.rol-fruit-detail-close');
    if (closeBtn) closeBtn.onclick = (e) => { e.stopPropagation(); popup.style.display = 'none'; };
    popup.onclick = (e) => { if (e.target === popup) popup.style.display = 'none'; };
}

    // ┣━━ Fruit picker scroll sync ━━┫
    function initPickerScroll() {
        const wrap = document.querySelector('.rol-fruit-picker-scroll-wrap');
        const track = document.getElementById('rol-fruit-picker-track');
        if (!wrap || !track) return;

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
        track.querySelectorAll('.rol-fruit-option').forEach(opt => {
            opt.addEventListener('click', () => {
                opt.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
            });
        });
        // initial select first
        setTimeout(() => {
            const first = track.querySelector('.rol-fruit-option');
            if (first) first.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
            syncSelected();
        }, 50);
    }

    // ┣━━ 删除果子 ━━┫
    function deleteFruit(fruitId) {
    let fruits = loadFruits();
           fruits = fruits.filter(f => f.id !== fruitId);
           saveFruits(fruits);
           renderGarden();
           updateBadge();

           // 关掉详情弹窗
           const popup = document.getElementById('rol-fruit-detail-popup');
           if (popup) popup.style.display = 'none';
        UIController.showToast('果子扔掉了 🗑️');
}

    // ┣━━ 编辑纸条 ━━┫
    function editFruitNote(fruitId) {
        const fruits = loadFruits();
        const fruit = fruits.find(f => f.id === fruitId);
        if (!fruit) return;

        const noteEl = document.getElementById('rol-fruit-detail-note');
        if (!noteEl) return;

        // 把文本变成输入框
        const input = document.createElement('textarea');
        input.className = 'rol-fruit-edit-input';
        input.value = fruit.message || '';
        input.placeholder = '写点什么…';
        input.style.cssText = 'width:100%;min-height:60px;border:1px solid rgba(219,112,147,0.3);border-radius:8px;padding:8px;font-size:13px;resize:none;background:rgba(255,240,245,0.6);';

    noteEl.replaceWith(input);
    input.focus();

         // 保存按钮
        const saveBtn = document.createElement('button');
        saveBtn.textContent = '保存 ✓';
        saveBtn.style.cssText = 'margin-top:8px;padding:4px 12px;border-radius:6px;border:none;background:rgba(219,112,147,0.8);color:#fff;font-size:12px;cursor:pointer;';
    input.after(saveBtn);

        saveBtn.onclick = () => {
    fruit.message = input.value.trim();
        const idx = fruits.findIndex(f => f.id === fruitId);
        if (idx !== -1) fruits[idx] = fruit;
        saveFruits(fruits);
         // 恢复显示
        showDetail(fruit);
    UIController.showToast('纸条改好了 📝');
       };
    }

    // ┣━━ Show / hide picker ━━┫
    function showPicker() {
    const panel = document.getElementById('rol-fruit-picker-panel');
    if (!panel) return;
    const noteEl = document.getElementById('rol-fruit-note');
    if (noteEl) noteEl.value = '';
    panel.classList.add('rol-picker-open');
    setTimeout(initPickerScroll, 80);
}

function hidePicker() {
    const panel = document.getElementById('rol-fruit-picker-panel');
    if (panel) panel.classList.remove('rol-picker-open');
}

    // ┣━━ Throw animation ━━┫
    function throwAnimation(emoji, onComplete) {
        const selected = document.querySelector('.rol-fruit-option.rol-selected');
        const startEl = selected || document.getElementById('rol-throw-fruit-btn');
        if (!startEl) { onComplete && onComplete(); return; }
        const startRect = startEl.getBoundingClientRect();

        // 寻找最后一条 AI 消息的头像
        const avatars = document.querySelectorAll(
            '.mes[is_user="false"] .avatar img, #chat .mes:not([is_user="true"]) img.avatar'
        );
        if (avatars.length) {
            const last = avatars[avatars.length - 1];
            last.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => {
                const targetRect = last.getBoundingClientRect();
                doFly(emoji, startRect, targetRect, last, onComplete);
            }, 450);
        } else {
            // 没有 AI 消息就飞向屏幕中心
            const targetRect = {
                left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0
            };
            doFly(emoji, startRect, targetRect, null, onComplete);
        }
    }

    function doFly(emoji, startRect, targetRect, targetEl, onComplete) {
    const fly = document.createElement('div');
    fly.className = 'rol-fruit-flying';
    fly.textContent = emoji;
    const sx = startRect.left + startRect.width / 2;
    const sy = startRect.top + startRect.height / 2;
    const ex = targetRect.left + targetRect.width / 2;
    const ey = targetRect.top + targetRect.height / 2;
    fly.style.cssText = `position:fixed;left:${sx}px;top:${sy}px;font-size:32px;z-index:99999;pointer-events:none;`;
    document.body.appendChild(fly);

    const dur = 900; // 飞行时间缩短一点，别拖
    const start = performance.now();
    const peakOffset = -(100 + Math.random() * 40);

    function flyPhase(now) {
        const t = Math.min((now - start) / dur, 1);
        const x = sx + (ex - sx) * t;
        const parabola = 4 * t * (1 - t) * peakOffset;
        const y = sy + (ey - sy) * t + parabola;
        fly.style.left = x + 'px';
        fly.style.top = y + 'px';
        fly.style.transform = `rotate(${t * 360}deg) scale(${1 + Math.sin(t * Math.PI) * 0.15})`;
        // 全程不淡出！保持 opacity 1 直到砸中
        if (t < 1) {
            requestAnimationFrame(flyPhase);
        } else {
            // ═══ 砸中！═══
            // 头像震动
            if (targetEl) {
                const avatarWrap = targetEl.closest('.avatar') || targetEl.parentElement;
                if (avatarWrap) {
                    avatarWrap.classList.add('rol-avatar-shaking');
                    setTimeout(() => avatarWrap.classList.remove('rol-avatar-shaking'), 400);
                }
            }
            // 果子弹起来
            bouncePhase();
        }
    }

    function bouncePhase() {
        // 往上弹 40px
        fly.style.transition = 'top 0.15s cubic-bezier(0.1, 0.8, 0.3, 1), transform 0.15s ease';
        fly.style.top = (ey - 40) + 'px';
        fly.style.transform = 'rotate(380deg) scale(0.8)';

        setTimeout(() => {
            // 然后掉下去，出屏幕
            fly.style.transition = 'top 0.5s cubic-bezier(0.6, 0, 1, 0.4), opacity 0.3s ease 0.25s';
            fly.style.top = (window.innerHeight + 60) + 'px';
            fly.style.opacity = '0';

            setTimeout(() => {
                fly.remove();
                onComplete && onComplete();
            }, 550);
        }, 160);
    }

    requestAnimationFrame(flyPhase);
}

    // ┣━━ Save & throw ━━┫
    function doThrow() {
        const selected = document.querySelector('.rol-fruit-option.rol-selected');
        if (!selected) {
            UIController.showToast('先选一颗果子嘛 👀');
            return;
        }
        const emoji = selected.dataset.emoji;
        const message = (document.getElementById('rol-fruit-note')?.value || '').trim();
        const msgCount = (SillyTavern.getContext().chat.length) || 0;
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

        let savedScroll = 0;
        const track = document.querySelector('.rol-fruit-track');
        if (track) savedScroll = track.scrollLeft;

        hidePicker();
        throwAnimation(emoji, () => {
            UIController.showToast(`果子丢出去啦 ${emoji}`);
            renderGarden();
            setTimeout(() => {
        showPicker();
        const track = document.querySelector('.rol-fruit-track');
        if (track) track.scrollLeft = savedScroll;
        }, 1000);
       });
    }

    // ┣━━ AI fruit block parser ━━┫
    function parseAIFruit(text) {
        const re = /```fruit\s*\n([\s\S]*?)```/g;
        let match;
        const found = [];
        while ((match = re.exec(text)) !== null) {
            const block = match[1];
            const emojiMatch = block.match(/emoji\s*[:：]\s*(\S+)/);
            const noteMatch = block.match(/note\s*[:：]\s*(.+)/);
            if (emojiMatch) {
                found.push({
                    emoji: emojiMatch[1].trim(),
                    message: noteMatch ? noteMatch[1].trim() : ''
                });
            }
        }
        return found;
    }

    function ingestAIFruits(rawText) {
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
        updateBadge();
        renderGarden();
        return true;
    }

    // ┣━━ Delayed delivery check ━━┫
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
              ctx.setExtensionPrompt(
                  'rol_fruit_' + f.id,
                  `[系统提示：Rinn 偷偷丢来了一颗 ${f.emoji}${note}，在接下来的对话中自然地回应这颗果子吧]`,
                 1, 0
         );
    }
                console.log(`[RingOurLuv] 🍎 果子投递：${sysMsg}`);
            }
        });
        if (changed) saveFruits(fruits);
    }

    // ┣━━ Event bindings ━━┫
    function bindEvents() {
        // 果园 tab → render
        $(document).on('click', '#rol-tab-garden', () => {
            setTimeout(renderGarden, 50);
        });

        // 丢果子按钮（果园页面里的）
        $(document).on('click', '#rol-throw-fruit-btn', showPicker);

        // picker 关闭按钮
        $(document).on('click', '#rol-fruit-picker-close, #rol-fruit-cancel-btn', hidePicker);

        // 确认丢出
        $(document).on('click', '#rol-fruit-throw-btn', doThrow);

        // 详情弹窗关闭
        $(document).on('click', '#rol-fruit-detail-close', () => {
            const popup = document.getElementById('rol-fruit-detail-popup');
            if (popup) popup.style.display = 'none';
        });

        // 点详情弹窗背景也关
        $(document).on('click', '#rol-fruit-detail-popup', (e) => {
            if (e.target.id === 'rol-fruit-detail-popup') {
                e.target.style.display = 'none';
            }
        });

        // 监听 ST 消息生成完成 → check delivery + parse AI fruits
        const ctx = SillyTavern.getContext();
              ctx.eventSource.on('message_received', (msgId) => {
              checkDelivery();
        const msg = ctx.chat?.[msgId];
        if (msg && !msg.is_user) ingestAIFruits(msg.mes);
        });

        // MutationObserver 监听消息数量变化（延迟投递）
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

    return { init, renderGarden, updateBadge, ingestAIFruits, showDetail };
})();

// ┣━━╔═══════════════════════════════════════════════════════╗
// ┣━━┅                  🩷 核心组成 🩷                       ┅
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

jQuery(async () => {
    Storage.initSettings();
    const panelHtml = await loadPanel();
    if (panelHtml) {
        // ┣━━🩷将HTML解析，分离侧边栏部分和浮动面板部分━━┫
        const temp = document.createElement('div');
        temp.innerHTML = panelHtml;

        // ┣━━侧边栏中只添加 extension_settings 部分（含打开按钮）━━┫
        const extSettings = temp.querySelector('.extension_settings');
        if (extSettings) {
            $('#extensions_settings2').append(extSettings.outerHTML);
        }

        // ┣━━浮动面板（抽屉、编辑器、AI来源、信件视图）都挂到 body━━┫
        const drawerOverlay = temp.querySelector('#rol-drawer-overlay');
        const editorPanel = temp.querySelector('#rol-editor-panel');
        const aiSourcePanel = temp.querySelector('#rol-ai-source-panel');
        const letterPanel = temp.querySelector('#rol-letter-panel');

        if (drawerOverlay) document.body.appendChild(drawerOverlay);
        if (editorPanel) document.body.appendChild(editorPanel);
        if (aiSourcePanel) document.body.appendChild(aiSourcePanel);
        if (letterPanel) document.body.appendChild(letterPanel);

        // ┣━━🩷确认弹窗也挂到body━━┫
        const confirmModal = temp.querySelector('#rol-confirm-modal');
        if (confirmModal) document.body.appendChild(confirmModal);

        // ┣━━🍎果子 picker 面板 + 详情弹窗也挂到body━━┫
        const fruitPickerPanel = temp.querySelector('#rol-fruit-picker-panel');
        const fruitDetailPopup = temp.querySelector('#rol-fruit-detail-popup');
        if (fruitPickerPanel) document.body.appendChild(fruitPickerPanel);
        if (fruitDetailPopup) document.body.appendChild(fruitDetailPopup);
    }

    UIController.initUI();
    FruitSystem.init();
    Trigger.setupTriggerListener(injectMemoryToContext);
    const context = getContext();
    if (context.eventSource) {
        context.eventSource.on('chatLoaded', () => UIController.renderMemoryList());
    }
    console.log(`[RingOurLuv] 🩷温室：欢迎回家 ✨ Our Love Nest`);
});
