
import { getPresetManager } from '../../../../script.js';
import { executeSlashCommandsWithOptions } from '../../../../slash-commands.js';
import { getContext } from '../../../../extensions.js';
import { getConfig, addRewriteVersion } from './storage.js';

// 切换预设（用于生成时临时切换）
async function switchPreset(presetName) {
    if (!presetName) return false;
    try {
        const presetManager = getPresetManager();
        if (presetManager) {
            await presetManager.selectPreset(presetName);
            return true;
        }
    } catch (e) {
        console.error('[RingOurLuv] 切换预设失败:', e);
    }
    return false;
}

// 获取当前预设名（用于还原）
function getCurrentPresetName() {
    try {
        const presetManager = getPresetManager();
        return presetManager?.getSelectedPreset?.() || '';
    } catch (e) {
        return '';
    }
}

// 获取可用预设列表
function getAvailablePresets() {
    try {
        const presetManager = getPresetManager();
        return presetManager?.getPresets?.() || [];
    } catch (e) {
        return [];
    }
}

// 使用插件指定预设执行生成
async function generateWithPreset(prompt) {
    const config = getConfig();
    const targetPreset = config.presetName;
    let originalPreset = '';

    try {
        // 如果配置了专用预设，先切换
        if (targetPreset) {
            originalPreset = getCurrentPresetName();
            await switchPreset(targetPreset);
        }

        // 执行生成
        const result = await executeSlashCommandsWithOptions('/gen ' + prompt, {
            handleExecutionErrors: true,
            handleParserErrors: true
        });

        return result?.pipe || '';
    } catch (e) {
        console.error('[RingOurLuv] 生成失败:', e);
        return '';
    } finally {
        // 还原预设
        if (originalPreset && targetPreset) {
            await switchPreset(originalPreset);
        }
    }
}

// 重写记忆内容
async function rewriteMemory(memoryId, memory) {
    const config = getConfig();
    const prompt = (config.summaryPrompt || '请重新总结以下记忆内容，使其更精炼：\n{{context}}')
        .replace('{{context}}', memory.content);

    const newContent = await generateWithPreset(prompt);
    if (!newContent) return null;

    return addRewriteVersion(memoryId, newContent.trim());
}

// 从聊天上下文生成新记忆
async function generateMemoryFromContext(startIndex, endIndex) {
    const context = getContext();
    const chat = context.chat || [];

    // 提取指定范围的对话
    const slice = chat.slice(startIndex, endIndex + 1);
    const contextText = slice.map(msg => {
        const role = msg.is_user ? 'User' : 'Char';
        return `${role}: ${msg.mes}`;
    }).join('\n');

    const config = getConfig();
    const prompt = (config.summaryPrompt || '请将以下对话片段总结为一条简短的记忆：\n{{context}}')
        .replace('{{context}}', contextText);

    const result = await generateWithPreset(prompt);
    return result?.trim() || '';
}

export {
    switchPreset,
    getCurrentPresetName,
    getAvailablePresets,
    generateWithPreset,
    rewriteMemory,
    generateMemoryFromContext
};
