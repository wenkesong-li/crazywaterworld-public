const guideTopics = {
  hero: ['英雄攻略', '技能、升星、专武与养成路线'],
  building: ['建筑攻略', '蓝图分配、设施升级与生产链'],
  lineup: ['阵容推荐', '开荒、赛季配队与挑战站位'],
};
const guideNotes = {
  224: '介绍英雄补给系统，重点是垃圾回收厂的用途、补给合成，以及哪些词条值得保留。',
  209: '可以按目标星级核算所需碎片，也能查看每颗星分阶段投入的方式。',
  25: '巫师老侃会给近处队友套盾。配队时可借站位控制保护对象，三星是原文重点讨论的养成节点。',
  26: '介绍小丑杰克怎样利用分身补输出，以及专武锁定目标会如何影响站位选择。',
  27: '北境大帝能向远端敌人冲锋，并把沿途敌人带到落点附近。文中结合阵容说明如何利用这个开团能力。',
  28: '围绕永生老乔的能量弹、位移和升星门槛，比较不同养成思路。',
  16: '并列查看钓鱼椅、潜水船坞和拾荒船，了解三种设施的产出分工及满级收益。',
  17: '蓝图之外还需要考虑人口门槛。文中给出升级顺序，便于按当前卡住的建筑安排蓝图。',
  18: '按生产设施梳理原料、加工品和用途，适合排产前核对物资从哪座建筑获得。',
  19: '汇总指挥中心、选种厂等功能建筑的官方介绍，便于查找不同设施的作用。',
  192: '介绍垃圾回收厂与农业研究所，以及它们和英雄补给、农业玩法之间的关系。',
  223: '卡在 950 关时，可以先对照游戏内通关记录调站位，再针对敌方核心调整集火方式。',
  43: '从资源有限的角度安排主力养成，重点讨论万能碎片适合投入哪些英雄。',
  44: '按输出、前排、辅助拆分词条优先级，帮助决定先洗谁，以及何时停止继续消耗材料。',
  33: '对照 S6 与 S7 的常见组合，按现有英雄和投入程度参考配队与站位。',
  186: '以兰博为主输出，讨论 S2 射手队前排、控制和雾隐千代的站位分工。',
  177: '从前期可用阵容开始，按兰博、巫师老侃等英雄的取得与养成进度逐步换人。',
  174: '原文提供 3450 与 3500 关的通关视频，适合对照阵容、站位与实战过程。',
  173: '对照海王、战神小布和探案双子星，方便按当前阵容缺口选择培养对象。',
  161: '面向跨服玩法的阵容搭配参考，可按已有英雄对照队伍分工。',
};
let guideLoaded = false;
let guideBusy = false;
const guideSummary = entry => entry.summary ?? guideNotes[entry.id] ?? '';

function applyGameGuideCatalog(result) {
  gameGuideCatalog = result.catalog;
  guideLoaded = true;
  $('guide-sync-status').textContent = result.syncedAt ? '最近同步 ' + when(result.syncedAt) : '';
  renderGuideList();
  renderGuideView();
}

async function loadGameGuideCatalog() {
  if (guideLoaded || guideBusy) return;
  guideBusy = true;
  try { applyGameGuideCatalog(await call('/api/game-guides')); }
  catch (error) { $('guide-sync-status').textContent = '服务器目录加载失败：' + error.message; }
  finally { guideBusy = false; }
}

let guideTopic = 'hero';
const guideQuery = $('guide-query');
const guideTabs = [...$('guide-tabs').querySelectorAll('[role=tab]')];
const guideFrames = new Map();
let guideLocal = false;
const guideCategoryUrl = topic => 'https://fkssj.game-wiki.cn/c/' + topic;

function paintGuideMode() {
  const mode = $('guide-mode');
  mode.textContent = guideLocal ? '浏览源站' : '站内目录';
  mode.setAttribute('aria-pressed', String(guideLocal));
  $('guide-category-source').href = guideCategoryUrl(guideTopic);
  $('guide-local').hidden = !guideLocal;
  $('guide-frames').hidden = guideLocal;
  for (const [topic, frame] of guideFrames) frame.hidden = topic !== guideTopic;
  if (guideLocal || $('tab-guide').classList.contains('hidden') || $('guide-index').hidden || guideFrames.has(guideTopic)) return;
  const frame = el('iframe', 'guide-frame');
  frame.title = '疯狂水世界 Wiki · ' + guideTopics[guideTopic][0];
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  frame.src = guideCategoryUrl(guideTopic);
  guideFrames.set(guideTopic, frame);
  $('guide-frames').append(frame);
}

function guideLink(entry) {
  const link = el('a', 'guide-card', entry.title);
  link.href = '#guide-' + entry.id;
  link.onclick = event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(history.state, '', link.hash);
    renderGuideView(true);
  };
  return link;
}

function renderGuideList() {
  const query = guideQuery.value.normalize('NFKC').toLocaleLowerCase().trim();
  const list = clear($('guide-list'));
  const entries = gameGuideCatalog[guideTopic].filter(entry => entry.title.normalize('NFKC').toLocaleLowerCase().includes(query));
  $('guide-result').textContent = entries.length + ' 篇';
  if (!entries.length) list.append(el('p', 'dim', '没有匹配的攻略'));
  for (const entry of entries) {
    const card = el('article', 'guide-article');
    const meta = el('div', 'guide-meta');
    meta.append(el('span', 'guide-tag', guideTopics[guideTopic][0]), el('time', '', entry.date));
    card.append(meta, guideLink(entry));
    if (guideSummary(entry)) card.append(el('p', 'guide-summary', guideSummary(entry)));
    list.append(card);
  }
}

function selectGuideTopic(topic) {
  guideTopic = topic;
  for (const tab of guideTabs) {
    const active = tab.dataset.topic === topic;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  $('guide-panel').setAttribute('aria-labelledby', 'guide-tab-' + topic);
  $('guide-topic-description').textContent = guideTopics[topic][1];
  renderGuideList();
  paintGuideMode();
}

function renderGuideView(focus = false) {
  const id = /^#guide-(\d+)$/.exec(location.hash)?.[1];
  const topic = id && Object.keys(guideTopics).find(key => gameGuideCatalog[key].some(entry => entry.id === id));
  const detail = $('guide-detail');
  $('guide-refresh').hidden = false;
  $('guide-index').hidden = Boolean(topic);
  detail.hidden = !topic;
  if (!topic) {
    paintGuideMode();
    if (focus) $('guide-title').focus();
    return;
  }
  if (topic !== guideTopic) selectGuideTopic(topic);
  const entry = gameGuideCatalog[topic].find(item => item.id === id);
  $('guide-detail-title').textContent = entry.title;
  $('guide-detail-meta').textContent = [guideTopics[topic][0], entry.date, '疯狂水世界 Wiki'].filter(Boolean).join(' · ');
  $('guide-detail-summary').textContent = guideSummary(entry);
  $('guide-detail-summary').hidden = !guideSummary(entry);
  $('guide-source').href = 'https://fkssj.game-wiki.cn/article/' + id;
  const related = clear($('guide-related'));
  for (const other of gameGuideCatalog[topic].filter(item => item.id !== id).slice(0, 4)) related.append(guideLink(other));
  if (focus) $('guide-detail-title').focus();
}

for (const [index, button] of guideTabs.entries()) {
  button.onclick = () => selectGuideTopic(button.dataset.topic);
  button.onkeydown = event => {
    const next = { ArrowLeft: (index + guideTabs.length - 1) % guideTabs.length,
      ArrowRight: (index + 1) % guideTabs.length, Home: 0, End: guideTabs.length - 1 }[event.key];
    if (!Number.isInteger(next)) return;
    event.preventDefault();
    guideTabs[next].click();
    guideTabs[next].focus();
  };
}
guideQuery.oninput = renderGuideList;
$('guide-mode').onclick = () => {
  guideLocal = !guideLocal;
  paintGuideMode();
  if (guideLocal) void loadGameGuideCatalog();
};
$('guide-refresh').onclick = async () => {
  if (guideBusy) return;
  const button = $('guide-refresh');
  guideBusy = button.disabled = true;
  $('guide-sync-status').textContent = '正在同步三个攻略栏目…';
  for (const [topic, frame] of guideFrames) frame.src = guideCategoryUrl(topic);
  try {
    applyGameGuideCatalog(await call('/api/game-guides/refresh', { method: 'POST', body: '{}' }));
  } catch (error) { $('guide-sync-status').textContent = '同步失败，已保留当前目录：' + error.message; }
  finally { guideBusy = button.disabled = false; }
};
$('guide-back').onclick = () => {
  history.pushState(history.state, '', location.pathname + location.search);
  renderGuideView(true);
};
window.addEventListener('popstate', () => {
  if (/^#guide-\d+$/.test(location.hash)) {
    const tab = document.querySelector('#tabs [data-tab="guide"]');
    if (tab.getAttribute('aria-current') !== 'page') activateConsolePage(tab);
    else renderGuideView();
  } else if (!$('tab-guide').classList.contains('hidden')) renderGuideView();
});
selectGuideTopic(guideTopic);
