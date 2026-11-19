export const giftRecordLabels = { queued:'待兑换', sending:'兑换中', success:'兑换成功', used:'已兑换', rejected:'服务器拒绝', unknown:'待确认', skipped:'未发送' };
const invalidDetails = new Set(['礼包码已过期','礼包码无效','不在兑换有效期','已达到兑换上限','已由其他账号兑换']);
export const canRetryGiftRecord = row => row.status === 'rejected' && (row.promptName === 'GIFT_CODE_TOO_MANY_REQUESTS' || row.detail === '请求过于频繁' || (!row.promptName && /^服务器拒绝，提示码 \d+$/.test(row.detail ?? '')));
export const canRetryGiftCode = (rows, code) => {
  const history = rows.filter(row => row.code === code);
  return history.some(canRetryGiftRecord) && history.every(row => canRetryGiftRecord(row) || row.status === 'skipped');
};
const filters = new Set(['all','exclude-invalid','invalid','retryable',...Object.keys(giftRecordLabels)]);
export function filterGiftRecords(rows, status = 'exclude-invalid') {
  if (!filters.has(status)) throw new Error('不支持的兑换记录状态');
  const invalid = row => row.status === 'rejected' && invalidDetails.has(row.detail);
  return rows.filter(row => status === 'all' || (status === 'retryable' ? canRetryGiftRecord(row) && canRetryGiftCode(rows,row.code) : status === 'invalid' ? invalid(row)
    : status === 'exclude-invalid' ? !invalid(row) : row.status === status));
}
export function paginateGiftRecords(rows, { page = '1', pageSize = '10', status = 'exclude-invalid' } = {}) {
  if (!/^[1-9][0-9]*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) throw new Error('页码无效');
  if (![10,20,50,100].includes(Number(pageSize))) throw new Error('每页条数仅支持 10、20、50、100');
  const filtered = filterGiftRecords(rows, status);
  const total = filtered.length, pages = Math.max(1,Math.ceil(total / Number(pageSize)));
  const current = Math.min(Number(page),pages);
  return { rows:filtered.slice((current-1)*Number(pageSize),current*Number(pageSize)), total, pages, page:current, pageSize:Number(pageSize), status };
}
export function giftRecordsCsv(rows, status) {
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"','""') + '"';
  };
  return '\uFEFF' + [['礼包码','渠道','兑换方式','状态','结果','时间'],...filterGiftRecords(rows,status).map(row => [row.code,row.channels?.join('、') || '未记录',row.automatic === true ? '自动' : row.automatic === false ? '手动' : '未记录',giftRecordLabels[row.status] || row.status,row.detail,row.at])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
