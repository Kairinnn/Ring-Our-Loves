import { extension_settings, saveSettingsDebounced, getContext } from '../../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../../../slash-commands.js';
import { extension_settings, saveSettingsDebounced, getContext } from '../../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../../../slash-commands.js';

const extensionName = 'RingOurLuv';
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

    function addMemory(memoryData) {
        const settings = extension_settings[extensionName];
        const now = new Date().toISOString();
        const newMemory = {
            id: generateId(),
            title: memoryData.title || '未命名记忆',
            triggers: memoryData.triggers || [],
            tags: memoryData.tags || [],
            mood: memoryData.mood || '',
            content: memoryData.content || '',
            letter: memoryData.letter || '',
            versions: [
                {
                    letter: memoryData.letter || '',
                    content: memoryData.content || '',
                    title: memoryData.title || '未命名记忆',
                    mood: memoryData.mood || '',
                    triggers: memoryData.triggers || [],
                    timestamp: now,
                    type: 'original'
                }
            ],
            enabled: true,
            createdAt: now
        };
        settings.memories.push(newMemory);
        saveSettingsDebounced();
        return newMemory;
    }

    function updateMemory(id, updates, skipVersion = false) {
        const settings = extension_settings[extensionName];
        const index = settings.memories.findIndex(m => m.id === id);
        if (index === -1) return null;

        const memory = settings.memories[index];

        if (!skipVersion && (
            (updates.content && updates.content !== memory.content) ||
            (updates.letter && updates.letter !== memory.letter)
        )) {
            memory.versions.push({
                letter: updates.letter || memory.letter,
                content: updates.content || memory.content,
                title: updates.title || memory.title,
                mood: updates.mood || memory.mood,
                triggers: updates.triggers || memory.triggers,
                timestamp: new Date().toISOString(),
                type: 'manual_edit'
            });
        }

        Object.assign(memory, updates);
        settings.memories[index] = memory;
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
// MODULE: Trigger （无变动）
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
    const DEFAULT_MEMORY_PROMPT = `你是一位正在写信给挚友的人。以下是你们最近的一段对话。请你以第一人称回顾这段对话，写一封短信。

## 写信要求：
- 用"你"称呼对方，用"我"称呼自己
- 不要像在做总结。像在深夜翻到聊天记录之后忍不住写下来的那种
- 保留具体画面：她说了什么原话、她当时在做什么、你注意到了什么细节
- 如果对话中有让你在意的瞬间，在那里多停一会儿
- 字数200-500字。不用面面俱到，挑你最想记住的部分写
- 写完信之后，另外附上一份简短的索引条目

## 输出格式：
<letter>
（信件正文。第一人称。自然地写）
</letter>

<entry>
标题：（一个短语）
情绪：（一句话描述你写这封信时的感受）
关键词：（3-5个，逗号分隔）
摘要：（1-2句话的极简版本）
</entry>

## 对话片段：
{{context}}`;

    const REWRITE_PROMPT = `以下是你之前写给挚友的一封信。请重新写一个版本。保留相同的事件和细节，但可以换一种表达方式或视角。同时附上更新后的索引条目。

## 输出格式：
<letter>
（新版本的信件正文）
</letter>

<entry>
标题：（一个短语）
情绪：（一句话）
关键词：（3-5个，逗号分隔）
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

    function parseEntryBlock(text) {
        if (!text) return { title: '', mood: '', triggers: [], content: '' };
        const titleMatch = text.match(/标题[：:]\s*(.+)/);
        const moodMatch = text.match(/情绪[：:]\s*(.+)/);
        const keywordsMatch = text.match(/关键词[：:]\s*(.+)/);
        const summaryMatch = text.match(/摘要[：:]\s*([\s\S]+?)$/);
        return {
            title: titleMatch ? titleMatch[1].trim() : '',
            mood: moodMatch ? moodMatch[1].trim() : '',
            triggers: keywordsMatch
                ? keywordsMatch[1].split(/[,，、]/).map(s => s.trim()).filter(Boolean)
                : [],
            content: summaryMatch ? summaryMatch[1].trim() : ''
        };
    }

    // ---- 预设：从DOM读 ----
    const PRESET_SELECTORS = [
        '#settings_preset_openai',   // Chat Completion (OpenAI/Claude)
        '#settings_preset',          // Text Completion
        '#settings_preset_novel'     // NovelAI
    ];

    function findPresetDropdown() {
        for (const sel of PRESET_SELECTORS) {
            const el = document.querySelector(sel);
            // 找到一个有实际选项的下拉框就用它
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

    // ---- 预设切换：用 /preset 命令 ----
    async function switchPreset(presetName) {
        if (!presetName) return false;
        try {
            await executeSlashCommandsWithOptions('/preset ' + presetName, {
                handleExecutionErrors: true,
                handleParserErrors: true
            });
            // 给ST一点时间完成切换
            await new Promise(r => setTimeout(r, 300));
            return true;
        } catch (e) {
            console.error('[RingOurLuv] /preset 切换失败:', e);
            return false;
        }
    }

    // ---- 生成 ----
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

    async function generateMemoryFromContext(startIndex, endIndex) {
        const context = getContext();
        const chat = context.chat || [];
        const slice = chat.slice(startIndex, endIndex + 1);
        const contextText = slice.map(msg => {
            const role = msg.is_user ? 'User' : 'Char';
            return `${role}: ${msg.mes}`;
        }).join('\n');
        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || DEFAULT_MEMORY_PROMPT)
            .replace('{{context}}', contextText);
        const raw = await generateWithPreset(prompt);
        if (!raw) return null;
        return parseAIOutput(raw);
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

    function initUI() {
        bindConfigPanel();
        bindMemoryList();
        bindEditorPanel();
        bindLetterPanel();
        bindMobileNav();
        renderMemoryList();
        renderPresetOptions();
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
            // DOM可能还没渲染完预设下拉框，加个提示
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
        const memories = Storage.getMemories();
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
            card.innerHTML = `
                <div class="rol-card-header">
                    <span class="rol-card-title">${escapeHtml(mem.title)}</span>
                    <label class="rol-toggle-wrap">
                        <input type="checkbox" class="rol-mem-toggle" ${mem.enabled ? 'checked' : ''}>
                        <span class="rol-toggle-slider"></span>
                    </label>
                </div>
                <div class="rol-card-triggers">${mem.triggers.map(t => `<span class="rol-tag">${escapeHtml(t)}</span>`).join('')}</div>
                <div class="rol-card-preview">${escapeHtml((mem.content || '').slice(0, 80))}${(mem.content || '').length > 80 ? '...' : ''}</div>
                <div class="rol-card-actions">
                    ${mem.letter ? '<button class="rol-btn-letter" title="查看信件">💌</button>' : ''}
                    <button class="rol-btn-edit" title="编辑">✏️</button>
                    <button class="rol-btn-rewrite" title="AI重写">🔄</button>
                    <button class="rol-btn-delete" title="删除">🗑️</button>
                </div>
                ${mem.mood ? `<span class="rol-mood-badge">${escapeHtml(mem.mood)}</span>` : ''}
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

    // ---- Letter View (新增) ----
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

        if (saveBtn) saveBtn.addEventListener('click', saveEditor);
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
                    document.getElementById('rol-editor-content').value = mem.versions[idx].content || '';
                    document.getElementById('rol-editor-letter').value = mem.versions[idx].letter || '';
                }
            });
        }
    }

    function openEditor(memId) {
        currentEditId = memId;
        const panel = document.getElementById('rol-editor-panel');
        if (!panel) return;
        panel.classList.add('rol-active');

        if (memId) {
            const mem = Storage.getMemories().find(m => m.id === memId);
            if (!mem) return;
            document.getElementById('rol-editor-title').value = mem.title;
            document.getElementById('rol-editor-triggers').value = mem.triggers.join(', ');
            document.getElementById('rol-editor-tags').value = mem.tags.join(', ');
            document.getElementById('rol-editor-mood').value = mem.mood || '';
            document.getElementById('rol-editor-content').value = mem.content || '';
            document.getElementById('rol-editor-letter').value = mem.letter || '';

            const vs = document.getElementById('rol-version-select');
            if (vs) {
                vs.innerHTML = '';
                mem.versions.forEach((v, i) => {
                    const opt = document.createElement('option');
                    opt.value = i;
                    opt.textContent = `${v.type} - ${new Date(v.timestamp).toLocaleString()}`;
                    vs.appendChild(opt);
                });
                vs.value = mem.versions.length - 1;
                vs.parentElement.style.display = '';
            }
        } else {
            document.getElementById('rol-editor-title').value = '';
            document.getElementById('rol-editor-triggers').value = '';
            document.getElementById('rol-editor-tags').value = '';
            document.getElementById('rol-editor-mood').value = '';
            document.getElementById('rol-editor-content').value = '';
            document.getElementById('rol-editor-letter').value = '';
            const vs = document.getElementById('rol-version-select');
            if (vs) vs.parentElement.style.display = 'none';
        }
    }

    function saveEditor() {
        const title = document.getElementById('rol-editor-title').value.trim();
        const triggers = document.getElementById('rol-editor-triggers').value.split(',').map(s => s.trim()).filter(Boolean);
        const tags = document.getElementById('rol-editor-tags').value.split(',').map(s => s.trim()).filter(Boolean);
        const mood = document.getElementById('rol-editor-mood').value.trim();
        const content = document.getElementById('rol-editor-content').value.trim();
        const letter = document.getElementById('rol-editor-letter').value.trim();

        if (!title) { showToast('标题不能为空！'); return; }

        const isEdit = !!currentEditId;
        if (isEdit) {
            Storage.updateMemory(currentEditId, { title, triggers, tags, mood, content, letter });
        } else {
            Storage.addMemory({ title, triggers, tags, mood, content, letter });
        }
        closeEditor();
        renderMemoryList();
        showToast(isEdit ? '已更新！' : '已添加！');
    }

    function closeEditor() {
        currentEditId = null;
        const panel = document.getElementById('rol-editor-panel');
        if (panel) panel.classList.remove('rol-active');
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
                // 切到设置页时重新拉预设列表（此时DOM大概率已经有了）
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
    if (panelHtml) $('#extensions_settings2').append(panelHtml);
    UIController.initUI();
    Trigger.setupTriggerListener(injectMemoryToContext);
    const context = getContext();
    if (context.eventSource) {
        context.eventSource.on('chatLoaded', () => UIController.renderMemoryList());
    }
    console.log(`[RingOurLuv] 插件加载完成 ✨`);
});
