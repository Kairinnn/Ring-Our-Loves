// 🍊 防缓存壳 · loader.js —— 本文件内容【永不改动】！
// ─────────────────────────────────────────────────────────────
// 背景：ST 走 HTTP 明文，传输路上有一层「服务器端透明缓存」（云边缘/ISP），
// 它按【完整URL】把 .js / .css 锁住喂旧版，连 no-store/硬刷新/无痕都救不动，
// 害得改了代码死活不生效（详见仓库「疑难杂症手册.md」第一章）。
//
// 思路：缓存认完整URL，那就每次加载都给真文件拼一个随机参数 → 永远是它没见过的新URL
//       → 缓存查无此条 → 只能去磁盘拿最新版。于是 core.js / style-core.css 永远新鲜。
//
// 好处：以后改代码【只改 core.js / style-core.css】，再也不用手动改文件名！
//       本壳(loader.js / loader.css)内容固定不变，就算被缓存住也无所谓（旧==新）。
// ─────────────────────────────────────────────────────────────

const ROL_BASE = 'scripts/extensions/third-party/Ring_Our_Luv/';
const ROL_BUST = `?v=${Date.now()}_${Math.random().toString(36).slice(2)}`;

// ❤︎ 动态注入真·样式（带随机参数，绕开缓存永远新鲜）❤︎
const rolLink = document.createElement('link');
rolLink.rel = 'stylesheet';
rolLink.href = ROL_BASE + 'style-core.css' + ROL_BUST;
document.head.appendChild(rolLink);

// ❤︎ 动态载入真·代码（带随机参数，绕开缓存永远新鲜）❤︎
import('./core.js' + ROL_BUST).catch(e =>
    console.error('[RingOurLuv] 🍊 防缓存壳加载 core.js 失败：', e)
);
