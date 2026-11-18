import path from 'node:path';
import { atomicJson, readJson, withFileLock } from '../json-store.mjs';

export const releases = [
  { version: '2026.11.19.3', date: '2026-11-19', title: '微信扫码登录', items: [
    '添加账号支持获取微信登录二维码，手机扫码授权后读取游戏角色，选择角色后保存。',
    '微信扫码授权服务在服务器按需启动，无需用户安装证书、代理或采集EXE；二维码会话按后台用户隔离。',
    '取消、刷新和超时会清理临时登录结果，新游戏账号仍默认不挂机。',
  ] },
  { version: '2026.11.19.2', date: '2026-11-19', title: '移除本机抓包功能', items: [
    '移除微信、抖音本机代理抓包入口及证书安装、系统代理修改和恢复接口。',
    '移除Windows采集EXE、原生源码、采集脚本及下载接口；保留支付宝扫码、APP登录、账号导入及已有账号数据。',
  ] },
  { version: '2026.11.19.1', date: '2026-11-19', title: '礼包记录重试与登录时长', items: [
    '兑换记录增加可手动重试筛选和逐条重试按钮，支持限频或未识别提示码的明确拒绝，保留原始记录。',
    '重试前重新检查账号权限、完整兑换历史和过期状态，成功、已兑换及结果待确认的码禁止重发；导出沿用当前筛选。',
    '后台登录有效期调整为24小时，重新登录后生效。',
  ] },
  { version: '2026.11.18.7', date: '2026-11-18', title: '公共礼包码库与自动兑换', items: [
    '每天早上8点检查同步指定网站的礼包码；点击载入会立即检查当天缓存，当天已成功抓取则不重复访问网站。',
    '礼包码改为表格展示可用状态、使用状态和到期日期，支持为所选游戏账号新增个人礼包码行。',
    '取消100条分批限制，新账号也可一次载入公共库中所有历史未到期码。',
    '按每个游戏账号的兑换历史过滤已兑换、已处理和待确认的码，过滤发生在展示和创建发送队列之前。',
    '每个游戏账号可独立开启自动兑换历史和新码，默认关闭；暂停、关闭或限频后保留未发送的剩余任务。',
    '根据来源到期日期移除过期码；任一账号收到明确过期反馈后全局下架，并防止下次抓取重新加入。',
  ] },
  { version: '2026.11.18.6', date: '2026-11-18', title: 'Windows 独立微信采集助手', items: [
    '提供 Windows 64 位独立 EXE，内置 SSL/TLS 和证书生成，无需安装 Node.js、Python 或 OpenSSL。',
    '启动检测本机证书，支持一键安装当前用户证书、自动展示证书及选择目录另存公开证书。',
    '支持本机微信登录包采集、导出控制台兼容的账号 JSON，以及停止、超时或退出后的代理恢复。',
    'Windows 证书安装和微信实抓仍需真机验证，可继续使用已有脚本版采集助手。',
  ] },
  { version: '2026.11.18.5', date: '2026-11-18', title: '更新记录与版本提醒', items: [
    '增加更新记录入口，可查看每次更新的功能、日期和版本。',
    '登录后自动展示最新版本的更新内容；关闭后按后台用户保存已读状态，同一版本不再提示。',
  ] },
  { version: '2026.11.18.4', date: '2026-11-18', title: '城战加速条件提示', items: [
    '明确维修及派遣钻石加速的总开关、逐队开关和预算生效条件。',
    '逐队展示加速未生效的原因，支持直接跳转到需要调整的设置。',
  ] },
  { version: '2026.11.18.3', date: '2026-11-18', title: '账号登录设置与玩法更新', items: [
    '账号卡片增加独立登录设置，可为不同游戏账号配置自动重连策略。',
    '活动独立为顶级标签，其余功能归并到杂项；调整限时活动、海上风采大赛和任务领奖的配置入口。',
    '合并海盗扫荡与讨伐配置入口，移除旧联盟订单的重复入口。',
    '世界首领支持多舰队共同出战、临时使用预设阵容，并在返航后恢复原阵容。',
    '英雄技能展示领奖覆盖全部已拥有英雄。',
  ] },
  { version: '2026.11.18.2', date: '2026-11-18', title: '自动化与活动体验更新', items: [
    '装备锻造支持独立领取及游戏原生自动锻造模式。',
    '完善博物馆自动探宝、推荐选队和自动陈列，并兼容旧配置迁移。',
    '优化活动页渐进加载和重复查询，调整挂机配置分组与折叠交互。',
    '联盟商船结算前十分钟停止上船及备料。',
    '调整钻石消耗提示，移除旧汽油限制和城战加速合计上限，保留各项有效预算约束。',
  ] },
  { version: '2026.11.18.1', date: '2026-11-18', title: '后台用户管理与界面优化', items: [
    '管理员可创建、停用、删除后台用户，重置密码，并分配游戏账号。',
    '同一游戏账号可共享给多个后台用户，普通用户仅能查看和操作获分配的账号。',
    '优化控制台、登录页及后台用户管理界面，兼容手机浏览器。',
    '定制样式单独维护，减少后续同步主线时的合并冲突。',
  ] },
  { version: '2026.11.18.0', date: '2026-11-18', title: '礼包记录与本机微信采集', items: [
    '礼包兑换记录支持选择每页条数、按状态筛选及 CSV 导出，导出遵循当前筛选条件。',
    '增加 macOS 和 Windows 本机微信登录采集工具，采集后可将游戏账号导入服务器控制台。',
  ] },
  { version: '2026.11.17.1', date: '2026-11-17', title: '登录鉴权与手机支持', items: [
    '控制台增加后台登录鉴权，登录后方可访问页面、接口和实时日志。',
    '支持多游戏账号独立管理和挂机，提供支付宝扫码、手机号及电脑微信采集入口。',
    '适配手机浏览器及支付宝登录跳转，中文密码可切换显示后输入。',
  ] },
];

export function createReleaseNotes(directory) {
  const file = path.join(directory, 'console-release-reads.json');
  const history = () => {
    const deployed = readJson(path.join(directory, 'console-deployment-history.json'), []);
    if (!Array.isArray(deployed) || deployed.some(entry => !entry || typeof entry.version !== 'string' || !Array.isArray(entry.items)
      || entry.items.some(item => typeof item !== 'string') || typeof entry.title !== 'string' || typeof entry.date !== 'string')) throw Error('部署更新记录无效');
    return [...deployed.map(({ author, ...entry }) => entry), ...releases];
  };
  const read = () => {
    const data = readJson(file, { version: 1, readers: {} });
    if (data?.version !== 1 || !data.readers || typeof data.readers !== 'object' || Array.isArray(data.readers)) throw Error('更新记录已读数据无效');
    return data;
  };
  return {
    view(userId) {
      const entries = history();
      return { releases: entries, latestVersion: entries[0].version, unread: read().readers[userId] !== entries[0].version };
    },
    acknowledge(userId, version) {
      const entries = history();
      const index = entries.findIndex(release => release.version === version);
      if (index < 0) throw Error('更新版本不存在，请刷新页面');
      withFileLock(file, () => {
        const data = read();
        const previous = entries.findIndex(release => release.version === data.readers[userId]);
        if (previous >= 0 && previous <= index) return;
        data.readers[userId] = version;
        atomicJson(file, data);
      });
      return { ok: true };
    },
  };
}
