let bagTab = 'items';
let bagRequest = 0;
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
  for (const group of list.querySelectorAll('.bag-antique-group')) {
    group.hidden = Boolean(query) && !group.querySelector('[data-bag-name]:not([hidden])');
  }
  const matches = $('bag-' + kind + '-matches');
  matches.hidden = !query || list.dataset.loaded !== 'true';
  matches.textContent = count ? '匹配 ' + count + ' 项' : '没有匹配结果';
}

async function refreshBagAntiques() {
  const owner = current;
  const request = ++bagRequest;
  const status = $('bag-antique-status');
  const list = clear($('bag-antique-list'));
  delete list.dataset.loaded;
  filterBag('antique');
  status.textContent = owner ? '正在读取藏品…' : '请选择游戏账号';
  if (!owner) return;
  try {
    const data = await call('/api/bag/antiques');
    if (request !== bagRequest || owner !== current) return;
    if (data.reason) { status.textContent = data.reason; return; }
    status.textContent = '藏品 ' + data.antiques.length + ' 件 · 套装 ' + data.suits.length + ' 套'
      + (data.masterLv == null ? '' : ' · 大师等级 ' + data.masterLv);
    for (const [label, entries] of [['藏品', data.antiques], ['套装', data.suits]]) {
      const group = el('section', 'bag-antique-group');
      group.append(el('h3', '', label));
      if (!entries.length) group.append(el('p', 'dim', '暂未获得'));
      for (const entry of entries) {
        const row = el('div', 'bag-antique-row');
        row.dataset.bagName = entry.name;
        row.append(el('span', '', entry.name), el('span', 'bag-antique-detail', entry.detail));
        group.append(row);
      }
      list.append(group);
    }
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
      const details = [
        hero.level == null ? null : 'Lv.' + hero.level,
        hero.star == null ? null : hero.star + ' 星',
        hero.power == null ? null : '战力 ' + fmt(hero.power),
      ].filter(Boolean).join(' · ');
      const row = cell(hero.icon, 42, hero.name, details);
      row.dataset.bagName = hero.name;
      list.append(row);
    }
    list.dataset.loaded = 'true';
    filterBag('hero');
  } catch (error) {
    if (request === bagRequest && owner === current) status.textContent = '英雄读取失败：' + error.message;
  }
}

for (const button of document.querySelectorAll('[data-bag-tab]')) {
  button.onclick = () => {
    bagTab = button.dataset.bagTab;
    for (const tab of document.querySelectorAll('[data-bag-tab]')) tab.setAttribute('aria-pressed', String(tab === button));
    $('bag-items').hidden = bagTab !== 'items';
    $('bag-heroes').hidden = bagTab !== 'heroes';
    $('bag-antiques').hidden = bagTab !== 'antiques';
    refreshBag();
  };
}
$('bag-antique-refresh').onclick = refreshBagAntiques;
$('bag-hero-refresh').onclick = refreshBagHeroes;

for (const kind of ['antique', 'hero']) $('bag-' + kind + '-query').oninput = () => filterBag(kind);
