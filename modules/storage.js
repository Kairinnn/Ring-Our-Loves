
import { extension_settings, saveSettingsDebounced } from '../../../../extensions.js';

const extensionName = 'RingOurLuv';

// 初始化默认设置
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

// 获取所有记忆
function getMemories() {
    return extension_settings[extensionName]?.memories || [];
}

// 生成唯一ID
function generateId() {
    return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// 添加记忆
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

// 更新记忆
function updateMemory(id, updates) {
    const settings = extension_settings[extensionName];
    const index = settings.memories.findIndex(m => m.id === id);
    if (index === -1) return null;

    const memory = settings.memories[index];

    // 如果content变了，添加新版本
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

// 删除记忆
function deleteMemory(id) {
    const settings = extension_settings[extensionName];
    settings.memories = settings.memories.filter(m => m.id !== id);
    saveSettingsDebounced();
}

// 添加重写版本
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

// 回滚到指定版本
function rollbackVersion(id, versionIndex) {
    const settings = extension_settings[extensionName];
    const memory = settings.memories.find(m => m.id === id);
    if (!memory || !memory.versions[versionIndex]) return null;

    memory.content = memory.versions[versionIndex].content;
    saveSettingsDebounced();
    return memory;
}

// 获取配置
function getConfig() {
    return extension_settings[extensionName]?.config || {};
}

// 更新配置
function updateConfig(configUpdates) {
    const settings = extension_settings[extensionName];
    Object.assign(settings.config, configUpdates);
    saveSettingsDebounced();
}

export {
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
