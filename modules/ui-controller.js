
import {
    getMemories,
    addMemory,
    updateMemory,
    deleteMemory,
    getConfig,
    updateConfig,
    rollbackVersion
} from './storage.js';
import { rewriteMemory, getAvailablePresets, generateMemoryFromContext } from './ai-service.js';
import { scanRecentMessages } from './trigger.js';

let currentEditId = null;

// 初始化UI事件绑定
function initUI() {
    bindConfigPanel();
    bindMemoryList();
    bindEditorPanel();
    bindMobileNav();
    renderMemoryList();
    renderPresetOptions();
}

// 配置面板
function bindConfigPanel() {
    const autoInjectToggle = document.getElementById('rol-auto-inject');
    const maxCountInput = document.getElementById('rol-max-inject');
    const presetSelect = document.getElementById('rol-preset-select');
    const summaryPromptArea = document.getElementById('rol-summary-prompt');

    const config = getConfig();

    if (autoInjectToggle) {
        autoInjectToggle.checked = config.autoInject !== false;
        autoInjectToggle.addEventListener('change', () => {
            updateConfig({ autoInject: autoInjectToggle.checked });
        });
    }

    if (maxCountInput) {
        maxCountInput.value = config.maxInjectCount || 3;
        maxCountInput.addEventListener('input', () => {
            updateConfig({ maxInjectCount: parseInt(maxCountInput.value) || 3 });
        });
    }

    if (presetSelect) {
        presetSelect.value = config.presetName || '';
        presetSelect.addEventListener('change', () => {
            updateConfig({ presetName: presetSelect.value });
        });
    }

    if (summaryPromptArea) {
        summaryPromptArea.value = config.summaryPrompt || '';
        summaryPromptArea.addEventListener('input', () => {
            updateConfig({ summaryPrompt: summaryPromptArea.value });
        });
    }
}

// 渲染预设选项
function renderPresetOptions() {
    const presetSelect = document.getElementById('rol-preset-select');
    if (!presetSelect) return;

    const presets = getAvailablePresets();
    const config = getConfig();

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

// 记忆列表
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
            const matched = scanRecentMessages(10);
            if (matched.length) {
                showToast(`检测到 ${matched.length} 条匹配记忆`);
            } else {
                showToast('最近消息中未匹配到触发词');
            }
        });
    }
}

// 渲染记忆列表
function renderMemoryList(filter = '') {
    const container = document.getElementById('rol-memory-list');
    if (!container) return;

    const memories = getMemories();
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

        // 事件绑定
        card.querySelector('.rol-mem-toggle').addEventListener('change', (e) => {
            updateMemory(mem.id, { enabled: e.target.checked });
            card.classList.toggle('rol-disabled', !e.target.checked);
        });

        card.querySelector('.rol-btn-edit').addEventListener('click', () => openEditor(mem.id));

        card.querySelector('.rol-btn-rewrite').addEventListener('click', async () => {
            showToast('正在重写...');
            const result = await rewriteMemory(mem.id, mem);
            if (result) {
                showToast('重写完成！');
                renderMemoryList(filter);
            } else {
                showToast('重写失败 :(');
            }
        });

        card.querySelector('.rol-btn-delete').addEventListener('click', () => {
            if (confirm('确定删除这条记忆？')) {
                deleteMemory(mem.id);
                renderMemoryList(filter);
            }
        });

        container.appendChild(card);
    }
}

// 编辑器面板
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
            const mem = getMemories().find(m => m.id === currentEditId);
            if (mem && mem.versions[idx]) {
                document.getElementById('rol-editor-content').value = mem.versions[idx].content;
            }
        });
    }
}

// 打开编辑器
function openEditor(memId) {
    currentEditId = memId;
    const panel = document.getElementById('rol-editor-panel');
    if (!panel) return;

    panel.classList.add('rol-active');

    if (memId) {
        const mem = getMemories().find(m => m.id === memId);
        if (!mem) return;

        document.getElementById('rol-editor-title').value = mem.title;
        document.getElementById('rol-editor-triggers').value = mem.triggers.join(', ');
        document.getElementById('rol-editor-tags').value = mem.tags.join(', ');
        document.getElementById('rol-editor-mood').value = mem.mood || '';
        document.getElementById('rol-editor-content').value = mem.content;

        // 渲染版本选择
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
        // 新建模式
        document.getElementById('rol-editor-title').value = '';
        document.getElementById('rol-editor-triggers').value = '';
        document.getElementById('rol-editor-tags').value = '';
        document.getElementById('rol-editor-mood').value = '';
        document.getElementById('rol-editor-content').value = '';
        const versionSelect = document.getElementById('rol-version-select');
        if (versionSelect) versionSelect.parentElement.style.display = 'none';
    }
}

// 保存编辑
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
        updateMemory(currentEditId, { title, triggers, tags, mood, content });
    } else {
        addMemory({ title, triggers, tags, mood, content });
    }

    closeEditor();
    renderMemoryList();
    showToast(currentEditId ? '已更新！' : '已添加！');
}

// 关闭编辑器
function closeEditor() {
    currentEditId = null;
    const panel = document.getElementById('rol-editor-panel');
    if (panel) panel.classList.remove('rol-active');
}

// 移动端导航
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

// Toast提示
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

// HTML转义
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export { initUI, renderMemoryList, renderPresetOptions, showToast };
