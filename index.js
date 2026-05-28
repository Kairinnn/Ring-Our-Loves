import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';

const extensionName = 'Ring_Our_Luv';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const ROL_VERSION = '0.2.1'; // 每次改完代码手动+1
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

    function detectTriggers(messageText, currentTurn) {
        const memories = Storage.getMemories();
        const matched = [];
        for (const memory of memories) {
            if (!memory.enabled) continue;

            // ▸ 🩷冷却检查
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
                    cooldownMap.set(memory.id, currentTurn);  // ▸ 🩷记录触发轮数
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
            const matched = detectTriggers(chat[msgIndex].mes, msgIndex);
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

        try {
            if (targetPreset) {
                originalPreset = getCurrentPresetName();
                console.log(`[RingOurLuv] 🍰 切换配方: ${originalPreset} → ${targetPreset}`);
                await switchPreset(targetPreset);
            }

            const result = await executeSlashCommandsWithOptions('/gen ' + prompt, {
                handleExecutionErrors: true,
                handleParserErrors: true
            });

            return result?.pipe || '';
        } catch (e) {
            console.error('[RingOurLuv] 🥀 酿造失败...:', e);
            return '';
        } finally {
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
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).        replace('{{context}}', contextText);
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
        updateDayCounter();  // ┣━━🩷 天数注入！━━┫
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
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                // ┣━━🩷点击遮罩层（面板之外）关闭━━┫
                if (e.target === overlay) {
                    overlay.classList.remove('rol-drawer-open');
                }
            });
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
    el.style.top = `${Math.random() * 80}%`;
    el.style.animationDelay = `${i * 0.08 + Math.random() * 0.3}s`;
    el.style.transform = `rotate(${(Math.random() - 0.5) * 20}deg)`;

    el.addEventListener('click', () => showFruitDetail(fruit));
    garden.appendChild(el);
  });
}
// ┣━━ 🩷 天数计算 🩷 ━━┫
  function updateDayCounter() {
  const startDate = new Date('2026-04-14T00:17:00+08:00'); // 起始日
  const today = new Date();
  const diff = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
  const counter = document.querySelector('.rol-day-number');
  if (counter) counter.textContent = diff;
}

    // ┣━━ 🩷 设置面板 🩷 ━━┫
    function updateDayCount() {
        const start = new Date('2026-04-14T00:17:00+08:00');
        const now = new Date();
        const days = Math.floor((now - start) / 86400000);
        const el = document.getElementById('rol-day-count');
        if (el) el.textContent = days;
    }

    function bindConfigPanel() {
        const config = Storage.getConfig();
        const autoInjectToggle = document.getElementById('rol-auto-inject');
        const maxCountInput = document.getElementById('rol-max-count');
        const presetSelect = document.getElementById('rol-preset-select');
        const summaryPromptArea = document.getElementById('rol-summary-prompt');

        updateDayCount();

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
            const authorClass = mem.author === 'kairin' ? 'rol-author-kairin' : 'rol-author-claude';
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
                    <button class="rol-btn-rewrite" title="让Claude重写">🧡</button>
                    <button class="rol-btn-delete" title="净化">🍃</button>
                </div>
            `;
            
card.querySelector('.rol-mem-toggle').addEventListener('click', (e) => {
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

            card.querySelector('.rol-btn-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('🍂确定净化这颗恋果嘛？')) {
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
                    document.getElementById('rol-letter-body').textContent =
                        mem.versions[idx].letter || '（❔️ 此恋果好像没有被注入欸~）';
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
        document.getElementById('rol-letter-body').textContent = mem.letter || mem.content || '（无内容）';
        const moodEl = document.getElementById('rol-letter-mood');
        if (moodEl) moodEl.textContent = mem.mood || '';

        const vs = document.getElementById('rol-letter-version');
        if (vs) {
            vs.innerHTML = '';
            const typeLabels = { original: '原始', manual_edit: '🩷 传入爱意', ai_rewrite: '🧡 让Claude重写' };
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
        if (!panel) { console.error('[RingOurLuv] 🥀 找不到传入面板 #rol-editor-panel'); return; }
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
                const typeLabels = { original: '原始', manual_edit: '🩷 传入爱意', ai_rewrite: '🧡 让Claude重写' };
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
              const stStop = document.querySelector('#mes_stop');
  if (stStop && !stStop.disabled) stStop.click();
  if (typeof stopGeneration === 'function') stopGeneration();
  if (typeof abortController !== 'undefined' && abortController) {
    abortController.abort();
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

        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).        replace('{{context}}', contextText);
        const raw = await AIService.generateWithPreset(prompt);
        if (loading) loading.style.display = 'none';
        if (rolStopBtn) rolStopBtn.style.display = 'none';
        // ┣━━if (sourcePanel) sourcePanel.classList.remove('rol-active');

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
        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || AIService.DEFAULT_MEMORY_PROMPT).        replace('{{context}}', contextText);
        const raw = await AIService.generateWithPreset(prompt);
        if (loading) loading.style.display = 'none';
        if (rolStopBtn) rolStopBtn.style.display = 'none';
        // ┣━━if (sourcePanel) sourcePanel.classList.remove('rol-active');

        if (!raw) { showToast('🥀 酿造失败... :('); return; }
        const parsed = AIService.parseAIOutput(raw);

        // ┣━━保存生成参数，用于重写━━┫
        lastGenerateOptions = { type: 'paste', text: contextText };

        // ┣━━自动打开编辑表单━━┫
        if (sourcePanel) sourcePanel.classList.remove('rol-active'); 
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
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    return { initUI, renderMemoryList, renderPresetOptions, showToast };
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
    const response = await fetch(`${extensionFolderPath}/index.html`);
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
    }

    UIController.initUI();
    Trigger.setupTriggerListener(injectMemoryToContext);
    const context = getContext();
    if (context.eventSource) {
        context.eventSource.on('chatLoaded', () => UIController.renderMemoryList());
    }
    console.log(`[RingOurLuv] 🩷温室：欢迎回家 ✨ Our Love Nest`);
});
