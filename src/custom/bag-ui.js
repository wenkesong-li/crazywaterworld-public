let bagTab = 'items';
let bagRequest = 0;
let bagAntiqueOwner;
let metricsOwner;
let metricsRefreshAt = 0;
let metricsRequest = 0;
let metricsPending = false;

function paintAccountMetrics(data = {}) {
  $('account-level').textContent = data.level ?? '—';
  $('account-power').textContent = data.power == null ? '—' : fmt(data.power);
  $('account-gold').textContent = data.gold == null ? '—' : fmt(data.gold);
  $('account-ruby').textContent = data.ruby == null ? '—' : fmt(data.ruby);
}

async function refreshAccountMetrics(force = false) {
  const button = $('account-balance-refresh');
  const feedback = $('account-balance-feedback');
  const owner = current;
  const connected = snapshot.connected && !snapshot.paused && !disconnected.has(owner);
  const key = JSON.stringify([owner, Boolean(connected)]);
  if (metricsOwner !== key) {
    metricsOwner = key;
    metricsRefreshAt = 0;
    metricsRequest++;
    metricsPending = false;
    button.removeAttribute('aria-busy');
    feedback.textContent = '';
    paintAccountMetrics(accounts.find(account => account.id === owner)?.lastSeen ?? {});
  }
  button.disabled = !connected || metricsPending;
  if (!connected || metricsPending || (!force && Date.now() < metricsRefreshAt)) return;
  metricsPending = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (force) feedback.textContent = '正在刷新余额';
  metricsRefreshAt = Date.now() + 20_000;
  const request = ++metricsRequest;
  try {
    const data = await call('/api/account-metrics');
    if (owner === current && request === metricsRequest) {
      paintAccountMetrics(data);
      if (force) feedback.textContent = data.gold == null && data.ruby == null ? '暂未取得余额' : '余额已刷新';
    }
  } catch {
    if (owner === current && request === metricsRequest && force) feedback.textContent = '余额刷新失败，请重试';
  } finally {
    if (owner === current && request === metricsRequest) {
      metricsPending = false;
      button.removeAttribute('aria-busy');
      button.disabled = !snapshot.connected || snapshot.paused || disconnected.has(owner);
    }
  }
}

$('account-balance-refresh').onclick = () => void refreshAccountMetrics(true);

function refreshBag() {
  void refreshAccountMetrics();
  if ($('tab-inventory').classList.contains('hidden')) return;
  if (bagTab === 'items') refreshManualWorld();
  else if (bagTab === 'heroes') void refreshBagHeroes();
  else void refreshBagAntiques();
}

function filterBag(kind) {
  const list = $('bag-' + kind + '-list');
  const query = $('bag-' + kind + '-query').value.normalize('NFKC').trim().toLocaleLowerCase();
  const rows = [...list.querySelectorAll('[data-bag-name]')];
  let count = 0;
  for (const row of rows) {
    row.hidden = Boolean(query) && !row.dataset.bagName.normalize('NFKC').toLocaleLowerCase().includes(query);
    if (!row.hidden) count++;
  }
  for (const empty of list.querySelectorAll('[data-bag-empty]')) {
    empty.hidden = Boolean(empty.parentElement.querySelector('[data-bag-name]:not([hidden])'));
    empty.textContent = query ? '当前分类没有匹配结果' : '暂未获得';
  }
  if (kind === 'antique') {
    count = list.querySelectorAll('#bag-antique-all [data-bag-name]:not([hidden])').length;
    if (query) for (const group of list.querySelectorAll('details')) {
      if (group.querySelector('[data-bag-name]:not([hidden])')) group.open = true;
    }
  }
  const matches = $('bag-' + kind + '-matches');
  matches.hidden = !query || list.dataset.loaded !== 'true';
  matches.textContent = count ? '匹配 ' + count + ' 项' : '没有匹配结果';
}

async function refreshBagAntiques() {
  const owner = current;
  const request = ++bagRequest;
  const status = $('bag-antique-status');
  const list = $('bag-antique-list');
  const all = $('bag-antique-all');
  const opened = new Set([...all.querySelectorAll('details[open]')].map(group => group.dataset.category));
  if (bagAntiqueOwner !== owner) {
    bagAntiqueOwner = owner;
    list.hidden = true;
    delete list.dataset.loaded;
    clear(all);
    clear($('bag-antique-items'));
    clear($('bag-antique-suits'));
    filterBag('antique');
  }
  status.textContent = owner ? '正在读取藏品…' : '请选择游戏账号';
  if (!owner) return;
  try {
    const data = await call('/api/bag/antiques');
    if (request !== bagRequest || owner !== current) return;
    if (data.reason) { list.hidden = true; status.textContent = data.reason; return; }
    clear(all);
    clear($('bag-antique-items'));
    clear($('bag-antique-suits'));
    status.textContent = '藏品 ' + data.antiques.length + ' 件 · 套装 ' + data.suits.length + ' 套'
      + (data.masterLv == null ? '' : ' · 大师等级 ' + data.masterLv);
    for (const [panel, label, entries] of [['items', '藏品', data.antiques], ['suits', '套装', data.suits]]) {
      const disclosure = makeBagDisclosure(label, entries.length);
      disclosure.dataset.category = panel;
      disclosure.open = opened.has(panel);
      const content = el('div', 'bag-disclosure-content');
      disclosure.append(content);
      all.append(disclosure);
      for (const group of [content, $('bag-antique-' + panel)]) {
        const empty = el('p', 'dim', '暂未获得');
        empty.dataset.bagEmpty = '';
        group.append(empty);
        for (const entry of entries) {
          const row = makeBagCard(entry, false);
          group.append(row);
        }
      }
    }
    list.hidden = false;
    list.dataset.loaded = 'true';
    filterBag('antique');
  } catch (error) {
    if (request === bagRequest && owner === current) status.textContent = '藏品读取失败：' + error.message;
  }
}

async function refreshBagHeroes() {
  const owner = current;
  const request = ++bagRequest;
  const status = $('bag-hero-status');
  const list = clear($('bag-hero-list'));
  delete list.dataset.loaded;
  filterBag('hero');
  status.textContent = owner ? '正在读取英雄…' : '请选择游戏账号';
  if (!owner) return;
  try {
    const data = await call('/api/bag/heroes');
    if (request !== bagRequest || owner !== current) return;
    if (data.reason) { status.textContent = data.reason; return; }
    status.textContent = data.heroes.length ? '已拥有 ' + data.heroes.length + ' 名英雄' : '暂未获得英雄';
    for (const hero of data.heroes) {
      const row = makeBagCard(hero, true);
      row.onclick = () => openBagHero(hero, owner);
      list.append(row);
    }
    list.dataset.loaded = 'true';
    filterBag('hero');
  } catch (error) {
    if (request === bagRequest && owner === current) status.textContent = '英雄读取失败：' + error.message;
  }
}

const bagQualities = { BLUE: '稀有', PURPLE: '史诗', ORANGE: '传说', RED: '超凡' };
const bagHeroDialog = $('bag-hero-detail');
let bagHeroOpen = null;
let bagHeroDetailRequest = 0;

function makeBagCard(entry, hero, interactive = hero) {
  const row = el(interactive ? 'button' : 'div', 'bag-art-card');
  if (interactive) {
    row.type = 'button';
    row.setAttribute('aria-haspopup', 'dialog');
  }
  row.dataset.bagName = entry.name;
  if (entry.quality) row.dataset.quality = entry.quality.toLowerCase();
  const image = entry.icon && entry.communityIcon ? { ...entry.icon, fallback: entry.communityIcon } : entry.icon ?? entry.communityIcon;
  const head = el('div', 'bag-card-head');
  const text = el('div', 'bag-card-heading');
  text.append(el('strong', 'bag-card-name', entry.name));
  const tags = el('div', 'bag-card-tags');
  if (hero) {
    const label = entry.guideTier || '未评级';
    const tier = el('span', 'bag-tier');
    tier.dataset.tier = entry.guideTier || 'unrated';
    tier.title = entry.guideTier ? '社区图鉴评级' : '社区图鉴暂无评级';
    tier.append(component('bag-tier-icon'), document.createTextNode(label));
    tags.append(tier);
  }
  for (const label of [entry.qualityLabel || bagQualities[entry.quality], entry.career, hero && entry.star != null ? entry.star + ' 星' : entry.detail].filter(Boolean)) {
    tags.append(el('span', 'bag-card-tag', label));
  }
  text.append(tags);
  head.append(iconEl(image, hero && !interactive ? 76 : 58, entry.name), text);
  row.append(head);
  if (hero) row.append(el('div', 'bag-card-stats', [
    entry.level == null ? '' : 'Lv.' + entry.level,
    entry.power == null ? '' : '战力 ' + fmt(entry.power),
  ].filter(Boolean).join(' · ')));
  if (entry.description) row.append(el('div', 'bag-card-desc', entry.description));
  return row;
}

function paintBagStarStage(stage) {
  const confirming = stage === 'confirm' || stage === 'writing';
  const disabled = stage === 'loading' || stage === 'writing';
  bagHeroDialog.dataset.starStage = stage;
  $('bag-hero-star').hidden = confirming || stage === 'error';
  $('bag-hero-star').disabled = stage !== 'ready';
  $('bag-hero-star-confirm').hidden = !confirming;
  $('bag-hero-star-confirm').disabled = stage === 'writing';
  $('bag-hero-star-cancel').hidden = !confirming;
  $('bag-hero-star-cancel').disabled = stage === 'writing';
  $('bag-hero-star-retry').hidden = stage !== 'error';
  $('bag-hero-universal').disabled = disabled || confirming || bagHeroOpen?.detail?.materials.every(item => item.kind !== 'universal') === true;
  $('bag-star-confirm-note').hidden = !confirming;
}

function bagStarStatus(message, tone = '') {
  const status = $('bag-hero-detail-status');
  status.dataset.tone = tone;
  status.textContent = message;
}

function paintBagStarMaterials(list, entries) {
  clear(list);
  for (const { name, count } of entries) {
    const row = el('li');
    row.append(el('span', '', name), el('strong', '', '× ' + fmt(count)));
    list.append(row);
  }
}

function openBagHero(hero, owner) {
  if (owner !== current || !hero.heroId) return;
  bagHeroOpen = { hero, owner, detail: null, writing: false };
  $('bag-hero-universal').checked = false;
  const account = accounts.find(item => item.id === owner);
  $('bag-hero-detail-account').textContent = account?.label || $('account-picker-title').textContent;
  clear($('bag-hero-detail-profile')).append(makeBagCard(hero, true, false));
  clear($('bag-hero-detail-body')).append(el('p', 'dim', '正在读取技能…'));
  clear($('bag-star-materials'));
  $('bag-star-current').textContent = hero.star == null ? '—' : hero.star + ' 星';

  bagHeroDialog.showModal();
  bagHeroDialog.querySelector('.bag-detail-scroll').scrollTop = 0;
  void loadBagHeroDetail(bagHeroOpen);
}

async function loadBagHeroDetail(view, success = '') {
  const universal = $('bag-hero-universal');
  const useUniversal = universal.checked;
  const request = ++bagHeroDetailRequest;
  view.detail = null;
  paintBagStarStage('loading');
  $('bag-star-cost').hidden = true;
  $('bag-star-requirement').hidden = true;
  $('bag-star-universal-count').textContent = '—';
  $('bag-star-next').textContent = '—';
  bagStarStatus(success || '正在核对星级和碎片库存…', success ? 'success' : 'loading');
  try {
    const query = new URLSearchParams({ account: view.owner, heroId: view.hero.heroId, universal: useUniversal ? '1' : '0' });
    const data = await call('/api/bag/hero-detail?' + query);
    if (bagHeroOpen !== view || view.owner !== current || request !== bagHeroDetailRequest) return;
    view.detail = { ...data, useUniversal };
    clear($('bag-hero-detail-profile')).append(makeBagCard({ ...view.hero, ...data, icon: view.hero.icon }, true, false));
    const body = clear($('bag-hero-detail-body'));
    const skills = el('ul', 'bag-detail-list');
    for (const [index, name] of data.skills.entries()) {
      const level = data.skillLevels?.[index];
      const row = el('li');
      row.append(el('span', '', name));
      if (typeof level === 'number') row.append(el('strong', '', 'Lv.' + level));
      skills.append(row);
    }
    body.append(skills.children.length ? skills : el('p', 'dim', '暂无技能资料'));
    $('bag-star-current').textContent = data.star + ' 星';
    const universalStock = data.materials.find(item => item.kind === 'universal');
    const ownedStock = data.materials.find(item => item.kind === 'own');
    const requirement = data.requirement;
    const target = data.next?.to ?? requirement?.to;
    $('bag-star-next').textContent = target == null ? '—' : target + ' 星';
    paintBagStarMaterials($('bag-star-materials'), data.materials.filter(item => item.kind !== 'universal'));
    $('bag-star-universal-count').textContent = universalStock ? '库存 ' + fmt(universalStock.count) : '不适用';
    if (!universalStock) universal.checked = false;
    const requirementLine = $('bag-star-requirement');
    requirementLine.hidden = !requirement;
    if (requirement) {
      const extra = universalStock?.name !== ownedStock?.name && useUniversal ? universalStock?.count ?? 0 : 0;
      const shortfall = Math.max(0, requirement.count - (ownedStock?.count ?? 0) - extra);
      requirementLine.textContent = '下一星需要 ' + fmt(requirement.count) + ' 个碎片' + (shortfall ? ' · 还差 ' + fmt(shortfall) + ' 个' : '');
    }
    $('bag-star-cost').hidden = !data.next;
    if (data.next) paintBagStarMaterials($('bag-star-cost-list'), data.next.costs.map(item => ({ name: item.id, count: item.num })));
    paintBagStarStage(data.quote ? 'ready' : 'blocked');
    universal.disabled = !universalStock;
    bagStarStatus(success || (data.next ? '' : data.star >= data.maxStar ? '已达最高星级' : '碎片不足或下一星级尚未开放'), success ? 'success' : '');
  } catch (error) {
    if (bagHeroOpen === view && request === bagHeroDetailRequest) {
      paintBagStarStage('error');
      bagStarStatus(success ? success + '，详情暂未刷新。' : error.message, success ? 'success' : 'error');
    }
  }
}

$('bag-hero-detail-close').onclick = () => bagHeroDialog.close();
bagHeroDialog.addEventListener('close', () => {
  closeBagHeroGuide(false);
  bagHeroOpen = null;
});

function closeBagHeroGuide(restoreFocus = true) {
  const reader = $('bag-hero-guide-reader');
  if (reader.hidden) return;
  reader.hidden = true;
  delete bagHeroDialog.dataset.readingGuide;
  bagHeroDialog.setAttribute('aria-labelledby', 'bag-hero-detail-title');
  clear($('bag-hero-guide-viewport'));
  if (restoreFocus) {
    bagHeroDialog.querySelector('.bag-detail-scroll').scrollTop = bagHeroOpen?.guideScroll ?? 0;
    $('bag-hero-guide').focus({ preventScroll: true });
  }
}

$('bag-hero-guide').onclick = () => {
  const view = bagHeroOpen;
  if (!view) return;
  const origin = 'https://fkssj.game-wiki.cn';
  const source = view.hero.source;
  const url = typeof source === 'string' && /^https:\/\/fkssj\.game-wiki\.cn\/heroes(?:\/[a-z0-9-]+)?$/.test(source) ? source : origin + '/heroes';
  view.guideScroll = bagHeroDialog.querySelector('.bag-detail-scroll').scrollTop;
  const reader = $('bag-hero-guide-reader');
  const title = view.hero.name + ' · 社区攻略';
  $('bag-hero-guide-title').textContent = title;
  $('bag-hero-guide-external').href = url;
  const frame = el('iframe', 'guide-frame');
  frame.title = title;
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  frame.src = url;
  clear($('bag-hero-guide-viewport')).append(frame);
  bagHeroDialog.dataset.readingGuide = '';
  bagHeroDialog.setAttribute('aria-labelledby', 'bag-hero-guide-title');
  reader.hidden = false;
  $('bag-hero-guide-back').focus();
};
$('bag-hero-guide-back').onclick = () => closeBagHeroGuide();
bagHeroDialog.addEventListener('cancel', event => {
  if (!$('bag-hero-guide-reader').hidden) {
    event.preventDefault();
    closeBagHeroGuide();
  }
});
$('bag-hero-universal').onchange = $('bag-hero-star-retry').onclick = () => {
  if (bagHeroOpen && !bagHeroOpen.writing) void loadBagHeroDetail(bagHeroOpen);
};
$('bag-hero-star').onclick = () => {
  if (!bagHeroOpen?.detail?.quote || bagHeroOpen.owner !== current) return;
  paintBagStarStage('confirm');
  bagStarStatus('');
  $('bag-star-cost').scrollIntoView({ block: 'nearest' });
  $('bag-hero-star-cancel').focus({ preventScroll: true });
};
$('bag-hero-star-cancel').onclick = () => {
  paintBagStarStage('ready');
  $('bag-hero-star').focus({ preventScroll: true });
};
$('bag-hero-star-confirm').onclick = async () => {
  const view = bagHeroOpen, detail = view?.detail;
  if (!detail?.quote || !detail.next || view.owner !== current || view.writing || bagHeroDialog.dataset.starStage !== 'confirm') return;
  view.writing = true;
  paintBagStarStage('writing');
  bagStarStatus('正在升星，等待游戏服务器确认…', 'loading');
  try {
    const data = await call('/api/bag/hero-star?account=' + encodeURIComponent(view.owner), {
      method: 'POST', body: JSON.stringify({ confirm: true, heroId: detail.heroId, universal: detail.useUniversal, quote: detail.quote }),
    });
    if (view.owner === current) {
      void refreshBagHeroes();
      if (bagHeroOpen === view) await loadBagHeroDetail(view, '升星成功，当前 ' + data.star + ' 星');
    }
  } catch (error) {
    if (bagHeroOpen === view) {
      view.detail = null;
      paintBagStarStage('error');
      bagStarStatus(error.message + '。重新核对后再继续。', 'error');
      $('bag-hero-star-retry').focus();
    }
  } finally {
    view.writing = false;
  }
};

function makeBagDisclosure(name, count) {
  const group = el('details', 'bag-disclosure');
  const heading = el('summary');
  heading.append(el('strong', '', name), el('span', 'bag-disclosure-count', String(count)));
  group.append(heading);
  return group;
}

function enableBagTabDrag(bar) {
  let drag;
  let moved = false;
  bar.onpointerdown = event => {
    moved = false;
    if (event.pointerType !== 'mouse' || event.button !== 0 || bar.scrollWidth <= bar.clientWidth) return;
    drag = { id: event.pointerId, x: event.clientX, scroll: bar.scrollLeft };
  };
  bar.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId || !(event.buttons & 1)) return;
    const distance = event.clientX - drag.x;
    if (!moved && Math.abs(distance) < 5) return;
    moved = true;
    if (!bar.hasPointerCapture(drag.id)) bar.setPointerCapture(drag.id);
    bar.scrollLeft = drag.scroll - distance;
  };
  bar.onpointerup = bar.onpointercancel = () => { drag = null; };
  bar.addEventListener('click', event => {
    if (!moved || !event.detail) return;
    moved = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function selectBagTab(tabs, selected) {
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !active;
  }
}

function bindBagTabs(tabs, onSelect) {
  const bar = tabs[0]?.parentElement;
  if (bar?.classList.contains('bag-subtabs')) enableBagTabDrag(bar);
  for (const [index, button] of tabs.entries()) {
    button.onkeydown = event => {
      const positions = { ArrowLeft: (index - 1 + tabs.length) % tabs.length,
        ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!Object.hasOwn(positions, event.key)) return;
      event.preventDefault();
      const next = tabs[positions[event.key]];
      next.click();
      next.focus();
    };
    button.onclick = () => {
      selectBagTab(tabs, button);
      onSelect?.(button);
    };
  }
}

const antiqueTabs = [...document.querySelectorAll('#bag-antique-list [role="tab"]')];
bindBagTabs(antiqueTabs);
bindBagTabs([...document.querySelectorAll('[data-bag-tab]')], button => {
  bagTab = button.dataset.bagTab;
  refreshBag();
});
$('bag-antique-refresh').onclick = refreshBagAntiques;
$('bag-hero-refresh').onclick = refreshBagHeroes;

for (const kind of ['antique', 'hero']) $('bag-' + kind + '-query').oninput = () => filterBag(kind);
