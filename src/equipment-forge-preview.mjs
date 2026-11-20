import { readEquipmentForge, planEquipmentForge, forgeEnabled } from './equipment-forge.mjs';
import { createWeeklyActivityContext } from './weekly-activity.mjs';
import { weeklyActivityActionSettings } from './weekly-activity-runner.mjs';

// Weekly participation may enable today's work independently of the ordinary
// switches. When it waits, the ordinary plan still follows its own settings.
export async function previewEquipmentForge(client, protocol, config, player, settings, {
  keys = {}, enabled = () => true,
} = {}) {
  const epoch = client.connectionEpoch;
  const snapshot = await readEquipmentForge(client, protocol, config, player, { enabled });
  const original = planEquipmentForge(snapshot, config, settings, { keys });
  const weekly = settings?.weeklyActivity;
  if (!weekly?.enabled || !weekly.forgeEnabled || settings.forge.nativeAuto) {
    return { snapshot, plan: original };
  }

  let context = null;
  const reasons = [];
  try {
    context = await createWeeklyActivityContext(client, config, player, {
      getSettings: () => settings, enabled,
      report: entry => { if (entry.reason) reasons.push(entry.reason); },
    });
  } catch (error) {
    reasons.push('军备竞赛状态未确认：' + error.message);
  }
  const contextCurrent = context?.enabled() === true;
  if (!enabled() || client.connected === false || client.connectionEpoch !== epoch || context && !contextCurrent) {
    const reason = '活动日期、配置或连接已变化，请重新预览';
    original.actions = [];
    original.notes.unshift(reason);
    for (const factory of original.factories) factory.reason = reason;
    return { snapshot, plan: original };
  }
  if (context?.kind === 'forge' && contextCurrent) {
    const effective = weeklyActivityActionSettings(context, config);
    const plan = planEquipmentForge(snapshot, config, effective, { keys });
    plan.notes.unshift('当前为装备打造主题，军备竞赛独立执行领取和制造，普通锻造开关关闭也可参与。普通锻造与军备竞赛共用工厂下单记录，同一批次只下单一次。');
    return { snapshot, plan };
  }

  const reason = '军备竞赛装备打造暂不执行：' + (context
    ? '今日为' + context.label + '，等待装备打造日'
    : reasons.join('；') || '活动条件尚未确认，等待装备打造日');
  original.notes.unshift(reason + (forgeEnabled(settings) ? '；普通自动锻造按自身配置执行' : '；普通自动锻造未开启'));
  if (!forgeEnabled(settings)) {
    for (const factory of original.factories) factory.reason = reason + '；' + factory.reason;
  }
  return { snapshot, plan: original };
}
