
import { getContext } from '../../../../extensions.js';
import { getMemories, getConfig } from './storage.js';

// 检测消息中的触发词
function detectTriggers(messageText) {
    const memories = getMemories();
    const matched = [];

    for (const memory of memories) {
        if (!memory.enabled) continue;

        for (const trigger of memory.triggers) {
            if (!trigger) continue;
            // 支持正则和普通文本
            let isMatch = false;
            if (trigger.startsWith('/') && trigger.endsWith('/')) {
                try {
                    const regex = new RegExp(trigger.slice(1, -1), 'i');
                    isMatch = regex.test(messageText);
                } catch (e) {
                    // 正则无效，降级为普通匹配
                    isMatch = messageText.toLowerCase().includes(trigger.toLowerCase());
                }
            } else {
                isMatch = messageText.toLowerCase().includes(trigger.toLowerCase());
            }

            if (isMatch) {
                matched.push(memory);
                break; // 同一条记忆只匹配一次
            }
        }
    }

    return matched;
}

// 从匹配结果中选取要注入的记忆（按配置限制数量）
function selectForInjection(matchedMemories) {
    const config = getConfig();
    const maxCount = config.maxInjectCount || 3;
    return matchedMemories.slice(0, maxCount);
}

// 构建注入文本
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

// 监听新消息并执行触发检测
function setupTriggerListener(onTriggered) {
    const context = getContext();

    // 使用eventSource监听消息
    const eventSource = context.eventSource;
    if (!eventSource) return;

    // 监听消息接收事件
    eventSource.on('message_received', (msgIndex) => {
        const config = getConfig();
        if (!config.autoInject) return;

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
    });

    // 也监听用户发送的消息
    eventSource.on('message_sent', (msgIndex) => {
        const config = getConfig();
        if (!config.autoInject) return;

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
    });
}

// 手动检测当前聊天最后N条消息
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

export {
    detectTriggers,
    selectForInjection,
    buildInjectionText,
    setupTriggerListener,
    scanRecentMessages
};
