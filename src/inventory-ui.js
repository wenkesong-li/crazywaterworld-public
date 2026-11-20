let inventoryData=[],inventoryOwner=null,inventoryQuery=null;
bindConsoleSlice('inventory', { inventoryData, inventoryOwner, inventoryQuery }, state => {
  inventoryData = state.inventoryData;
  inventoryOwner = state.inventoryOwner;
  inventoryQuery = state.inventoryQuery;
});

function resetInventory(){setConsoleValue('inventory', 'inventoryQuery', null);setConsoleValue('inventory', 'inventoryData', []);setConsoleValue('inventory', 'inventoryOwner', current);$('inventory-query').value='';clear($('world-stock'));$('inventory-match-count').textContent='';}
function renderInventory(stock){
 if(inventoryOwner!==current)resetInventory();
 if(JSON.stringify(inventoryData)!==JSON.stringify(stock)||inventoryQuery===null){setConsoleValue('inventory', 'inventoryData', stock);paintInventory();}
 $('inventory-status').textContent='共 '+stock.length+' 种 · 更新于 '+new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'});
}
function paintInventory() {
  const root = $('world-stock');
  const query = $('inventory-query').value.normalize('NFKC').trim().toLocaleLowerCase();
  const selected = root.querySelector('[aria-selected="true"]')?.dataset.category;
  const opened = new Set([...root.querySelectorAll('details[open]')].map(group => group.dataset.category));
  const scroll = root.querySelector('.bag-subtabs')?.scrollLeft ?? 0;
  setConsoleValue('inventory', 'inventoryQuery', query);
  const filtered = inventoryData.filter(entry => !query || [entry.name, entry.description, ...(entry.sources ?? [])]
    .some(value => typeof value === 'string' && value.normalize('NFKC').toLocaleLowerCase().includes(query)));
  const groups = new Map();
  for (const entry of filtered) {
    const category = entry.category || '其他';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(entry);
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  clear(root);
  if (!names.length) root.append(el('p', 'dim', query ? '没有匹配的道具' : '仓库空'));
  else {
    const bar = el('div', 'bag-subtabs');
    bar.setAttribute('role', 'tablist');
    bar.setAttribute('aria-label', '道具分类');
    root.append(bar);
    const all = makeInventoryTab(bar, root, 'all', '全部 · ' + filtered.length);
    const tabs = [all.button, ...names.map((name, index) => {
      const entries = groups.get(name);
      const { button, panel } = makeInventoryTab(bar, root, index, name + ' · ' + entries.length);
      button.dataset.category = name;
      panel.className = 'inventory-art-grid';
      const group = makeBagDisclosure(name, entries.length);
      group.dataset.category = name;
      group.open = opened.has(name) || Boolean(query);
      const grid = el('div', 'inventory-art-grid');
      group.append(grid);
      all.panel.append(group);
      for (const entry of entries) {
        for (const target of [grid, panel]) {
          const row = makeBagCard({ ...entry, detail: '库存 ' + fmt(entry.num) }, false, true);
          row.onclick = () => openBagItem(entry);
          target.append(row);
        }
      }
      return button;
    })];
    bindBagTabs(tabs);
    selectBagTab(tabs, tabs.find(tab => tab.dataset.category === selected) || all.button);
    bar.scrollLeft = scroll;
  }
  $('inventory-match-count').textContent = query ? '匹配 ' + filtered.length + ' / ' + inventoryData.length + ' 种' : names.length + ' 类';
}
function makeInventoryTab(bar, root, key, label) {
  const button = el('button', '', label);
  button.type = 'button';
  button.id = 'inventory-category-tab-' + key;
  button.setAttribute('role', 'tab');
  const panel = el('div');
  panel.id = 'inventory-category-panel-' + key;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', button.id);
  button.setAttribute('aria-controls', panel.id);
  bar.append(button);
  root.append(panel);
  return { button, panel };
}
$('inventory-query').oninput=paintInventory;

function openBagItem(entry) {
  const description = entry.description || '游戏配置暂无道具说明';
  clear($('bag-item-profile')).append(makeBagCard({ ...entry, description, detail: '库存 ' + fmt(entry.num) }, false, false));
  $('bag-item-title').textContent = entry.name;
  const list = clear($('bag-item-sources'));
  for (const source of new Set(entry.sources ?? [])) list.append(el('li', '', source));
  $('bag-item-sources-empty').hidden = list.children.length > 0;
  $('bag-item-detail').showModal();
}
$('bag-item-close').onclick = () => $('bag-item-detail').close();
