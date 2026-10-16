/* global chrome */
// noinspection JSDeprecatedSymbols

'use strict';

/* ============================================================
 * Minimal New Tab — newtab.js
 * ------------------------------------------------------------
 * 新标签页的核心逻辑：
 *   - 通过 chrome.bookmarks 读取书签栏
 *   - 每个文件夹渲染成一张图标卡片
 *   - 支持折叠（15 个）和展开（31 个）
 *   - 跟随系统深浅色模式
 *   - 整体缩放内容，保证永不出现滚动条
 *
 * 性能取向：
 *   - el.hidden / classList 等原生属性访问（比 setAttribute 快）
 *   - DocumentFragment 批量插入 DOM（只触发一次 reflow）
 *   - for 循环代替 forEach（避免每次迭代的函数调用开销）
 * ============================================================ */


/* ------------------------------------------------------------
 * 常量
 * ---------------------------------------------------------- */

/** 深色模式下的背景色。 */
const BG_DARK = '#3C3C3C';

/** 浅色模式下的背景色。 */
const BG_LIGHT = '#FFFFFF';

/** 文件夹折叠时最多显示的书签数。 */
const COLLAPSED_MAX = 15;

/**
 * 文件夹展开时最多显示的书签数。
 * 31 个书签 + 1 个 "×" 按钮 = 32 格，恰好 4 行（每行 8 个），
 * 保证切换按钮不会单独占一行。
 */
const EXPANDED_MAX = 31;

/** 持久化设置的默认值，与 storage 里的内容合并使用。 */
const DEFAULTS = {showBookmarks: false};


/* ------------------------------------------------------------
 * DOM 引用
 * ---------------------------------------------------------- */
const content = document.getElementById('content');
const panel = document.getElementById('panel');
const gear = document.getElementById('gear');
const toggle = document.getElementById('toggleBookmarks');
const stage = document.getElementById('stage');


/* ------------------------------------------------------------
 * 运行时状态
 * ---------------------------------------------------------- */
let settings = {...DEFAULTS};

/**
 * 追踪每张卡片正在进行的展开/收起动画。快速连点同一张卡片时，
 * 需要用上一次的取消函数把上一次的 rAF / 定时器 / 监听器清理掉，
 * 否则上一次的 transitionend 会干扰本次动画。
 */
const pendingAnimations = new WeakMap();  // folder -> cancel 函数


/* ------------------------------------------------------------
 * 设置的读写
 * ---------------------------------------------------------- */

/** 从 chrome.storage.local 读取设置。 */
const loadSettings = () => new Promise(resolve => chrome.storage.local.get(DEFAULTS, resolve));

/** 写入部分设置字段。 */
const saveSettings = patch => new Promise(resolve => chrome.storage.local.set(patch, resolve));


/* ------------------------------------------------------------
 * 深浅色模式
 * ---------------------------------------------------------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const systemIsDark = () => darkQuery.matches;

/**
 * 把 "#RGB" 或 "#RRGGBB" 格式的十六进制颜色
 * 解析成 [r, g, b] 数组。只在内部用已知合法的输入。
 */
function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const s = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
}

/**
 * 判断一个颜色在视觉上是否偏暗。
 * 使用 ITU-R BT.601 相对亮度公式。
 */
function isDark(hex) {
    const [r, g, b] = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/**
 * 应用当前背景色以及所有派生的 CSS 变量。
 * 在以下三种时机调用：
 *   - 启动时（apply 里）
 *   - 系统深浅色切换时（onSchemeChange）
 *   - 书签开关切换时（toggle change → apply）
 */
function applyBg() {
    const hex = systemIsDark() ? BG_DARK : BG_LIGHT;
    const dark = isDark(hex);
    const root = document.documentElement;

    root.style.setProperty('--bg', hex);
    root.style.setProperty('--fg', dark ? '#eaeaf0' : '#202124');
    root.style.setProperty('--fg-muted', dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.5)');
    root.style.setProperty('--card-bg', dark ? 'rgba(255,255,255,.04)' : 'rgba(0,0,0,.03)');
    root.style.setProperty('--card-border', dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)');
    root.style.setProperty('--item-hover', dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.06)');
    root.style.setProperty('--panel-bg', dark ? 'rgba(36,36,38,.78)' : 'rgba(255,255,255,.78)');
    root.style.setProperty('--panel-border', dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)');
    root.style.setProperty('--panel-shadow', dark ? '0 24px 60px rgba(0,0,0,.55)' : '0 24px 60px rgba(0,0,0,.18)');
    root.style.setProperty('--switch-bg', dark ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.15)');

    // 让原生控件（滚动条、表单控件等）切换到匹配风格
    root.style.colorScheme = dark ? 'dark' : 'light';
}


/* ------------------------------------------------------------
 * 图标（favicon）获取
 * ------------------------------------------------------------
 * 三级回退：
 *   1. Chrome 本地图标缓存 —— 快，不走网络
 *   2. Google 公开图标服务 —— 覆盖本地没缓存到的站点
 *   3. 一个灰色的 SVG 占位图
 * ---------------------------------------------------------- */

/** Chrome 本地缓存的图标地址。 */
function localFaviconUrl(pageUrl, size = 64) {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', pageUrl);
    u.searchParams.set('size', String(size));
    return u.toString();
}

/** Google 公开图标服务地址。 */
function remoteFaviconUrl(pageUrl, size = 64) {
    let host = '';
    try {
        host = new URL(pageUrl).hostname;
    } catch { /* URL 不合法 */
    }

    const u = new URL('https://www.google.com/s2/favicons');
    u.searchParams.set('domain', host);
    u.searchParams.set('sz', String(size));
    return u.toString();
}

/** 无法获取图标时使用的内联 SVG 占位图。 */
const FALLBACK_FAVICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
     <rect width="32" height="32" rx="8" fill="#8a8f99"/>
   </svg>`);


/* ------------------------------------------------------------
 * 读取书签
 * ---------------------------------------------------------- */

/**
 * 读取书签栏，按文件夹分组返回。
 *
 * 返回：
 *   {
 *     loose:  Array<BookmarkTreeNode> | null,
 *     groups: Array<Array<BookmarkTreeNode>>
 *   }
 *
 * 说明：
 *   - loose 是直接放在书签栏上、没有放进任何文件夹的书签。
 *   - 嵌套文件夹会被拍平：某个顶层文件夹下的所有后代书签
 *     都会归到这个顶层文件夹的书签列表里。
 */
function collectGroups() {
    return new Promise(resolve => {
        chrome.bookmarks.getTree(tree => {
            // id 为 "1" 的节点永远是书签栏
            const bar = tree[0]?.children?.find(n => n.id === '1');
            const nodes = bar?.children || [];

            const groups = [];
            const looseItems = [];

            /** 递归收集一个文件夹节点下所有书签。 */
            const flatten = folder => {
                const out = [];
                const walk = ns => {
                    if (!ns) return;
                    for (let i = 0; i < ns.length; i++) {
                        const n = ns[i];
                        if (n.url) out.push(n); else if (n.children) walk(n.children);
                    }
                };
                walk(folder.children);
                return out;
            };

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];
                if (node.url) {
                    looseItems.push(node);
                } else if (node.children) {
                    const items = flatten(node);
                    if (items.length) groups.push(items);
                }
            }

            resolve({
                loose: looseItems.length ? looseItems : null, groups
            });
        });
    });
}


/* ------------------------------------------------------------
 * 渲染
 * ---------------------------------------------------------- */

/**
 * 创建一个书签 <a> 元素，附带一个懒加载的 favicon。
 * <a> 的 title 属性提供了无障碍名称；图标本身标记为装饰性。
 */
function makeItem(bm) {
    const a = document.createElement('a');
    a.className = 'item';
    a.href = bm.url;
    a.title = bm.title || bm.url;
    a.draggable = false;

    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = localFaviconUrl(bm.url, 64);

    // 错误回退状态机：
    //   0 → 尝试用远程图标服务
    //   1 → 换成内联占位图
    //   2 → 放弃（占位图已经显示）
    let attempt = 0;
    img.addEventListener('error', () => {
        if (attempt === 0) {
            attempt = 1;
            img.src = remoteFaviconUrl(bm.url, 64);
        } else if (attempt === 1) {
            attempt = 2;
            img.src = FALLBACK_FAVICON;
        }
    });

    a.appendChild(img);
    return a;
}

/**
 * 把折叠 / 展开状态应用到某个文件夹网格上，不做动画。
 * 只是纯粹地切换 .collapsed 类，可以在测量阶段或首次
 * 渲染时安全调用。
 *
 * 性能：
 *   - 用 for 循环代替 forEach
 *   - 用 classList.toggle(name, force) 一步到位，避免分支
 */
function applyExpanded(grid, expanded) {
    const items = grid.querySelectorAll('a.item');
    const btn = grid.querySelector('button.more');
    const hint = grid.querySelector('.more-hint');
    const total = items.length;

    if (total <= COLLAPSED_MAX) {
        // 书签很少，不需要切换按钮
        for (let i = 0; i < total; i++) {
            items[i].classList.remove('collapsed');
        }
        btn.classList.add('collapsed');
        hint.hidden = true;
        return;
    }

    // 阈值：折叠时是 COLLAPSED_MAX，展开时是 EXPANDED_MAX
    const limit = expanded ? EXPANDED_MAX : COLLAPSED_MAX;

    for (let i = 0; i < total; i++) {
        items[i].classList.toggle('collapsed', i >= limit);
    }

    btn.classList.remove('collapsed');

    if (expanded) {
        btn.textContent = '×';

        const hidden = total - EXPANDED_MAX;
        if (hidden > 0) {
            hint.textContent = `+${hidden} more`;
            hint.hidden = false;
        } else {
            hint.hidden = true;
        }
    } else {
        btn.textContent = `+${total - COLLAPSED_MAX}`;
        hint.hidden = true;
    }

    grid.dataset.expanded = expanded ? '1' : '0';
}

/**
 * 在折叠 / 展开状态之间切换，可选动画。
 *
 * 动画分四步实现：
 *   1. 冻结当前高度；
 *   2. 临时禁用过渡，测出目标高度；
 *   3. 恢复到起始状态；
 *   4. 下一帧重新启用过渡并启动动画。
 *
 * 用一个超时作为兜底：防止高度没变化时 transitionend
 * 不触发，导致内联 height 卡在固定值上。过渡结束后重新
 * 执行 fitContent，因为整体布局可能已经改变。
 *
 * 同张卡片上重复调用会先取消上一次的动画回调，避免两次
 * 动画的 transitionend 互相干扰。
 */
function setExpanded(grid, expanded, animate = true) {
    const folder = grid.closest('.folder');
    if (!folder) return;

    // 如果同一张卡片上一次动画还没结束，先取消它的回调
    const prevCancel = pendingAnimations.get(folder);
    if (prevCancel) prevCancel();

    // 不需要动画（首次渲染）：直接应用状态
    if (!animate) {
        applyExpanded(grid, expanded);
        folder.style.height = '';
        return;
    }

    const startHeight = folder.offsetHeight;

    // 1. 冻结起始高度，并禁用所有过渡，保证测量准确
    folder.style.height = startHeight + 'px';
    folder.classList.add('no-anim');

    // 2. 测量目标高度
    applyExpanded(grid, expanded);
    folder.style.height = 'auto';
    const endHeight = folder.offsetHeight;

    // 3. 恢复到起始状态
    applyExpanded(grid, !expanded);
    folder.style.height = startHeight + 'px';

    // 强制重排，让浏览器把冻结的高度当作过渡的起点
    void folder.offsetHeight;

    // 4. 重新启用过渡，在下一帧开始动画
    folder.classList.remove('no-anim');

    let rafId = null;
    let guard = null;
    let onEnd = null;

    const cancel = () => {
        if (rafId) cancelAnimationFrame(rafId);
        if (guard) clearTimeout(guard);
        if (onEnd) folder.removeEventListener('transitionend', onEnd);
    };

    const finish = () => {
        cancel();
        pendingAnimations.delete(folder);
        folder.style.height = '';
        fitContent();
    };

    onEnd = e => {
        if (e.propertyName === 'height') finish();
    };

    rafId = requestAnimationFrame(() => {
        rafId = null;
        applyExpanded(grid, expanded);
        folder.style.height = endHeight + 'px';
    });

    pendingAnimations.set(folder, cancel);

    // 兜底超时：比 300ms 的过渡稍长一点
    guard = setTimeout(finish, 400);
    folder.addEventListener('transitionend', onEnd);
}

/**
 * 向文件夹网格里填充所有书签、"+N" 切换按钮、以及一个隐藏
 * 的溢出提示。绑定按钮点击事件，并设置初始折叠状态。
 *
 * 性能：所有节点先加入 DocumentFragment，最后一次性 append，
 * 避免每本书签一次 reflow。
 */
function setupFolder(grid, items) {
    const frag = document.createDocumentFragment();

    for (let i = 0; i < items.length; i++) {
        frag.appendChild(makeItem(items[i]));
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'item more';
    frag.appendChild(btn);

    const hint = document.createElement('div');
    hint.className = 'more-hint';
    hint.hidden = true;
    frag.appendChild(hint);

    // 一次性插入
    grid.appendChild(frag);

    btn.addEventListener('click', e => {
        e.preventDefault();

        if (items.length <= COLLAPSED_MAX) return;

        const expanded = grid.dataset.expanded === '1';
        setExpanded(grid, !expanded, true);
    });

    // 首次渲染不做动画
    setExpanded(grid, false, false);
}

/** 根据一组书签创建一张文件夹卡片。 */
function makeFolder(items, order) {
    const section = document.createElement('section');
    section.className = 'folder';
    // 按顺序错开入场动画，产生层叠效果
    section.style.animationDelay = `${order * 55}ms`;

    const grid = document.createElement('div');
    grid.className = 'folder-items';
    section.appendChild(grid);

    setupFolder(grid, items);
    return section;
}

/** 把所有书签卡片渲染到 content 容器里。 */
async function renderBookmarks() {
    // 书签开关可能已在防抖等待期间被关掉，此时直接跳过
    if (!settings.showBookmarks) return;

    const {loose, groups} = await collectGroups();

    const frag = document.createDocumentFragment();
    let order = 0;

    if (loose) frag.appendChild(makeFolder(loose, order++));
    for (let i = 0; i < groups.length; i++) {
        frag.appendChild(makeFolder(groups[i], order++));
    }

    // 一次性替换全部内容：清空 + 插入，只触发一次 reflow
    content.textContent = '';
    content.appendChild(frag);

    // 等布局稳定后再测量尺寸
    requestAnimationFrame(fitContent);
}


/* ------------------------------------------------------------
 * 视口适配
 * ------------------------------------------------------------
 * 用 zoom 缩放整个 content 块，保证它永远装得下舞台，
 * 这样页面就永远不会出现滚动条。
 * ---------------------------------------------------------- */

function fitContent() {
    const el = content;
    if (!el || el.hidden || !el.children.length) {
        el.style.zoom = '';
        return;
    }

    // 先重置 zoom，量出真实尺寸
    el.style.zoom = '1';

    const stageStyle = getComputedStyle(stage);
    const padY = parseFloat(stageStyle.paddingTop) + parseFloat(stageStyle.paddingBottom);
    const maxH = stage.clientHeight - padY;

    const h = el.offsetHeight;
    if (h > maxH && maxH > 0) {
        // 最小缩放到 0.5，保证文字仍然可读
        const scale = Math.max(0.5, maxH / h);
        el.style.zoom = scale.toFixed(3);
    }
}


/* ------------------------------------------------------------
 * 设置 → UI
 * ---------------------------------------------------------- */

/** 把当前设置应用到界面上。 */
async function apply() {
    toggle.checked = settings.showBookmarks;
    applyBg();

    if (settings.showBookmarks) {
        content.hidden = false;
        await renderBookmarks();
    } else {
        content.hidden = true;
        content.textContent = '';
        content.style.zoom = '';
    }
}


/* ------------------------------------------------------------
 * 启动
 * ---------------------------------------------------------- */

(async () => {
    settings = await loadSettings();
    await apply();

    // 书签显示开关
    toggle.addEventListener('change', async () => {
        settings.showBookmarks = toggle.checked;
        await saveSettings({showBookmarks: settings.showBookmarks});
        await apply();
    });

    // 跟随系统深浅色切换
    const onSchemeChange = () => applyBg();
    if (darkQuery.addEventListener) {
        darkQuery.addEventListener('change', onSchemeChange);
    } else {
        darkQuery.addListener(onSchemeChange);   // 老版本浏览器
    }

    // 窗口大小变化后重新适配布局（防抖）
    let resizeTimer = null;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(fitContent, 120);
    });

    // 设置弹窗开关
    gear.addEventListener('click', () => {
        const willOpen = panel.hidden === true;
        panel.hidden = !willOpen;
        gear.classList.toggle('open', willOpen);
    });

    // 点击弹窗外部时关闭
    document.addEventListener('click', e => {
        if (panel.hidden) return;
        if (panel.contains(e.target) || gear.contains(e.target)) return;
        panel.hidden = true;
        gear.classList.remove('open');
    });

    // 按 Escape 关闭弹窗
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !panel.hidden) {
            panel.hidden = true;
            gear.classList.remove('open');
        }
    });

    // 书签变化时重新渲染（防抖）
    let bookmarkTimer = null;
    const refresh = () => {
        if (!settings.showBookmarks) return;
        clearTimeout(bookmarkTimer);
        bookmarkTimer = setTimeout(renderBookmarks, 400);
    };

    // 四个书签事件都走同一个防抖刷新
    const bookmarkEvents = [chrome.bookmarks.onCreated, chrome.bookmarks.onRemoved, chrome.bookmarks.onChanged, chrome.bookmarks.onMoved,];
    for (let i = 0; i < bookmarkEvents.length; i++) {
        bookmarkEvents[i].addListener(refresh);
    }
})();