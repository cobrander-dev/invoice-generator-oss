'use strict';
// Decides whether a business record may be permanently deleted. A record that other
// business records still depend on is never deleted: the blockers explain why, and the
// record can be archived (or voided) instead. Every check runs against the database, so
// it covers all owners, not only the records the requesting user can see.

const MESSAGES = Object.freeze({
  CUSTOMER_HAS_ORDERS: (count) => `已有 ${count} 个订单使用该客户`,
  PRODUCT_USED_BY_ORDERS: (count) => `已有 ${count} 个订单使用该产品`,
  ORDER_HAS_FINAL_PI: () => '已生成 Final PI',
  ORDER_HAS_CI: () => '已生成商业发票（CI）',
  ORDER_HAS_PACKING_LIST: () => '已生成装箱单（Packing List）',
  ORDER_HAS_PAYMENTS: (count) => `已有 ${count} 条收款记录`,
  ACCOUNT_USED_BY_ORDERS: (count) => `已有 ${count} 个订单使用该收款账户`,
});

function blocker(code, count = 1) {
  return { code, count, message: MESSAGES[code](count) };
}

function customerBlockers(db, id) {
  const { count } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE customer_id = ? OR json_extract(payload_json, '$.customerId') = ?",
    )
    .get(id, id);
  return count ? [blocker('CUSTOMER_HAS_ORDERS', count)] : [];
}

function productBlockers(db, id) {
  // Order lines keep a copy of the product, but the line still names its source product.
  const { count } = db
    .prepare(
      `SELECT COUNT(DISTINCT orders.id) AS count
         FROM orders, json_each(orders.payload_json, '$.items') AS item
        WHERE json_extract(item.value, '$.productId') = ?`,
    )
    .get(id);
  return count ? [blocker('PRODUCT_USED_BY_ORDERS', count)] : [];
}

function orderBlockers(db, row) {
  const order = row.payload || {},
    id = order.id,
    result = [];
  if (
    (Array.isArray(order.piHistory) && order.piHistory.length) ||
    order.piVersion === 'Final' ||
    order.piSignedAt
  )
    result.push(blocker('ORDER_HAS_FINAL_PI'));
  if (order.ciDocument || order.ciNumber) result.push(blocker('ORDER_HAS_CI'));
  const { count: packingLists } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM packing_lists WHERE order_id = ? OR json_extract(payload_json, '$.orderId') = ?",
    )
    .get(id, id);
  if (order.packingListDocument || order.packingListNumber || packingLists)
    result.push(blocker('ORDER_HAS_PACKING_LIST'));
  const payments = Array.isArray(order.paymentRecords) ? order.paymentRecords.length : 0;
  if (payments) result.push(blocker('ORDER_HAS_PAYMENTS', payments));
  return result;
}

function deletionBlockers(db, repository, row) {
  if (repository === 'customers') return customerBlockers(db, row.payload.id);
  if (repository === 'products') return productBlockers(db, row.payload.id);
  if (repository === 'orders') return orderBlockers(db, row);
  throw new Error('Unsupported deletion subject');
}

function paymentAccountBlockers(db, accountId) {
  const { count } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM orders WHERE json_extract(payload_json, '$.paymentAccountId') = ?",
    )
    .get(accountId);
  return count ? [blocker('ACCOUNT_USED_BY_ORDERS', count)] : [];
}

// Short identifier recorded in the audit log, so a deletion stays explainable afterwards.
function recordLabel(repository, payload = {}) {
  const text = (...values) => values.map((value) => String(value || '').trim()).find(Boolean) || '';
  if (repository === 'customers') return text(payload.companyName, payload.buyerName, payload.id);
  if (repository === 'products') return text(payload.sku, payload.englishName, payload.id);
  return text(payload.orderNumber, payload.piNumber, payload.id);
}

function blockedMessage(blockers) {
  return `无法永久删除：${blockers.map((item) => item.message).join('；')}。`;
}

module.exports = {
  MESSAGES,
  deletionBlockers,
  paymentAccountBlockers,
  recordLabel,
  blockedMessage,
};
