import { extension_settings, getContext } from '../../../extensions.js';

const extensionName = 'RingOurLuv';

jQuery(async () => {
    console.log('[RingOurLuv] ✅ 基础加载成功！');

    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = { test: true };
    }
    console.log('[RingOurLuv] settings:', extension_settings[extensionName]);
});
import { extension_settings, getContext, saveSettingsDebounced } from '../../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../../slash-commands.js';
import { getPresetManager } from '../../../../script.js';
import { eventSource, event_types } from '../../../../script.js';
