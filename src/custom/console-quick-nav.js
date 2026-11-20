const quickDialog = $('console-quick-dialog');
const quickQuery = $('console-quick-query');
const quickResults = $('console-quick-results');
let quickEntries = [];
let quickIndex = 0;
let quickConfigAccount;

function quickNavigationEntries(includeContent) {
  const entries = [];
  const nav = id => document.querySelector('#tabs [data-tab="' + id + '"]');
  const aliases = { overview: '总览 资源田 城池 地图', settings: '挂机配置 历史配置 导入 导出',
    manual: '工厂 生产 建筑 农田', lineups: '舰队 预设 编队', account: '登录 账号 微信 支付宝 手机号',
    activities: '活动 奖励', stages: '试炼 海盗 关卡', inventory: '仓库 背包 库存' };
  for (const button of document.querySelectorAll('#tabs [data-tab]')) {
    entries.push({ label: button.getAttribute('aria-label') || button.textContent.trim(), context: '页面',
      keywords: aliases[button.dataset.tab], icon: button.querySelector('svg'), open: () => {
        activateConsolePage(button);
        return () => document.querySelector('main > section:not(.hidden)');
      } });
  }
  for (const button of document.querySelectorAll('[data-resource-tab]')) {
    entries.push({ label: button.textContent.trim(), context: '杂项',
      keywords: button.dataset.resourceTab === 'giftcodes' ? '礼包码 兑换 兑换码 抓取 渠道' : '',
      icon: nav('resources').querySelector('svg'), open: () => {
        activateConsolePage(nav('resources'), button.dataset.resourceTab);
        return () => $('tab-' + button.dataset.resourceTab);
      } });
  }
  for (const button of document.querySelectorAll('[data-bag-tab]')) {
    entries.push({ label: button.textContent.trim(), context: '背包',
      keywords: button.dataset.bagTab === 'antiques' ? '套装 藏品大师' : '',
      icon: button.querySelector('svg'), open: () => {
        activateConsolePage(nav('inventory')); button.click();
        return () => $('bag-' + button.dataset.bagTab);
      } });
  }
  for (const button of document.querySelectorAll('[data-config-tab]')) {
    entries.push({ label: button.textContent.trim(), context: '挂机配置',
      keywords: button.dataset.configTab === 'base' ? '工厂 农田' : undefined,
      icon: nav('settings').querySelector('svg'), open: () => {
        activateConsolePage(nav('settings')); button.click();
        return () => $(button.getAttribute('aria-controls')) || button;
      } });
  }
  if (includeContent) entries.push(...quickContentEntries(nav));
  return entries;
}

function quickContentEntries(nav) {
  const entries = [];
  const targets = 'h2,h3,h4,[data-slot="card-title"],button,label,summary,legend,p,th,[data-bag-name]';
  const skip = 'dialog,template,[aria-hidden="true"],.sr-only,.help-popover,[role="status"],[role="alert"]';
  const seen = new Set();
  for (const page of document.querySelectorAll('main > section[id^="tab-"]')) {
    const key = page.id.slice(4);
    const resource = document.querySelector('[data-resource-tab="' + CSS.escape(key) + '"]');
    const main = nav(resource ? 'resources' : key);
    if (!main) continue;
    const tabsByPanel = new Map();
    for (const tab of page.querySelectorAll('[role="tab"][aria-controls]')) {
      const id = tab.getAttribute('aria-controls');
      tabsByPanel.set(id, tabsByPanel.has(id) ? null : tab);
    }
    for (const node of page.querySelectorAll(targets)) {
      const bagItem = node.closest('[data-bag-name]');
      if (node.closest(skip) || node.matches('[role="tab"],[data-bag-tab]') || (bagItem && bagItem !== node)) continue;
      const bag = key === 'inventory' && node.closest('#bag-items,#bag-heroes,#bag-antiques');
      const group = key === 'settings' && node.closest('.config-section');
      if (group && configEditor.owner !== current) continue;
      const activityPanel = key === 'activities' && node.closest('#activity-panel');
      const activity = activityPanel ? page.querySelector('[data-activity][aria-selected="true"]') : null;
      if (activityPanel && !activity) continue;
      const config = group && group.closest('[data-config-panel]');
      const panels = [];
      let available = true;
      for (let parent = node; parent !== page; parent = parent.parentElement) {
        if (parent === bag || parent === group || parent === config || parent === activityPanel) continue;
        const tab = tabsByPanel.get(parent.id);
        if (tab) panels.unshift(tab);
        else if (parent.hidden || parent.classList.contains('hidden')) { available = false; break; }
      }
      if (!available) continue;
      const bagTab = bag && page.querySelector('[data-bag-tab="' + bag.id.slice(4) + '"]');
      const groupId = group && group.id.slice('config-group-'.length);
      const paneNames = [resource?.textContent, bagTab?.textContent,
        config && $('config-tab-' + config.dataset.configPanel)?.textContent,
        groupId && configEditor.groups.get(groupId)?.title,
        activity?.querySelector('.activity-tab-name')?.textContent, ...panels.map(tab => tab.textContent)];
      const context = [main.getAttribute('aria-label'), ...paneNames.filter(Boolean)].map(value => value.trim()).join(' › ');
      const label = node.matches('[data-bag-name]') ? node.querySelector('strong,h3,h4')?.textContent || node.dataset.bagName :
        (node.getAttribute('aria-label') || [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE ||
          child.nodeType === Node.ELEMENT_NODE && !child.matches(skip + ',svg,button')).map(child => child.textContent).join(''));
      const title = label.replace(/\s+/gu, ' ').trim();
      const signature = context + '|' + title;
      if (title.length < 2 || seen.has(signature)) continue;
      seen.add(signature);
      entries.push({ label: title, context, icon: main.querySelector('svg'), open: () => {
        activateConsolePage(main, resource?.dataset.resourceTab);
        if (bagTab && bagTab.getAttribute('aria-selected') !== 'true') bagTab.click();
        if (groupId) {
          configActivate(config.dataset.configPanel);
          configActivateGroup(groupId);
        }
        if (activity) selectActivity(activity.dataset.activity);
        for (const tab of panels) {
          if (tab.getAttribute('aria-selected') !== 'true') tab.click();
        }
        return () => (node.isConnected ? node : node.id && $(node.id)) || page;
      } });
    }
    if (key === 'activities') {
      for (const tab of page.querySelectorAll('[data-activity]')) {
        entries.push({ label: tab.querySelector('.activity-tab-name').textContent, context: '活动',
          icon: main.querySelector('svg'), open: () => {
            activateConsolePage(main);
            selectActivity(tab.dataset.activity);
            return () => $('activity-panel');
          } });
      }
    }
  }
  return entries;
}

let quickHighlight;
let quickHighlightTimer;

function chooseQuickEntry(index) {
  const entry = quickEntries[index];
  if (!entry) return;
  quickDialog.close();
  const resolve = entry.open();
  requestAnimationFrame(() => {
    const target = resolve();
    if (!target?.isConnected) return;
    for (let parent = target.parentElement; parent; parent = parent.parentElement) {
      if (parent.matches('details:not([open])') && parent.querySelector(':scope > summary') !== target) parent.open = true;
    }
    const location = target.closest('.config-row') || target;
    const destination = location.getClientRects().length ? location : document.querySelector('main > section:not(.hidden)');
    if (!destination) return;
    quickHighlight?.classList.remove('console-quick-highlight');
    clearTimeout(quickHighlightTimer);
    quickHighlight = destination;
    destination.classList.add('console-quick-highlight');
    quickHighlightTimer = setTimeout(() => destination.classList.remove('console-quick-highlight'), 2200);
    if (!destination.matches('button,input,select,a[href],[tabindex]')) {
      destination.tabIndex = -1;
      destination.addEventListener('blur', () => destination.removeAttribute('tabindex'), { once: true });
    }
    destination.focus({ preventScroll: true });
    const stickyHeader = window.innerWidth > 768 ? document.querySelector('body > header').getBoundingClientRect().height : 0;
    const reducedMotion = document.documentElement.dataset.motion === 'off' || matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: window.scrollY + destination.getBoundingClientRect().top - stickyHeader - 16,
      behavior: reducedMotion ? 'instant' : 'smooth' });
  });
}

function paintQuickSelection(scroll = false) {
  const rows = [...quickResults.children];
  for (const [index, row] of rows.entries()) row.setAttribute('aria-selected', String(index === quickIndex));
  const active = rows[quickIndex];
  if (active) {
    quickQuery.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  } else quickQuery.removeAttribute('aria-activedescendant');
}

function renderQuickNavigation() {
  const normalize = value => value.normalize('NFKC').trim().toLocaleLowerCase();
  const query = normalize(quickQuery.value);
  if (query && current && configEditor.owner !== current && quickConfigAccount !== current && !configEditor.loading) {
    quickConfigAccount = current;
    void configLoad().then(() => {
      if (quickDialog.open && configEditor.owner === current) renderQuickNavigation();
    });
  }
  const words = query.split(/\s+/u).filter(Boolean);
  quickEntries = quickNavigationEntries(Boolean(query)).flatMap(entry => {
    const label = normalize(entry.label);
    const text = normalize([entry.label, entry.context, entry.keywords].join(' '));
    if (!words.every(word => text.includes(word))) return [];
    const score = label === query ? 0 : label.startsWith(query) ? 1 :
      label.includes(query) ? 2 : words.every(word => label.includes(word)) ? 3 : 4;
    return [{ ...entry, score }];
  }).sort((a, b) => a.score - b.score).slice(0, 40);
  quickIndex = 0;
  clear(quickResults);
  for (const [index, entry] of quickEntries.entries()) {
    const option = el('div', 'console-quick-option');
    option.id = 'console-quick-option-' + index;
    option.setAttribute('role', 'option');
    if (entry.icon) option.append(entry.icon.cloneNode(true));
    option.append(el('strong', '', entry.label), el('span', '', entry.context));
    option.onclick = () => chooseQuickEntry(index);
    quickResults.append(option);
  }
  $('console-quick-empty').hidden = quickEntries.length > 0;
  paintQuickSelection();
}

function openQuickNavigation() {
  if (document.querySelector('dialog[open]')) return;
  quickConfigAccount = null;
  quickQuery.value = '';
  renderQuickNavigation();
  quickDialog.showModal();
  quickQuery.focus();
}

$('console-quick-open').onclick = openQuickNavigation;
$('console-quick-close').onclick = () => quickDialog.close();
quickQuery.oninput = renderQuickNavigation;
quickDialog.onkeydown = event => {
  if (event.isComposing || !quickEntries.length || event.target !== quickQuery) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    chooseQuickEntry(quickIndex);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    quickIndex = (quickIndex + (event.key === 'ArrowDown' ? 1 : -1) + quickEntries.length) % quickEntries.length;
    paintQuickSelection(true);
  }
};
document.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k' && !event.isComposing) {
    event.preventDefault();
    if (quickDialog.open) quickQuery.focus();
    else openQuickNavigation();
  }
});
