'use strict';
const { ValidationError } = require('../db/errors');
class PackingListTransactionService {
  constructor(db, repositories, { onStep = () => {} } = {}) {
    this.repositories = repositories; this.onStep = onStep;
    this.saveTransaction = db.transaction(input => this.saveInsideTransaction(input));
  }
  saveInsideTransaction({ order, packingList, expectedOrderVersion, expectedPackingListVersion }) {
    if (!order || !packingList || packingList.orderId !== order.id) throw new ValidationError('Packing List must reference the saved order');
    const savedOrder = this.repositories.orders.put(order, expectedOrderVersion);
    this.onStep('after-order-write');
    const savedPackingList = this.repositories.packingLists.put(packingList, expectedPackingListVersion);
    this.onStep('after-packing-list-write');
    return { order: savedOrder, packingList: savedPackingList };
  }
  saveOrderAndPackingList(input) { return this.saveTransaction(input); }
}
module.exports = { PackingListTransactionService };
