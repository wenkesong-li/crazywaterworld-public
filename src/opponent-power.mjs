import { toNumber } from './client.mjs';

export function filterOpponentsByPower(candidates, ownPower, maxPowerRatio = 0) {
  if (maxPowerRatio === 0) return { candidates, note: '' };
  const power = toNumber(ownPower);
  if (!Number.isSafeInteger(power) || power <= 0) {
    return { reason: '尚未取得有效的己方战力，无法核对对手战力上限' };
  }
  const limit = BigInt(power) * BigInt(maxPowerRatio) / 100n;
  const eligible = candidates.filter(row => {
    const opponent = toNumber(row.power);
    return Number.isSafeInteger(opponent) && opponent > 0 && BigInt(opponent) <= limit;
  });
  const note = `己方 ${power} × ${maxPowerRatio}%，上限 ${limit}`;
  if (!eligible.length) return { reason: `没有符合战力上限的对手（${note}）` };
  return { candidates: eligible, note: ' · ' + note };
}
