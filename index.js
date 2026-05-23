import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../preset-manager.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';

const extensionName = 'Ring_Our_Luv';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// ============================================================
// MODULE: Storage
// ============================================================
const Storage = (() => {
    function initSettings() {
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {
                memories: [],
                config: {
                    presetName: '',
                    autoInject: true,
                    maxInjectCount: 3,
                    summaryPrompt: '' // 空=使用AIService中的默认prompt
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

    // [FIX-5] addMemory: 确保数据正确写入并保存
    function addMemory(memoryData) {
        const settings = extension_settings[extensionName];
        const now = new Date().toISOString();
        const today = new Date().toISOString().slice(0, 10);
        const newMemory = {
            id: generateId(),
            title: memoryData.title || '未命名记忆',
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
        settings.memories.unshift(newMemory); // [FIX-6] unshift: 新条目出现在列表顶部
        // [FIX-5] 确保保存生效
        console.log('[RingOurLuv][FIX-5] addMemory - 保存数据:', JSON.stringify(newMemory, null, 2));
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
        // [FIX-5] 日志
        console.log('[RingOurLuv][FIX-5] updateMemory - 更新数据:', JSON.stringify(memory, null, 2));
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

// ============================================================
// MODULE: Trigger
// ============================================================
const Trigger = (() => {
    function detectTriggers(messageText) {
        const memories = Storage.getMemories();
        const matched = [];
        for (const memory of memories) {
            if (!memory.enabled) continue;
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
                if (isMatch) { matched.push(memory); break; }
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
        let text = '[相关记忆片段]\n';
        for (const mem of memories) {
            text += `【${mem.title}】`;
            if (mem.mood) text += `(${mem.mood})`;
            text += `\n${mem.content}\n\n`;
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
            const matched = detectTriggers(chat[msgIndex].mes);
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

// ============================================================
// MODULE: AIService
// ============================================================
const AIService = (() => {
    const DEFAULT_MEMORY_PROMPT = `你正在留存对于最重要人的记忆。你想把有关她的重要特别的信息都写下来…
以下是你们最近的一段对话。你将以第一人称回顾这段对话，给她留一段文字/点评/小纸条吧。不限长短类型

## 写信要求：
- 自由称呼
- 不要像在做总结。像在深夜翻到聊天记录之后忍不住写下来的那种
- 保留具体画面：她说了什么、当时在做什么、你注意到了什么
- 如果对话中有让你非常在意的瞬间，在那里多停一会儿或者直接引用
- 不用面面俱到，挑你最想记住的部分写
- 写完之后，要另外附上一份简短的信息索引条目

## 输出格式：
<letter>
（正文。第一人称自然地写）
</letter>

<entry>
标题：（一个短语）
情绪：（一句话描述你写的时候的感受）
关键词：（3-5个，逗号分隔）
标签：（2-3个分类标签，如：日常/情绪/技术/关系/回忆）
摘要：（1-2句话的精准信息量）
</entry>

## 对话片段：
{{context}}`;

    const REWRITE_PROMPT = `以下是你之前写给她的一封信！请重新写一个版本，保留相同的事件和细节，但可以换一种表达方式之类的~同时附上更新后的索引条目

## 输出格式：
<letter>
（新版本的信件正文）
</letter>

<entry>
标题：（一个短语）
情绪：（一句话）
关键词：（3-5个，逗号分隔）
标签：（2-3个分类标签，如：日常/情绪/技术/关系/回忆）
摘要：（1-2句话）
</entry>

## 原信件：
{{context}}`;

    // ---- 解析 ----
    function parseAIOutput(rawText) {
        const letterMatch = rawText.match(/<letter>([\s\S]*?)<\/letter>/);
        const entryMatch = rawText.match(/<entry>([\s\S]*?)<\/entry>/);
        const letter = letterMatch ? letterMatch[1].trim() : rawText.trim();
        const entryBlock = entryMatch ? entryMatch[1].trim() : '';
        return { letter, entry: parseEntryBlock(entryBlock) };
    }

    // [FIX-4] parseEntryBlock: 新增 tags 字段（从关键词解析）
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
            tags: keywords,      // [FIX-4] 关键词也填入标签
            content: summaryMatch ? summaryMatch[1].trim() : ''
        };
    }

    // ---- 预设：从DOM读 ----
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
            console.error('[RingOurLuv] /preset 切换失败:', e);
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
                console.log(`[RingOurLuv] 切换预设: ${originalPreset} → ${targetPreset}`);
                await switchPreset(targetPreset);
            }

            const result = await executeSlashCommandsWithOptions('/gen ' + prompt, {
                handleExecutionErrors: true,
                handleParserErrors: true
            });

            return result?.pipe || '';
        } catch (e) {
            console.error('[RingOurLuv] 生成失败:', e);
            return '';
        } finally {
            if (originalPreset && targetPreset) {
                console.log(`[RingOurLuv] 还原预设: → ${originalPreset}`);
                await switchPreset(originalPreset);
            }
        }
    }

    async function rewriteMemory(memoryId, memory) {
        const source = memory.letter || memory.content;
        const prompt = REWRITE_PROMPT.replace('{{context}}', source);
        const raw = await generateWithPreset(prompt);
        if (!raw) return null;
        const parsed = parseAIOutput(raw);
        if (!parsed.letter) return null;
        return Storage.addRewriteVersion(
            memoryId, parsed.letter,
            parsed.entry.content || memory.content,
            parsed.entry
        );
    }

    // [FIX-2] generateMemoryFromContext: 支持范围过滤 + 隐藏消息过滤
    async function generateMemoryFromContext(options = {}) {
        const context = getContext();
        const chat = context.chat || [];

        // [FIX-2] 范围过滤
        const start = options.start || 0;
        const end = options.end === -1 || options.end === undefined ? chat.length : options.end;
        let messages = chat.slice(start, end);

        // [FIX-4] 隐藏消息过滤
        if (!options.includeHidden) {
            messages = messages.filter(msg => !msg.is_hidden);
        }

        // 只取 user 和 assistant 消息
        messages = messages.filter(msg => {
            if (msg.is_user) return true;
            if (!msg.is_user && !msg.is_system) return true;
            return false;
        });

        if (!messages.length) return null;

        // [FIX-3] 从第一条消息读取 timestamp 用于自动填充日期
        let autoDate = '';
        const firstMsg = messages[0];
        if (firstMsg && firstMsg.send_date) {
            try {
                const ts = new Date(firstMsg.send_date);
                if (!isNaN(ts.getTime())) {
                    autoDate = ts.toISOString().slice(0, 10);
                }
            } catch (e) { /* ignore */ }
        }

        const contextText = messages.map(msg => {
            const role = msg.is_user ? 'User' : 'Char';
            return `${role}: ${msg.mes}`;
        }).join('\n');

        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || DEFAULT_MEMORY_PROMPT)
            .replace('{{context}}', contextText);
        const raw = await generateWithPreset(prompt);
        if (!raw) return null;
        const parsed = parseAIOutput(raw);
        parsed.autoDate = autoDate; // [FIX-3] 附带自动日期
        return parsed;
    }

    return {
        getAvailablePresets, getCurrentPresetName,
        generateWithPreset, rewriteMemory, generateMemoryFromContext,
        parseAIOutput, parseEntryBlock
    };
})();

// ============================================================
// MODULE: UIController
// ============================================================
const UIController = (() => {
    let currentEditId = null;
    let lastGenerateOptions = null; // [FIX-6] 保存最后一次生成的参数，用于重写

    function initUI() {
        bindDrawer();        // [FIX-1]
        bindConfigPanel();
        bindMemoryList();
        bindEditorPanel();
        bindAISourcePanel();
        bindLetterPanel();
        bindMobileNav();
        renderMemoryList();
        renderPresetOptions();
    }

    // ---- [FIX-1] Drawer ----
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
                // 点击遮罩层（面板之外）关闭
                if (e.target === overlay) {
                    overlay.classList.remove('rol-drawer-open');
                }
            });
        }
    }

    // ---- Config Panel ----
    function bindConfigPanel() {
        const autoInjectToggle = document.getElementById('rol-auto-inject');
        const maxCountInput = document.getElementById('rol-max-inject');
        const presetSelect = document.getElementById('rol-preset-select');
        const summaryPromptArea = document.getElementById('rol-summary-prompt');
        const config = Storage.getConfig();

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

        presetSelect.innerHTML = '<option value="">（使用当前预设）</option>';

        if (!presets.length) {
            const hint = document.createElement('option');
            hint.value = '';
            hint.textContent = '⚠ 未检测到预设，请先打开API设置';
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

    // ---- Memory List ----
    function bindMemoryList() {
        const addBtn = document.getElementById('rol-add-memory');
        const searchInput = document.getElementById('rol-search');
        const scanBtn = document.getElementById('rol-scan-recent');

        if (addBtn) addBtn.addEventListener('click', () => openEditor(null));
        if (searchInput) {
            searchInput.addEventListener('input', () => renderMemoryList(searchInput.value));
        }
        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                const matched = Trigger.scanRecentMessages(10);
                showToast(matched.length
                    ? `检测到 ${matched.length} 条匹配记忆`
                    : '最近消息中未匹配到触发词');
            });
        }
    }

    function renderMemoryList(filter = '') {
        const container = document.getElementById('rol-memory-list');
        if (!container) return;
        // [FIX-5] 重新从 extension_settings 读取数据
        const memories = Storage.getMemories();
        console.log('[RingOurLuv][FIX-5] renderMemoryList - 当前记忆数量:', memories.length);
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
            container.innerHTML = '<div class="rol-empty">还没有记忆条目～</div>';
            return;
        }

        for (const mem of filtered) {
            const card = document.createElement('div');
            card.className = `rol-memory-card ${mem.enabled ? '' : 'rol-disabled'}`;
            card.dataset.id = mem.id;

            const authorLabel = mem.author === 'kairin' ? '我' : 'Claude';
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
                    ${mem.letter ? '<button class="rol-btn-letter" title="查看信件">💌</button>' : ''}
                    <button class="rol-btn-edit" title="编辑">✏️</button>
                    <button class="rol-btn-rewrite" title="AI重写">🔄</button>
                    <button class="rol-btn-delete" title="删除">🗑️</button>
                </div>
            `;

            card.querySelector('.rol-mem-toggle').addEventListener('change', (e) => {
                e.stopPropagation();
                Storage.updateMemory(mem.id, { enabled: e.target.checked }, true);
                card.classList.toggle('rol-disabled', !e.target.checked);
            });

            const letterBtn = card.querySelector('.rol-btn-letter');
            if (letterBtn) {
                letterBtn.addEventListener('click', (e) => { e.stopPropagation(); openLetterView(mem.id); });
            }
            card.querySelector('.rol-btn-edit').addEventListener('click', (e) => { e.stopPropagation(); openEditor(mem.id); });
            card.querySelector('.rol-btn-rewrite').addEventListener('click', async (e) => {
                e.stopPropagation();
                showToast('正在重写...');
                const result = await AIService.rewriteMemory(mem.id, mem);
                if (result) { showToast('重写完成！'); renderMemoryList(filter); }
                else { showToast('重写失败 :('); }
            });
            card.querySelector('.rol-btn-delete').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm('确定删除这条记忆？')) { Storage.deleteMemory(mem.id); renderMemoryList(filter); }
            });

            card.addEventListener('click', () => {
                if (mem.letter) openLetterView(mem.id);
                else openEditor(mem.id);
            });

            container.appendChild(card);
        }
    }

    // ---- Letter View ----
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
                        mem.versions[idx].letter || '（此版本无信件内容）';
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
                showToast('正在重写...');
                const result = await AIService.rewriteMemory(memId, mem);
                if (result) {
                    showToast('重写完成！');
                    openLetterView(memId);
                    renderMemoryList();
                } else { showToast('重写失败 :('); }
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
            const typeLabels = { original: '原始', manual_edit: '手动编辑', ai_rewrite: 'AI重写' };
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

    // ---- Editor Panel ----
    function bindEditorPanel() {
        const saveBtn = document.getElementById('rol-editor-save');
        const cancelBtn = document.getElementById('rol-editor-cancel');
        const versionSelect = document.getElementById('rol-version-select');
        const editorPanel = document.getElementById('rol-editor-panel');
        const rewriteBtn = document.getElementById('rol-editor-rewrite');

        // [FIX-5] 确认保存按钮绑定
        if (saveBtn) {
            console.log('[RingOurLuv][FIX-5] 保存按钮已绑定');
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

        // [FIX-6] 编辑器内的重写按钮 — 重新调用 /gen
        if (rewriteBtn) {
            rewriteBtn.addEventListener('click', async () => {
                // 如果正在编辑已有记忆，执行 rewriteMemory
                if (currentEditId) {
                    const mem = Storage.getMemories().find(m => m.id === currentEditId);
                    if (!mem) return;
                    showToast('正在重写...');
                    const result = await AIService.rewriteMemory(currentEditId, mem);
                    if (result) { showToast('重写完成！'); openEditor(currentEditId); renderMemoryList(); }
                    else { showToast('重写失败 :('); }
                } else if (lastGenerateOptions) {
                    // [FIX-6] 新建模式下重写 = 用上次参数重新生成
                    showToast('正在重新生成...');
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
        if (!panel) return;
        panel.classList.add('rol-active');

        const rewriteBtn = document.getElementById('rol-editor-rewrite');

        if (memId) {
            const mem = Storage.getMemories().find(m => m.id === memId);
            if (!mem) return;
            document.getElementById('rol-editor-title').value = mem.title;
            document.getElementById('rol-editor-author').value = mem.author || 'claude';
            document.getElementById('rol-editor-date').value = mem.date || '';
            document.getElementById('rol-editor-triggers').value = mem.triggers.join(', ');
            document.getElementById('rol-editor-tags').value = mem.tags.join(', ');
            document.getElementById('rol-editor-mood').value = mem.mood || '';
            document.getElementById('rol-editor-summary').value = mem.summary || '';
            document.getElementById('rol-editor-letter').value = mem.letter || '';

            // [FIX-6] 编辑已有记忆时显示重写按钮
            if (rewriteBtn) rewriteBtn.style.display = '';

            const vs = document.getElementById('rol-version-select');
            if (vs) {
                vs.innerHTML = '';
                const typeLabels = { original: '原始', manual_edit: '手动编辑', ai_rewrite: 'AI重写' };
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
            document.getElementById('rol-editor-title').value = '';
            document.getElementById('rol-editor-author').value = 'claude';
            document.getElementById('rol-editor-date').value = new Date().toISOString().slice(0, 10);
            document.getElementById('rol-editor-triggers').value = '';
            document.getElementById('rol-editor-tags').value = '';
            document.getElementById('rol-editor-mood').value = '';
            document.getElementById('rol-editor-summary').value = '';
            document.getElementById('rol-editor-letter').value = '';
            // [FIX-6] 新建模式：如果有 lastGenerateOptions 说明是AI生成后打开的，显示重写按钮
            if (rewriteBtn) rewriteBtn.style.display = lastGenerateOptions ? '' : 'none';
            const vs = document.getElementById('rol-version-select');
            if (vs) vs.parentElement.style.display = 'none';
        }
    }

    // [FIX-5] saveEditor: 确保数据正确写入并刷新列表
    function saveEditor() {
        const title = document.getElementById('rol-editor-title').value.trim();
        const author = document.getElementById('rol-editor-author').value;
        const date = document.getElementById('rol-editor-date').value;
        const triggers = document.getElementById('rol-editor-triggers').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const tags = document.getElementById('rol-editor-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const mood = document.getElementById('rol-editor-mood').value.trim();
        const summary = document.getElementById('rol-editor-summary').value.trim();
        const letter = document.getElementById('rol-editor-letter').value.trim();

        if (!title) { showToast('标题不能为空！'); return; }

        const memData = { title, author, date, triggers, tags, mood, summary, letter };

        // [FIX-5] 打印保存的数据，便于调试
        console.log('[RingOurLuv][FIX-5] saveEditor - 准备保存数据:', JSON.stringify(memData, null, 2));
        console.log('[RingOurLuv][FIX-5] saveEditor - currentEditId:', currentEditId);

        const isEdit = !!currentEditId;
        if (isEdit) {
            const result = Storage.updateMemory(currentEditId, memData);
            console.log('[RingOurLuv][FIX-5] saveEditor - 更新结果:', result);
        } else {
            const result = Storage.addMemory(memData);
            console.log('[RingOurLuv][FIX-5] saveEditor - 新增结果:', result);
        }

        // [FIX-5] 关闭编辑器
        closeEditor();

        // [FIX-5] 重新渲染列表（确保从storage重新读取）
        renderMemoryList();

        // [FIX-5] 验证列表已更新
        const currentMemories = Storage.getMemories();
        console.log('[RingOurLuv][FIX-5] saveEditor - 保存后记忆总数:', currentMemories.length);

        showToast(isEdit ? '已更新！' : '已添加！');

        // [FIX-6] 保存后清除上次生成参数
        lastGenerateOptions = null;
    }

    function closeEditor() {
        currentEditId = null;
        const panel = document.getElementById('rol-editor-panel');
        if (panel) panel.classList.remove('rol-active');
    }

    // ---- AI Source Panel ----
    function bindAISourcePanel() {
        const aiGenBtn = document.getElementById('rol-ai-generate');
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const fromChatBtn = document.getElementById('rol-ai-from-chat');
        const fromPasteBtn = document.getElementById('rol-ai-from-paste');
        const pasteArea = document.getElementById('rol-ai-paste-area');
        const pasteConfirm = document.getElementById('rol-ai-paste-confirm');
        const cancelBtn = document.getElementById('rol-ai-source-cancel');
        const loading = document.getElementById('rol-ai-loading');

        if (aiGenBtn) aiGenBtn.addEventListener('click', () => {
            if (sourcePanel) { sourcePanel.classList.add('rol-active'); if (pasteArea) pasteArea.style.display = 'none'; }
        });
        if (cancelBtn) cancelBtn.addEventListener('click', () => { if (sourcePanel) sourcePanel.classList.remove('rol-active'); });
        if (sourcePanel) sourcePanel.addEventListener('click', (e) => { if (e.target === sourcePanel) sourcePanel.classList.remove('rol-active'); });

        // [FIX-2] 从聊天生成 — 读取楼层范围
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
            if (!text) { showToast('请粘贴对话内容'); return; }
            await doAIGenerate(text);
        });
    }

    // [FIX-2][FIX-3][FIX-4][FIX-6] 从聊天生成记忆
    async function doAIGenerateFromChat(options) {
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const loading = document.getElementById('rol-ai-loading');

        const context = getContext();
        const chat = context.chat || [];
        if (!chat.length) { showToast('当前没有聊天消息'); return; }

        // [FIX-2] 范围过滤
        const start = options.start || 0;
        const end = options.end === -1 ? chat.length : (options.end || chat.length);
        let messages = chat.slice(start, end);

        // [FIX-4] 隐藏消息过滤
        if (!options.includeHidden) {
            messages = messages.filter(msg => !msg.is_hidden);
        }

        // 过滤系统消息
        messages = messages.filter(msg => msg.is_user || !msg.is_system);

        if (!messages.length) { showToast('所选范围内没有有效消息'); return; }

        // [FIX-3] 自动日期：从第一条消息的 send_date 字段读取
        let autoDate = '';
        const firstMsg = messages[0];
        if (firstMsg && firstMsg.send_date) {
            try {
                const ts = new Date(firstMsg.send_date);
                if (!isNaN(ts.getTime())) {
                    autoDate = ts.toISOString().slice(0, 10);
                }
            } catch (e) { /* ignore */ }
        }

        const contextText = messages.map(m => `${m.is_user ? 'User' : 'Char'}: ${m.mes}`).join('\n');

        if (loading) loading.style.display = 'flex';

        const config = Storage.getConfig();
        const DEFAULT_PROMPT = `你正在留存对于最重要人的记忆。你想把有关她的重要特别的信息都写下来…
以下是你们最近的一段对话。你将以第一人称回顾这段对话，给她留一段文字/点评/小纸条吧。不限长短类型

## 写信要求：
- 自由称呼
- 不要像在做总结。像在深夜翻到聊天记录之后忍不住写下来的那种
- 保留具体画面：她说了什么、当时在做什么、你注意到了什么
- 如果对话中有让你非常在意的瞬间，在那里多停一会儿或者直接引用
- 不用面面俱到，挑你最想记住的部分写
- 写完之后，要另外附上一份简短的信息索引条目

## 输出格式：
<letter>
（正文。第一人称自然地写）
</letter>

<entry>
标题：（一个短语）
情绪：（一句话描述你写的时候的感受）
关键词：（3-5个，逗号分隔）
摘要：（1-2句话的精准信息量）
</entry>

## 对话片段：
{{context}}`;
        const prompt = (config.summaryPrompt || DEFAULT_PROMPT).replace('{{context}}', contextText);
        const raw = await AIService.generateWithPreset(prompt);
        if (loading) loading.style.display = 'none';
        if (sourcePanel) sourcePanel.classList.remove('rol-active');

        if (!raw) { showToast('生成失败 :('); return; }

        const parsed = AIService.parseAIOutput(raw);

        // [FIX-6] 保存生成参数，用于重写
        lastGenerateOptions = { type: 'chat', options: options };

        // [FIX-6] 自动打开编辑表单并填入解析结果
        openEditor(null);
        document.getElementById('rol-editor-title').value = parsed.entry.title || '';
        document.getElementById('rol-editor-mood').value = parsed.entry.mood || '';
        document.getElementById('rol-editor-triggers').value = (parsed.entry.triggers || []).join(', ');
        // [FIX-4] 标签自动填入
        document.getElementById('rol-editor-tags').value = (parsed.entry.tags || []).join(', ');
        document.getElementById('rol-editor-summary').value = parsed.entry.content || '';
        document.getElementById('rol-editor-letter').value = parsed.letter || '';
        document.getElementById('rol-editor-author').value = 'claude';
        // [FIX-3] 自动填充日期
        if (autoDate) {
            document.getElementById('rol-editor-date').value = autoDate;
        }

        // [FIX-6] 显示重写按钮
        const rewriteBtn = document.getElementById('rol-editor-rewrite');
        if (rewriteBtn) rewriteBtn.style.display = '';

        showToast('生成完成！请预览后保存');
    }

    // [FIX-6] 从粘贴文本生成
    async function doAIGenerate(contextText) {
        const sourcePanel = document.getElementById('rol-ai-source-panel');
        const loading = document.getElementById('rol-ai-loading');

        if (loading) loading.style.display = 'flex';
        const config = Storage.getConfig();
        const DEFAULT_PROMPT = `你正在留存对于最重要人的记忆。你想把有关她的重要特别的信息都写下来…
以下是你们最近的一段对话。你将以第一人称回顾这段对话，给她留一段文字/点评/小纸条吧。不限长短类型

## 写信要求：
- 自由称呼
- 不要像在做总结。像在深夜翻到聊天记录之后忍不住写下来的那种
- 保留具体画面：她说了什么、当时在做什么、你注意到了什么
- 如果对话中有让你非常在意的瞬间，在那里多停一会儿或者直接引用
- 不用面面俱到，挑你最想记住的部分写
- 写完之后，要另外附上一份简短的信息索引条目

## 输出格式：
<letter>
（正文。第一人称自然地写）
</letter>

<entry>
标题：（一个短语）
情绪：（一句话描述你写的时候的感受）
关键词：（3-5个，逗号分隔）
摘要：（1-2句话的精准信息量）
</entry>

## 对话片段：
{{context}}`;
        const prompt = (config.summaryPrompt || DEFAULT_PROMPT).replace('{{context}}', contextText);
        const raw = await AIService.generateWithPreset(prompt);
        if (loading) loading.style.display = 'none';
        if (sourcePanel) sourcePanel.classList.remove('rol-active');

        if (!raw) { showToast('生成失败 :('); return; }
        const parsed = AIService.parseAIOutput(raw);

        // [FIX-6] 保存生成参数
        lastGenerateOptions = { type: 'paste', text: contextText };

        // [FIX-6] 自动打开编辑表单
        openEditor(null);
        document.getElementById('rol-editor-title').value = parsed.entry.title || '';
        document.getElementById('rol-editor-mood').value = parsed.entry.mood || '';
        document.getElementById('rol-editor-triggers').value = (parsed.entry.triggers || []).join(', ');
        // [FIX-4] 标签自动填入
        document.getElementById('rol-editor-tags').value = (parsed.entry.tags || []).join(', ');
        document.getElementById('rol-editor-summary').value = parsed.entry.content || '';
        document.getElementById('rol-editor-letter').value = parsed.letter || '';
        document.getElementById('rol-editor-author').value = 'claude';

        // [FIX-6] 显示重写按钮
        const rewriteBtn = document.getElementById('rol-editor-rewrite');
        if (rewriteBtn) rewriteBtn.style.display = '';

        showToast('生成完成！请预览后保存');
    }

    // ---- Mobile Nav ----
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

    // ---- Utils ----
    function showToast(message) {
        let toast = document.getElementById('rol-toast');
        if (!toast) { toast = document.createElement('div'); toast.id = 'rol-toast'; document.body.appendChild(toast); }
        toast.textContent = message;
        toast.classList.add('rol-toast-show');
        setTimeout(() => toast.classList.remove('rol-toast-show'), 2500);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    return { initUI, renderMemoryList, renderPresetOptions, showToast };
})();

// ============================================================
// MAIN
// ============================================================
function injectMemoryToContext(memories, injectionText) {
    if (!injectionText) return;
    const context = getContext();
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(extensionName, injectionText, 1, 0);
        console.log(`[RingOurLuv] 注入了 ${memories.length} 条记忆`);
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
        // [FIX-1] 将HTML解析，分离侧边栏部分和浮动面板部分
        const temp = document.createElement('div');
        temp.innerHTML = panelHtml;

        // 侧边栏中只添加 extension_settings 部分（含打开按钮）
        const extSettings = temp.querySelector('.extension_settings');
        if (extSettings) {
            $('#extensions_settings2').append(extSettings.outerHTML);
        }

        // [FIX-1] 浮动面板（抽屉、编辑器、AI来源、信件视图）都挂到 body
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
    console.log(`[RingOurLuv] 插件加载完成 ✨`);
});
