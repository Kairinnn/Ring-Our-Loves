
import { extension_settings } from '../../../extensions.js';
import { getContext } from '../../../extensions.js';
import { initSettings, getConfig } from './modules/storage.js';
import { setupTriggerListener, buildInjectionText, selectForInjection, detectTriggers } from './modules/trigger.js';
import { initUI, renderMemoryList, showToast } from './modules/ui-controller.js';

const extensionName = 'RingOurLuv';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

// 注入记忆到聊天上下文
function injectMemoryToContext(memories, injectionText) {
    if (!injectionText) return;

    const context = getContext();
    // 使用 setExtensionPrompt 注入到上下文
    if (context.setExtensionPrompt) {
        context.setExtensionPrompt(extensionName, injectionText, 1, 0);
        console.log(`[RingOurLuv] 注入了 ${memories.length} 条记忆`);
    }
}

// 加载HTML面板
async function loadPanel() {
    const response = await fetch(`${extensionFolderPath}/index.html`);
    if (!response.ok) return '';
    return await response.text();
}

// 主入口
jQuery(async () => {
    // 初始化设置
    initSettings();

    // 加载UI
    const panelHtml = await loadPanel();
    if (panelHtml) {
        $('#extensions_settings2').append(panelHtml);
    }

    // 初始化UI事件
    initUI();

    // 设置触发词监听
    setupTriggerListener(injectMemoryToContext);

    // 监听聊天切换，重新扫描
    const context = getContext();
    if (context.eventSource) {
        context.eventSource.on('chatLoaded', () => {
            renderMemoryList();
        });
    }

    console.log(`[RingOurLuv] 插件加载完成 ✨`);
});
