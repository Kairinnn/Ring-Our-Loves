// ============================================================
// IMPORTS — 路径已按参考插件校正
// ============================================================
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
                    summaryPrompt: '请将以下对话片段总结为一条简短的记忆，保留关键情感和事件：\n{{context}}'
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
        const newMemory = {
            id: generateId(),
            title: memoryData.title || '未命名记忆',
            triggers: memoryData.triggers || [],
            tags: memoryData.tags || [],
            mood: memoryData.mood || '',
            content: memoryData.content || '',
            versions: [
                {
                    content: memoryData.content || '',
                    timestamp: new Date().toISOString(),
                    type: 'original'
                }
            ],
            enabled: true,
            createdAt: new Date().toISOString()
        };
        settings.memories.push(newMemory);
        saveSettingsDebounced();
        return newMemory;
    }

    function updateMemory(id, updates) {
        const settings = extension_settings[extensionName];
        const index = settings.memories.findIndex(m => m.id === id);
        if (index === -1) return null;

        const memory = settings.memories[index];

        if (updates.content && updates.content !== memory.content) {
            memory.versions.push({
                content: updates.content,
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

    function addRewriteVersion(id, newContent) {
        const settings = extension_settings[extensionName];
        const memory = settings.memories.find(m => m.id === id);
        if (!memory) return null;

        memory.versions.push({
            content: newContent,
            timestamp: new Date().toISOString(),
            type: 'ai_rewrite'
        });
        memory.content = newContent;
        saveSettingsDebounced();
        return memory;
    }

    function rollbackVersion(id, versionIndex) {
        const settings = extension_settings[extensionName];
        const memory = settings.memories.find(m => m.id === id);
        if (!memory || !memory.versions[versionIndex]) return null;

        memory.content = memory.versions[versionIndex].content;
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
        initSettings,
        getMemories,
        addMemory,
        updateMemory,
        deleteMemory,
        addRewriteVersion,
        rollbackVersion,
        getConfig,
        updateConfig
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

                if (isMatch) {
                    matched.push(memory);
                    break;
                }
            }
        }
        return matched;
    }

    function selectForInjection(matchedMemories) {
        const config = Storage.getConfig();
        const maxCount = config.maxInjectCount || 3;
        return matchedMemories.slice(0, maxCount);
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
        const handler = (msgIndex) => {
            const config = Storage.getConfig();
            if (!config.autoInject) return;

            const context = getContext();
            const chat = context.chat;
            if (!chat || !chat[msgIndex]) return;

            const message = chat[msgIndex];
            const matched = detectTriggers(message.mes);

            if (matched.length > 0) {
                const selected = selectForInjection(matched);
                const injectionText = buildInjectionText(selected);
                if (onTriggered) {
                    onTriggered(selected, injectionText);
                }
            }
        };

        eventSource.on(event_types.MESSAGE_RECEIVED, handler);
        eventSource.on(event_types.MESSAGE_SENT, handler);
    }

    function scanRecentMessages(count = 5) {
        const context = getContext();
        const chat = context.chat || [];
        const recent = chat.slice(-count);

        const allMatched = new Map();
        for (const msg of recent) {
            const matched = detectTriggers(msg.mes || '');
            for (const mem of matched) {
                allMatched.set(mem.id, mem);
            }
        }
        return Array.from(allMatched.values());
    }

    return {
        detectTriggers,
        selectForInjection,
        buildInjectionText,
        setupTriggerListener,
        scanRecentMessages
    };
})();

// ============================================================
// MODULE: AIService
// ============================================================
const AIService = (() => {
    async function switchPreset(presetName) {
        if (!presetName) return false;
        try {
            const pm = getPresetManager();
            if (pm) {
                await pm.selectPreset(presetName);
                return true;
            }
        } catch (e) {
            console.error('[RingOurLuv] 切换预设失败:', e);
        }
        return false;
    }

    function getCurrentPresetName() {
        try {
            const pm = getPresetManager();
            return pm?.getSelectedPreset?.() || '';
        } catch (e) {
            return '';
        }
    }

    function getAvailablePresets() {
        try {
            const pm = getPresetManager();
            return pm?.getPresets?.() || [];
        } catch (e) {
            return [];
        }
    }

    async function generateWithPreset(prompt) {
        const config = Storage.getConfig();
        const targetPreset = config.presetName;
        let originalPreset = '';

        try {
            if (targetPreset) {
                originalPreset = getCurrentPresetName();
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
                await switchPreset(originalPreset);
            }
        }
    }

    async function rewriteMemory(memoryId, memory) {
        const config = Storage.getConfig();
        const prompt = (config.summaryPrompt || '请重新总结以下记忆内容，使其更精炼：\n{{context}}')
            .replace('{{context}}', memory.content);

        const newContent = await generateWithPreset(prompt);
        if (!newContent) return null;

        return Storage.addRewriteVersion(memoryId, newContent.trim());
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
        const prompt = (config.summaryPrompt || '请将以下对话片段总结为一条简短的记忆：\n{{context}}')
            .replace('{{context}}', contextText);

        const result = await generateWithPreset(prompt);
        return result?.trim() || '';
    }

    return {
        switchPreset,
        getCurrentPresetName,
        getAvailablePresets,
        generateWithPreset,
        rewriteMemory,
        generateMemoryFromContext
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
        bindMobileNav();
        renderMemoryList();
        renderPresetOptions();
    }

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
        for (const preset of presets) {
            const name = typeof preset === 'string' ? preset : preset.name;
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            if (name === config.presetName) opt.selected = true;
            presetSelect.appendChild(opt);
        }
    }

    function bindMemoryList() {
        const addBtn = document.getElementById('rol-add-memory');
        const searchInput = document.getElementById('rol-search');
        const scanBtn = document.getElementById('rol-scan-recent');

        if (addBtn) {
            addBtn.addEventListener('click', () => openEditor(null));
        }

        if (searchInput) {
            searchInput.addEventListener('input', () => {
                renderMemoryList(searchInput.value);
            });
        }

        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                const matched = Trigger.scanRecentMessages(10);
                if (matched.length) {
                    showToast(`检测到 ${matched.length} 条匹配记忆`);
                } else {
                    showToast('最近消息中未匹配到触发词');
                }
            });
        }
    }

    function renderMemoryList(filter = '') {
        const container = document.getElementById('rol-memory-list');
        if (!container) return;

        const memories = Storage.getMemories();
        const filtered = filter
            ? memories.filter(m =>
                m.title.toLowerCase().includes(filter.toLowerCase()) ||
                m.tags.some(t => t.toLowerCase().includes(filter.toLowerCase())) ||
                m.triggers.some(t => t.toLowerCase().includes(filter.toLowerCase()))
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
                <div class="rol-card-preview">${escapeHtml(mem.content.slice(0, 80))}${mem.content.length > 80 ? '...' : ''}</div>
                <div class="rol-card-actions">
                    <button class="rol-btn-edit" title="编辑">✏️</button>
                    <button class="rol-btn-rewrite" title="AI重写">🔄</button>
                    <button class="rol-btn-delete" title="删除">🗑️</button>
                </div>
                ${mem.mood ? `<span class="rol-mood-badge">${escapeHtml(mem.mood)}</span>` : ''}
            `;

            card.querySelector('.rol-mem-toggle').addEventListener('change', (e) => {
                Storage.updateMemory(mem.id, { enabled: e.target.checked });
                card.classList.toggle('rol-disabled', !e.target.checked);
            });

            card.querySelector('.rol-btn-edit').addEventListener('click', () => openEditor(mem.id));

            card.querySelector('.rol-btn-rewrite').addEventListener('click', async () => {
                showToast('正在重写...');
                const result = await AIService.rewriteMemory(mem.id, mem);
                if (result) {
                    showToast('重写完成！');
                    renderMemoryList(filter);
                } else {
                    showToast('重写失败 :(');
                }
            });

            card.querySelector('.rol-btn-delete').addEventListener('click', () => {
                if (confirm('确定删除这条记忆？')) {
                    Storage.deleteMemory(mem.id);
                    renderMemoryList(filter);
                }
            });

            container.appendChild(card);
        }
    }

    function bindEditorPanel() {
        const saveBtn = document.getElementById('rol-editor-save');
        const cancelBtn = document.getElementById('rol-editor-cancel');
        const versionSelect = document.getElementById('rol-version-select');

        if (saveBtn) {
            saveBtn.addEventListener('click', saveEditor);
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', closeEditor);
        }
        if (versionSelect) {
            versionSelect.addEventListener('change', () => {
                const idx = parseInt(versionSelect.value);
                if (isNaN(idx) || !currentEditId) return;
                const mem = Storage.getMemories().find(m => m.id === currentEditId);
                if (mem && mem.versions[idx]) {
                    document.getElementById('rol-editor-content').value = mem.versions[idx].content;
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
            document.getElementById('rol-editor-content').value = mem.content;

            const versionSelect = document.getElementById('rol-version-select');
            if (versionSelect) {
                versionSelect.innerHTML = '';
                mem.versions.forEach((v, i) => {
                    const opt = document.createElement('option');
                    opt.value = i;
                    opt.textContent = `${v.type} - ${new Date(v.timestamp).toLocaleString()}`;
                    versionSelect.appendChild(opt);
                });
                versionSelect.value = mem.versions.length - 1;
                versionSelect.parentElement.style.display = '';
            }
        } else {
            document.getElementById('rol-editor-title').value = '';
            document.getElementById('rol-editor-triggers').value = '';
            document.getElementById('rol-editor-tags').value = '';
            document.getElementById('rol-editor-mood').value = '';
            document.getElementById('rol-editor-content').value = '';
            const versionSelect = document.getElementById('rol-version-select');
            if (versionSelect) versionSelect.parentElement.style.display = 'none';
        }
    }

    function saveEditor() {
        const title = document.getElementById('rol-editor-title').value.trim();
        const triggers = document.getElementById('rol-editor-triggers').value.split(',').map(s => s.trim()).filter(Boolean);
        const tags = document.getElementById('rol-editor-tags').value.split(',').map(s => s.trim()).filter(Boolean);
        const mood = document.getElementById('rol-editor-mood').value.trim();
        const content = document.getElementById('rol-editor-content').value.trim();

        if (!title || !content) {
            showToast('标题和内容不能为空！');
            return;
        }

        if (currentEditId) {
            Storage.updateMemory(currentEditId, { title, triggers, tags, mood, content });
        } else {
            Storage.addMemory({ title, triggers, tags, mood, content });
        }

        closeEditor();
        renderMemoryList();
        showToast(currentEditId ? '已更新！' : '已添加！');
    }

    function closeEditor() {
        currentEditId = null;
        const panel = document.getElementById('rol-editor-panel');
        if (panel) panel.classList.remove('rol-active');
    }

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
            });
        });
    }

    function showToast(message) {
        let toast = document.getElementById('rol-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'rol-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('rol-toast-show');
        setTimeout(() => toast.classList.remove('rol-toast-show'), 2500);
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    return {
        initUI,
        renderMemoryList,
        renderPresetOptions,
        showToast
    };
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
    if (!response.ok) {
        console.error('[RingOurLuv] 加载面板HTML失败:', response.status);
        return '';
    }
    return await response.text();
}

jQuery(async () => {
    Storage.initSettings();

    // 延迟挂载，等ST的UI容器渲染完
    const waitForContainer = () => {
        return new Promise((resolve) => {
            const check = () => {
                // ST的扩展设置区域
                const container = document.getElementById('extensions_settings2')
                    || document.getElementById('extensions_settings')
                    || document.querySelector('.extensions_block');
                if (container) {
                    resolve(container);
                } else {
                    setTimeout(check, 300);
                }
            };
            check();
        });
    };

    const panelHtml = await loadPanel();

    if (panelHtml) {
        const container = await waitForContainer();
        $(container).append(panelHtml);
        console.log('[RingOurLuv] 面板已挂载 ✅');
        UIController.initUI();
    } else {
        console.error('[RingOurLuv] ⚠️ HTML加载失败，检查文件夹名！');
        // 就算没UI也把基础功能跑起来
    }

    Trigger.setupTriggerListener(injectMemoryToContext);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        UIController.renderMemoryList();
    });

    console.log('[RingOurLuv] 初始化完成 ✨');
});
