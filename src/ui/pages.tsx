import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "./button"
import { Card, CardAction, CardHeader, CardTitle, CardContent } from "./card"
import { Input } from "./input"
import { Switch } from "./switch"
import { HelpTip } from "./help-tip"
import { Badge } from "./badge"
import { DialogFooter, DialogHeader, DialogTitle } from "./dialog"
import { MessageCircle, Copy, Check, Package, Gem, UsersRound, Plus, QrCode, Smartphone, Music2, X } from "lucide-react"

function Panel({title, help, titleAfter, children}: {title: string; help?: string; titleAfter?: React.ReactNode; children: React.ReactNode}) {
  return <Card><CardHeader><CardTitle className="title-with-help">{title}{help && <HelpTip title={title}>{help}</HelpTip>}</CardTitle>{titleAfter && <CardAction className="row-span-1 self-center max-md:col-span-2 max-md:col-start-1 max-md:row-start-2 max-md:justify-self-start">{titleAfter}</CardAction>}</CardHeader><CardContent>{children}</CardContent></Card>
}

export function giftCodesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="礼包兑换" help="每个账号独立排队，兑换请求逐个发送。账号登录失败或结果未知只停止该账号；任一账号遇到服务器限频时，同批尚未发送的账号全部停止，之后可继续提交。">
      <div className="bar"><Button type="button" variant="outline" size="sm" id="gift-load-initial">获取最新礼包码</Button><Button type="button" variant="outline" size="sm" id="gift-channels-open" data-console-admin="true">获取渠道管理</Button><Button type="button" variant="outline" size="sm" id="gift-fetch-history-open">抓取日志</Button><Button type="button" variant="outline" size="sm" id="gift-add-row">新增礼包码行</Button><Button type="button" variant="outline" size="sm" id="gift-batch-add" data-console-admin="true" aria-haspopup="dialog" aria-controls="gift-batch-dialog">批量新增共享码</Button><label><input id="gift-show-processed" type="checkbox" /> 显示已处理</label></div>
      <template id="gift-copy-button-template"><button className="gift-copy-button" type="button" aria-label="复制礼包码" title="复制礼包码"><span data-copy-idle><Copy aria-hidden="true" /></span><span data-copy-success hidden><Check aria-hidden="true" /></span></button></template>
      <dialog id="gift-channels-dialog" aria-labelledby="gift-channels-title">
        <DialogHeader className="gift-fetch-header"><DialogTitle id="gift-channels-title">礼包码获取渠道</DialogTitle><Button id="gift-channels-close" type="button" variant="outline" size="sm"><X aria-hidden="true" />关闭</Button></DialogHeader>
        <p className="dim">内置公共渠道固定。管理员可添加和编辑自建渠道，所有渠道都会参与抓取。</p>
        <div id="gift-channels-list" />
        <form id="gift-channel-form" hidden>
          <label>渠道名称<Input id="gift-channel-name" maxLength={40} required /></label>
          <label>公开 HTTPS 网址<Input id="gift-channel-url" type="url" maxLength={1000} placeholder="https://…" required /></label>
          <label>数据格式<select id="gift-channel-format"><option value="wiki">Wiki 兼容 JSON 接口</option><option value="article">游侠网格式文章</option></select></label>
        </form>
        <p id="gift-channels-status" className="dim" role="status" />
        <DialogFooter><Button id="gift-channel-add" type="button">新增渠道</Button><Button id="gift-channel-save" type="submit" form="gift-channel-form" hidden>保存渠道</Button><Button id="gift-channel-cancel" type="button" variant="outline" hidden>取消编辑</Button></DialogFooter>
      </dialog>
      <dialog id="gift-fetch-history-dialog" aria-labelledby="gift-fetch-history-title">
        <DialogHeader className="gift-fetch-header"><DialogTitle id="gift-fetch-history-title">礼包码抓取日志</DialogTitle><Button id="gift-fetch-history-dismiss" type="button" variant="outline" size="sm"><X aria-hidden="true" />关闭</Button></DialogHeader>
        <Button id="gift-fetch-history-back" type="button" variant="outline" size="sm" hidden>返回批次</Button>
        <p id="gift-fetch-history-status" className="dim" role="status" />
        <div id="gift-fetch-history-body" />
      </dialog>
      <div id="gift-fetch-report" className="gift-fetch-report" role="status" hidden />
      <p id="gift-code-initial-note" className="dim" role="status" />
      <div className="gift-library-table"><table><thead><tr><th>礼包码</th><th>可用状态</th><th>使用状态</th><th>到期日期（北京时间）</th><th>来源 / 操作</th></tr></thead><tbody id="gift-code-library-rows" /><tbody id="gift-code-manual-rows" /></table></div>
      <p className="dim">新增行仅保存到勾选的账号，自动兑换开启后会自动处理。有效期留空表示未注明，需由游戏确认；明确过期会全局下架。</p>
      <fieldset className="gift-accounts"><legend>兑换账号</legend>
        <div className="bar"><Button variant="outline" size="sm" id="gift-select-all">全选</Button><Button variant="outline" size="sm" id="gift-select-none">清空</Button><span id="gift-selected-count" className="dim" /></div>
        <div id="gift-account-list" className="gift-account-list" />
        <p className="dim">自动兑换默认关闭。每天8点同步，手动获取会重新访问各渠道；新账号也能兑换历史有效码。已兑换、待确认的码不重发，限频及未发送的余码会续兑。</p>
        <p className="dim">暂停时可维护礼包码，恢复后才兑换；共享游戏账号共用开关。未连接会自动登录，可能将正在玩的游戏顶下线。</p>
      </fieldset>
      <div className="bar"><Button id="gift-code-start">开始兑换</Button><span id="gift-code-state" role="status" /></div></Panel>
    <Panel title="兑换记录">
      <div className="bar gift-record-toolbar">
        <label htmlFor="gift-record-account">查看账号</label><select id="gift-record-account" />
        <label htmlFor="gift-record-status">状态</label><select id="gift-record-status" defaultValue="exclude-invalid">
          <option value="exclude-invalid">排除失效/不可用</option><option value="all">全部状态</option><option value="invalid">失效/不可用</option>
          <option value="retryable">可手动重试</option><option value="success">兑换成功</option><option value="used">已兑换</option><option value="rejected">服务器拒绝</option>
          <option value="unknown">待确认</option><option value="skipped">未发送</option><option value="queued">待兑换</option><option value="sending">兑换中</option>
        </select><Button id="gift-record-export" variant="outline">导出 CSV</Button>
      </div>
      <p className="dim">失效/不可用包含过期、无效、不在有效期、达到兑换上限及已由其他账号兑换。可手动重试包含限频及未识别提示码的明确拒绝；成功、已兑换、待确认及明确失效的码不可重试。导出包含当前账号和状态条件下的全部记录。</p>
      <p id="gift-record-notice" className="dim" role="status" aria-live="polite" />
      <div className="gift-record-table overflow-auto"><table><thead><tr>{['礼包码','渠道','兑换方式','状态','结果','时间','操作'].map(t=><th key={t}>{t}</th>)}</tr></thead><tbody id="gift-code-history" /></table></div>
      <div className="bar"><label htmlFor="gift-page-size">每页</label><select id="gift-page-size" defaultValue="10">{[10,20,50,100].map(n=><option key={n} value={n}>{n} 条</option>)}</select><Button variant="outline" id="gift-prev">上一页</Button><span id="gift-page" role="status" /><Button variant="outline" id="gift-next">下一页</Button></div>
    </Panel>
  </div>)
}

export function overviewPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="运行概览" help="按功能分别查看当前进度与当前条件。这里只读展示；开关与参数在对应挂机配置中设置。">
      <div className="bar overview-task-filter"><Input id="overview-task-search" type="search" aria-label="查找运行状态" placeholder="功能名称或状态" /><label htmlFor="overview-task-filter">显示</label><select id="overview-task-filter" defaultValue="enabled"><option value="enabled">已开启</option><option value="issues">异常 / 受总控限制</option><option value="all">全部项目</option></select></div>
      <p id="overview-task-summary" className="dim" role="status">等待读取运行状态</p>
      <div id="overview-task-groups" />
    </Panel>
    <Panel title="世界概览" help="点击城池可查看攻守队列、驻防和可用操作。地图刷新间隔可设为 5–300 秒。" titleAfter={<div className="world-refresh-controls"><Button id="world-map-auto-refresh" size="sm" variant="outline" aria-pressed="true">自动刷新：开</Button><label className="world-refresh-setting">每<input id="world-map-refresh-seconds" aria-label="世界概览刷新秒数" type="number" min="5" max="300" step="1" defaultValue="10" />秒</label></div>}>
      <div id="world-map-fleets" className="fleet-summary" aria-label="我的舰队" />
      <p id="world-fleet-speed-feedback" className="dim" role="status" hidden />
      <details className="world-map-stats"><summary>城战与货轮详情</summary><div id="world-map-wars" /><div id="world-map-treasures" /></details>
      <details className="world-map-stats"><summary>汽油用量</summary><div id="world-map-resources" /></details>
      <div className="bar world-map-toolbar"><Button id="world-map-refresh" variant="outline" size="sm">刷新地图</Button><Button id="world-map-pan" variant="outline" size="sm" aria-pressed="false">移动地图</Button><Button id="world-map-reset" variant="outline" size="sm">全图</Button><Button id="world-map-home" variant="outline" size="sm">定位舰队</Button><label htmlFor="world-map-zoom">缩放</label><input id="world-map-zoom" type="range" min="1" max="8" step="0.25" defaultValue="1" /><span id="world-map-time" role="status">尚未读取</span></div>
      <div id="world-map-layers" className="bar" />
      <div className="world-map-layout"><div className="world-map-stage">
        <div id="world-map-scroll" className="world-map-scroll"><svg id="world-map" role="group" aria-label="世界地图" /></div>
        <dialog id="world-map-detail" className="world-map-detail" aria-labelledby="world-map-target-name" hidden>
          <div className="world-map-detail-heading"><strong id="world-map-target-name" /><Button id="world-map-detail-close" variant="ghost" size="sm" aria-label="关闭地图详情"><X aria-hidden="true" size={16} /></Button></div>
          <div id="world-map-target-facts" />
          <div id="world-map-city-actions" className="world-city-actions" hidden />
        </dialog>
      </div><div id="world-map-legend" className="world-map-legend" /><div id="world-map-state-legend" className="world-map-state-legend" /><p className="world-map-help"><span className="for-mouse">点击城池查看详情 · 拖动平移 · Ctrl+滚轮缩放</span><span className="for-touch">轻点城池查看详情 · 点「移动地图」后可单指拖动</span></p></div>
      <p id="world-map-notes" className="dim" />
    </Panel>
    <Panel title="资源田概览" help="点击卡片查看该类已占田，点「占领」或「换田」查看候选地块。要换田，先在新地块所在行点「替换」，再选择已有地块。" titleAfter={<div className="bar"><a className="inline-link" href="#config-group-resourceFields">资源田配置</a><Button id="resource-fields-refresh" variant="outline" size="sm" disabled>刷新资源田</Button></div>}>
      <section id="resource-fields-overview" aria-label="资源田概览">
        <div className="resource-fields-toolbar"><span id="resource-fields-capacity">连接账号后读取资源田</span><span id="resource-fields-automatic" className="dim" /></div>
        <p id="resource-fields-feedback" className="resource-fields-feedback" role="status" hidden />
        <div id="resource-fields-summary" className="resource-fields-summary" />
      </section>
      <dialog id="resource-fields-action-dialog" aria-labelledby="resource-fields-action-title">
        <DialogHeader className="flex-row items-center justify-between">
          <div className="resource-fields-dialog-heading">
            <DialogTitle id="resource-fields-action-title">管理资源田</DialogTitle>
            <span id="resource-fields-owned-hint" className="dim" hidden />
            <span id="resource-fields-candidate-count" className="dim" hidden />
            <span id="resource-fields-candidate-fuel" className="dim" hidden />
          </div>
          <Button id="resource-fields-dialog-close" variant="outline" size="sm" aria-label="关闭资源田弹窗">关闭</Button>
        </DialogHeader>
        <div id="resource-fields-manager">
          <section id="resource-fields-owned" aria-labelledby="resource-fields-action-title" hidden>
            <div className="resource-fields-table-scroll" role="region" aria-label="已占资源田表格" tabIndex={0}><table className="resource-fields-table resource-fields-owned-table"><thead><tr><th scope="col">地块</th><th scope="col">等级</th><th scope="col">有效时产</th><th scope="col">操作</th></tr></thead><tbody id="resource-fields-owned-table" /></table></div>
          </section>
          <section id="resource-fields-targets" aria-labelledby="resource-fields-action-title">
            <div className="resource-fields-table-scroll" role="region" aria-label="可占资源田表格" tabIndex={0}><table className="resource-fields-table resource-fields-candidate-table"><thead><tr><th scope="col">田地 / 等级</th><th scope="col">基础时产</th><th scope="col">推荐战力</th><th scope="col">操作</th></tr></thead><tbody id="resource-fields-candidates" /></table></div>
          </section>
        </div>
        <div id="resource-fields-action-body" hidden />
        <DialogFooter><Button id="resource-fields-action-back" variant="outline" hidden>返回选田</Button><Button id="resource-fields-action-confirm" disabled hidden>确认派遣</Button></DialogFooter>
      </dialog>
    </Panel>
    <Panel title="硅矿概览" help="空矿位的详情浮层可选择舰队采集；自己的采矿舰队首奖后可撤回。单次派遣与撤回不会改变自动配置。自动刷新仅影响此概览；鼠标悬停、键盘聚焦或手机轻触矿位查看详情。奖励由服务器自动发放，倒计时结束后需同步确认。" titleAfter={<div className="bar"><a className="inline-link" href="#config-group-silicon">硅矿配置</a><Button id="silicon-refresh" variant="outline" size="sm" disabled>刷新硅矿</Button></div>}>
      <section id="silicon-overview" aria-label="硅矿概览">
        <div className="silicon-toolbar"><span id="silicon-status" className="dim" role="status">连接账号后读取硅矿</span><div className="world-refresh-controls"><Button id="silicon-auto-refresh" size="sm" variant="outline" aria-pressed="true">自动刷新：开</Button><label className="world-refresh-setting">每<input id="silicon-refresh-seconds" aria-label="硅矿自动刷新秒数" type="number" min="5" max="300" step="1" defaultValue="30" />秒</label></div></div>
        <p id="silicon-feedback" className="silicon-feedback" role="status" hidden />
        <div id="silicon-summary" className="silicon-summary" />
        <div id="silicon-fleets" className="silicon-fleets" aria-label="硅矿舰队状态" />
        <div id="silicon-mines" className="silicon-mines" />
        <p id="silicon-notes" className="dim" />
      </section>
      <aside id="silicon-slot-popover" role="dialog" aria-label="矿位详情" hidden />
      <dialog id="silicon-action-dialog" aria-labelledby="silicon-action-title">
        <DialogHeader><DialogTitle id="silicon-action-title">硅矿快捷操作</DialogTitle></DialogHeader>
        <div id="silicon-action-body" />
        <DialogFooter><Button id="silicon-action-confirm" disabled>确认操作</Button><Button id="silicon-action-cancel" variant="outline">取消</Button></DialogFooter>
      </dialog>
    </Panel>
  </div>)
}

export function activitiesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <div className="activity-toolbar"><Button id="activities-refresh" className="ml-auto" variant="outline" size="sm">刷新活动</Button></div>
    <div id="activities-status" className="dim" role="status" />
    <div className="activity-shell">
      <div id="activity-tabs" className="activity-tabs" role="tablist" aria-label="选择活动" />
      <section id="activity-panel" role="tabpanel" tabIndex={0} hidden>
        <Card><CardHeader><div className="activity-heading"><CardTitle id="activity-title" /><span id="activity-kind" /></div><p id="activity-end" className="dim" /></CardHeader>
          <CardContent className="activity-content">
            <div id="activity-pirates" hidden><div id="pirate-board-view" className="pirate-board" aria-live="polite" /></div>
            <div id="activity-detail"><div id="activities-list" className="activity-body" /><div id="activities-order" /></div>
          </CardContent>
        </Card>
      </section>
    </div>
    <template id="ui-event-switch"><Switch className="p-0" /></template>
  </div>)
}

export function manualPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="海面" help="打开建筑一览时会读取工厂、农田和居民订单。点击工厂的「查看排产」可查看各生产格的情况。">
      <div id="world-view" role="status" />
      <div id="world-factories"></div>
      <div id="world-orders"></div>
    </Panel>
    <Panel title="需求联合排产" help="按用户配置的需求优先级逐级优化齐套时间，上游材料继承对应优先级。共享原料和生产位统一安排，独立设施并行生产。结果显示分层工期、投料顺序、时长依据和阻塞原因。">
      <div className="bar"><Button id="production-plan-refresh" variant="outline">计算联合排产</Button><span id="production-plan-status" className="dim" role="status">连接后可计算</span></div>
      <div id="production-plan-result" aria-live="polite" />
    </Panel>
  </div>)
}

export function inventoryPage() {
  return renderToStaticMarkup(<div className="grid gap-3"><Panel title="背包">
    <div className="bag-tabs" role="group" aria-label="背包分类">
      <Button type="button" variant="outline" data-bag-tab="items" aria-pressed="true"><Package aria-hidden="true" />道具</Button>
      <Button type="button" variant="outline" data-bag-tab="antiques" aria-pressed="false"><Gem aria-hidden="true" />藏品</Button>
      <Button type="button" variant="outline" data-bag-tab="heroes" aria-pressed="false"><UsersRound aria-hidden="true" />英雄</Button>
    </div>
    <div id="bag-items">
    <div className="bar"><Button id="inventory-refresh" variant="outline">刷新库存</Button><span id="inventory-status" className="dim" role="status">尚未读取</span></div>
    <div className="bar inventory-search"><label htmlFor="inventory-query">资源名称</label><Input id="inventory-query" type="search" placeholder="搜索资源名称" /><span id="inventory-match-count" className="dim" /></div>
    <details id="world-stock-panel" open><summary>分类库存</summary><div id="world-stock" /></details>
    </div>
    <div id="bag-heroes" hidden>
      <div className="bar"><Button id="bag-hero-refresh" type="button" variant="outline">刷新英雄</Button><span id="bag-hero-status" role="status" className="dim" /></div>
      <div className="bag-search"><label htmlFor="bag-hero-query">搜索英雄</label><Input id="bag-hero-query" type="search" placeholder="输入名称" /></div>
      <p id="bag-hero-matches" className="dim" role="status" hidden />
      <div id="bag-hero-list" className="bag-hero-grid" />
    </div>
    <div id="bag-antiques" hidden>
      <div className="bar"><Button id="bag-antique-refresh" type="button" variant="outline">刷新藏品</Button><span id="bag-antique-status" role="status" className="dim" /></div>
      <div className="bag-search"><label htmlFor="bag-antique-query">搜索藏品或套装</label><Input id="bag-antique-query" type="search" placeholder="输入名称" /></div>
      <p id="bag-antique-matches" className="dim" role="status" hidden />
      <div id="bag-antique-list" className="bag-antique-grid" />
    </div>
  </Panel></div>)
}

export function heroesPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="英雄任命" help="开启后随自动挂机，使用游戏一键委任分配英雄，已有任命可能调整。" titleAfter={<div className="bar"><label htmlFor="appointments-enabled">自动委任</label><Switch id="appointments-enabled" className="p-0" disabled /></div>}>
      <div className="appointments-heading"><h4 id="appointments-priority-title">委任优先级</h4><span id="appointments-state" className="dim" role="status">请选择账号</span></div>
      <p id="appointments-help" className="dim">上方项目优先委任。拖动手柄或使用上移、下移调整，修改后自动保存。</p>
      <ol id="appointments-priorities" className="appointments-priorities" aria-labelledby="appointments-priority-title" aria-describedby="appointments-help" />
      <div className="bar"><Button id="appointments-retry" variant="outline" size="sm" hidden>重试保存</Button><Button id="appointments-reload" variant="outline" size="sm" hidden>重新载入</Button><span id="appointments-feedback" className="sr-only" aria-live="polite" /></div>
    </Panel>
    <Panel title="英雄装备">
      <div className="bar"><Button id="equipment-refresh" variant="outline">刷新装备</Button></div>
      <div id="equipment-view" className="progression-view" aria-live="polite" />
    </Panel>
    <Panel title="装备制造"><div className="bar"><Button id="crafting-refresh" variant="outline">刷新装备厂</Button></div><div id="crafting-view" className="progression-view" aria-live="polite" /></Panel>
  </div>)
}

export function lineupsPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Panel title="我的阵容" help="管理已保存的自定义阵容，点击查看或在弹窗中编辑。主线和试炼可在各自入口选择阵容，挑战结束后自动还原到挑战前的搭配。">
      <div id="saved-lineup-view" className="progression-view" />
    </Panel>
  </div>)
}

export function accountPage() {
  return renderToStaticMarkup(<div className="account-page">
    <div className="account-page-heading">
      <div className="account-page-title"><h2 className="text-xl font-semibold">账号</h2><span id="account-count" className="dim" aria-live="polite">正在读取</span></div>
      <div className="account-page-actions">
        <Button id="import-accounts" type="button" variant="outline">导入账号</Button>
        <input id="import-accounts-file" type="file" accept=".json,application/json" aria-label="选择账号备份文件" hidden />
        <Button id="export-accounts" type="button" variant="outline" aria-haspopup="dialog" aria-controls="account-export-dialog">导出账号</Button>
        <Button id="account-add" type="button" aria-haspopup="dialog" aria-controls="account-add-dialog"><Plus aria-hidden="true" />添加账号</Button>
      </div>
    </div>
    <p className="dim">新账号默认不挂机，点击「开始挂机」后才会持续运行；每个账号可通过「登录设置」单独配置自动重连策略。</p>
    <p id="account-add-notice" className="dim" role="status" hidden />
    <p id="account-transfer-notice" className="dim" role="status" aria-live="polite" hidden />
    <div id="accounts" className="account-grid" />

    <dialog id="account-login-dialog" aria-labelledby="account-login-title">
      <div className="account-dialog-heading"><DialogHeader><DialogTitle id="account-login-title" className="leading-snug">登录设置</DialogTitle></DialogHeader><Button id="account-login-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭登录设置"><X aria-hidden="true" /></Button></div>
      <div id="login-settings-root" data-account="">
        <p role="status" className="dim">正在载入登录设置…</p>
        <noscript>请启用 JavaScript 后编辑登录设置。</noscript>
      </div>
    </dialog>

    <dialog id="account-export-dialog" aria-labelledby="account-export-title" aria-describedby="account-export-scope">
      <div className="account-dialog-heading"><DialogHeader><DialogTitle id="account-export-title">导出账号</DialogTitle></DialogHeader><Button id="account-export-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭账号导出"><X aria-hidden="true" /></Button></div>
      <div className="account-export-selection">
        <label className="account-export-all"><input id="account-export-all" type="checkbox" />全选账号</label>
        <p id="account-export-scope" className="dim" role="status" aria-live="polite" />
      </div>
      <div id="account-export-list" role="group" aria-label="选择要导出的账号" />
      <div className="grid gap-3">
        <Button id="account-export-only" type="button" variant="outline" className="h-auto pointer-coarse:h-auto whitespace-normal justify-start p-4"><span className="grid gap-1 text-left"><strong>仅账号</strong><span className="text-xs font-normal">保存登录凭据、备注和角色资料</span></span></Button>
        <Button id="account-export-settings" type="button" variant="outline" className="h-auto pointer-coarse:h-auto whitespace-normal justify-start p-4"><span className="grid gap-1 text-left"><strong>账号及配置</strong><span className="text-xs font-normal">同时保存每个账号的挂机配置和阵容预设</span></span></Button>
      </div>
      <p className="dim">文件含登录凭据，请妥善保管。配置不包含用量账本和运行状态。</p>
      <p id="account-export-error" className="warn" role="alert" hidden />
    </dialog>

    <dialog id="account-info-dialog" aria-labelledby="account-info-title">
      <div className="account-dialog-heading"><DialogHeader><DialogTitle id="account-info-title" className="leading-snug">账号详情</DialogTitle></DialogHeader><Button id="account-info-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭账号详情"><X aria-hidden="true" /></Button></div>
      <div className="bar"><Button id="account-info-refresh" type="button" variant="outline">连接并读取</Button></div>
      <div id="account-details">
        <h4>角色概况</h4><div className="who" id="who">等待连接</div>
        <h4>资源</h4><div className="resource-strip" id="res">连接后显示</div>
        <h4>区服</h4>
        <div className="bar"><Button id="load-worlds" variant="outline">加载区服</Button><Input id="world-input" aria-label="区服 ID" placeholder="区服 ID" className="w-32" /><Button id="enter-world" variant="outline">进入该区服</Button><span id="worlds-hint" className="warn" /></div>
        <div id="worlds" />
      </div>
    </dialog>

    <dialog id="account-add-dialog" aria-labelledby="account-add-title" aria-describedby="account-add-step">
      <div className="account-dialog-heading"><DialogHeader><p id="account-add-step" className="dim" role="status">选择登录渠道</p><DialogTitle id="account-add-title" className="leading-snug">添加账号</DialogTitle></DialogHeader><Button id="account-add-close" type="button" size="icon-sm" variant="ghost" aria-label="关闭添加账号"><X aria-hidden="true" /></Button></div>
      <div className="account-add-body">
        <p id="account-add-feedback" className="phone-feedback" role="status" aria-live="polite" aria-atomic="true" />
        <div id="account-add-channels" className="account-channel-grid">
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="wechat-qr"><QrCode className="size-[22px]" aria-hidden="true" /><span><strong>微信扫码</strong><span>手机微信授权，选择游戏角色</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="alipay"><QrCode className="size-[22px]" aria-hidden="true" /><span><strong>支付宝</strong><span>扫码登录，选择游戏角色</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="phone"><Smartphone className="size-[22px]" aria-hidden="true" /><span><strong>益世界 APP</strong><span>账号密码或短信验证码</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="wechat"><MessageCircle className="size-[22px]" aria-hidden="true" /><span><strong>微信小游戏</strong><span>从电脑微信读取登录信息</span></span></Button>
          <Button type="button" variant="outline" className="account-channel h-auto pointer-coarse:h-auto items-start justify-start gap-3.5 p-5 has-[>svg]:px-5 whitespace-normal text-left" data-login-channel="douyin"><Music2 className="size-[22px]" aria-hidden="true" /><span><strong>电脑抖音采集</strong><span>从电脑抖音读取登录信息</span></span></Button>
        </div>
        <section id="account-add-alipay" hidden>
          <div id="alipay-flow" className="alipay-flow">
            <div className="bar"><Button id="alipay-start" type="button">生成二维码</Button><Button id="alipay-cancel" type="button" variant="outline" hidden>取消</Button></div>
            <img id="alipay-qr" className="alipay-qr" alt="支付宝扫码登录二维码" width="256" height="256" hidden />
            <p id="alipay-hint" className="phone-feedback dim" role="status" aria-live="polite" aria-atomic="true">点击「生成二维码」，然后使用支付宝扫一扫。</p>
            <div id="alipay-roles" hidden />
            <p id="alipay-result" hidden />
            <p id="alipay-expiry" className="dim" />
            <div className="bar"><Button id="alipay-save" type="button" hidden disabled>保存所选角色</Button><Button id="alipay-roles-retry" type="button" variant="outline" hidden>重新读取角色</Button></div>
          </div>
          <p className="dim">本机需安装 Edge 或 Chrome。扫码后会进入游戏，可能让同账号的游戏客户端下线。</p>
        </section>
        <section id="account-add-wechat" hidden>
          <div id="wechat-flow" className="wechat-flow">
            <div className="bar"><Button id="wechat-start" type="button">生成二维码</Button><Button id="wechat-cancel" type="button" variant="outline" hidden>取消</Button></div>
            <img id="wechat-qr" className="wechat-qr" alt="微信扫码登录二维码" width="256" height="256" hidden />
            <p id="wechat-hint" className="phone-feedback dim" role="status" aria-live="polite" aria-atomic="true">点击「生成二维码」，然后使用微信扫一扫。</p>
            <div id="wechat-roles" hidden />
            <p id="wechat-result" hidden />
            <p id="wechat-expiry" className="dim" />
            <div className="bar"><Button id="wechat-save" type="button" hidden disabled>保存所选角色</Button><Button id="wechat-roles-retry" type="button" variant="outline" hidden>重新读取角色</Button></div>
          </div>
          <p className="dim">读取角色会登录游戏，可能让同账号的游戏客户端下线。</p>
        </section>
        <section id="account-add-phone" hidden>
          <p id="phone-step" className="sr-only" role="status">登录验证 → 选择区服和角色 → 保存并切换</p>
          <div className="phone-layout">
            <div id="phone-flow">
              <div id="phone-entry">
                <div className="config-subtabs phone-tabs" role="tablist" aria-label="APP 登录方式">
                  <button type="button" id="phone-password-tab" role="tab" aria-selected="true" aria-controls="phone-password-panel">账号密码</button>
                  <button type="button" id="phone-sms-tab" role="tab" aria-selected="false" aria-controls="phone-sms-panel" tabIndex={-1}>短信验证码</button>
                </div>
                <form id="phone-password-panel" className="phone-form" role="tabpanel" aria-labelledby="phone-password-tab" noValidate>
                  <div className="choice-field"><label htmlFor="phone-account">APP 账号或绑定手机号</label><Input id="phone-account" name="username" placeholder="输入益世界账号或手机号" autoComplete="username" aria-describedby="phone-hint" /></div>
                  <div className="choice-field"><label htmlFor="phone-password">APP 登录密码</label><div className="phone-input-action"><Input id="phone-password" name="password" type="password" placeholder="输入 APP 的登录密码" autoComplete="current-password" aria-describedby="phone-password-help phone-hint" /><Button id="phone-password-toggle" type="button" variant="outline" aria-label="显示密码" aria-pressed="false">显示</Button></div><p id="phone-password-help" className="dim">忘记密码可切换短信验证码，或在游戏 APP 中找回。</p></div>
                  <Button id="phone-login" type="submit">登录并读取角色</Button>
                </form>
                <form id="phone-sms-panel" className="phone-form" role="tabpanel" aria-labelledby="phone-sms-tab" noValidate hidden>
                  <div className="choice-field"><label htmlFor="phone-number">APP 绑定手机号</label><Input id="phone-number" name="tel" type="tel" placeholder="输入 11 位大陆手机号" inputMode="tel" autoComplete="tel-national" aria-describedby="phone-sms-help phone-hint" /></div>
                  <div className="choice-field"><label htmlFor="phone-code">短信验证码</label><div className="phone-input-action"><Input id="phone-code" name="code" placeholder="输入收到的验证码" inputMode="numeric" autoComplete="one-time-code" aria-describedby="phone-sms-help phone-hint" /><Button id="phone-send-code" type="button" variant="outline">获取验证码</Button></div><p id="phone-sms-help" className="dim">先获取验证码，再填写短信中的验证码登录。</p></div>
                  <Button id="phone-sms-login" type="submit">验证并读取角色</Button>
                </form>
              </div>
              <p id="phone-hint" className="phone-feedback" role="status" aria-live="polite" aria-atomic="true" />
              <section id="phone-preview" aria-labelledby="phone-preview-title" hidden>
                <h3 id="phone-preview-title" tabIndex={-1}>选择区服和游戏角色</h3>
                <div id="phone-result" />
                <p id="phone-selection" className="dim" role="status">请选择要使用的角色。</p>
                <p id="phone-expiry" className="dim" />
                <div className="bar"><Button id="phone-save" type="button" disabled>保存所选角色</Button><Button id="phone-roles-retry" type="button" variant="outline" hidden>重试读取失败的账号</Button><Button id="phone-back" type="button" variant="outline">返回修改</Button></div>
              </section>
              <section id="phone-success" aria-labelledby="phone-success-title" hidden>
                <h3 id="phone-success-title" tabIndex={-1}>账号已保存</h3>
                <p id="phone-saved-account" />
                <p id="phone-success-next" className="dim">账号已保存，尚未开始挂机。可先在「挂机配置」设置任务，再点击账号卡片或页头的「开始挂机」。</p>
                <Button id="phone-add-another" type="button" variant="outline">添加其他 APP 账号</Button>
              </section>
            </div>
            <aside className="phone-help" aria-label="APP 登录准备">
              <p id="phone-device-status" className="dim" role="status">正在检查本机设备档案…</p>
              <details id="phone-device-details">
                <summary>高级选项 · 导入设备档案</summary>
                <p className="dim">已有 APP 设备档案可在此导入，用于兼容性排查。</p>
                <p className="dim">档案需包含 di 和 deviceCode，oi 可自动补全。保存后会在后续登录中复用。</p>
                <div className="choice-field"><label htmlFor="phone-device-file">导入设备档案 JSON</label><Input id="phone-device-file" type="file" accept=".json,application/json" /></div>
                <p id="phone-device-path" className="dim" />
                <Button id="phone-device-refresh" type="button" variant="outline" size="sm">重新检查</Button>
              </details>
              <p id="phone-device-hint" className="phone-feedback" role="status" aria-live="polite" />
              <p className="dim">密码和验证码仅用于本次验证。读取角色时会登录游戏，可能让同账号的游戏客户端下线。</p>
            </aside>
          </div>
        </section>
        <section id="account-add-capture" hidden>
          <div className="bar"><Button id="cap-start" type="button" hidden>开始读取微信账号</Button><Button id="cap-douyin" type="button" hidden>开始读取抖音账号</Button><Button id="cap-stop" type="button" variant="outline" hidden>停止读取</Button><Button id="cap-recover" type="button" variant="outline" hidden>恢复上次采集残留</Button></div>
          <p id="cap-hint" className="phone-feedback" role="status" aria-live="polite" />
          <div id="cap-box" />
        </section>
      </div>
      <DialogFooter className="account-add-footer"><Button id="account-add-done" type="button" hidden>完成</Button><Button id="account-add-back" type="button" variant="outline" hidden>返回</Button></DialogFooter>
    </dialog>
  </div>)
}

// Client-rendered page; its bundle is loaded when the tab is first opened.

export function guildPage() {
  return renderToStaticMarkup(<div className="grid gap-3">
    <Card>
      <CardHeader>
        <CardTitle>联盟求助</CardTitle>
        <CardAction className="row-span-1 self-center"><Button id="guild-refresh" variant="outline" size="sm">刷新求助</Button></CardAction>
      </CardHeader>
      <CardContent><div id="guild-aid-view" className="progression-view" /></CardContent>
    </Card>
    <Card className="gap-3 max-md:gap-3">
      <CardHeader>
        <CardTitle className="title-with-help">联盟科技<HelpTip title="联盟科技">等级上限随赛季阶段开放。选择一项科技可设置目标等级，确认费用后逐级升级。</HelpTip></CardTitle>
        <CardAction className="row-span-1 self-center"><Button id="guild-tech-refresh" variant="outline" size="sm">刷新科技</Button></CardAction>
      </CardHeader>
      <CardContent><div id="guild-tech-view" aria-live="polite" /></CardContent>
    </Card>
  </div>)
}
