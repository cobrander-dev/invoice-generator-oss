'use strict';

const KINDS = Object.freeze({ order: { prefix: 'ORD', dateLength: 8 }, pi: { prefix: 'PI', dateLength: 6 }, ci: { prefix: 'CI', dateLength: 6 }, pl: { prefix: 'PL', dateLength: 6 } });

function periodFor(kind, date) {
  const rule = KINDS[kind];
  if (!rule) throw new Error('Unsupported document sequence kind');
  const digits = String(date || '').replace(/\D/g, '');
  if (digits.length < rule.dateLength) throw new Error('A valid document date is required');
  return digits.slice(0, rule.dateLength);
}
function numberField(kind) { return kind === 'order' ? 'orderNumber' : kind === 'pi' ? 'piNumber' : kind === 'ci' ? 'ciNumber' : 'packingListNumber'; }

class DocumentSequenceService {
  constructor(db, repositories) {
    this.db = db; this.repositories = repositories;
    this.getSequence = db.prepare('SELECT next_value FROM document_sequences WHERE kind=? AND period=?');
    this.setSequence = db.prepare(`INSERT INTO document_sequences(kind,period,next_value,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(kind,period) DO UPDATE SET next_value=excluded.next_value, updated_at=excluded.updated_at`);
    this.clearStatement = db.prepare('DELETE FROM document_sequences');
  }
  maxUsed(kind, period) {
    const rule = KINDS[kind], field = numberField(kind), rx = new RegExp(`^${rule.prefix}-${period}-(\\d{3})$`);
    return this.repositories.orders.list().reduce((max, row) => {
      const match = String(row.payload[field] || '').match(rx);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0);
  }
  allocate(kind, date) {
    const period = periodFor(kind, date), rule = KINDS[kind], stored = this.getSequence.get(kind, period)?.next_value || 1;
    const value = Math.max(stored, this.maxUsed(kind, period) + 1);
    this.setSequence.run(kind, period, value + 1, Date.now());
    return `${rule.prefix}-${period}-${String(value).padStart(3, '0')}`;
  }
  syncFromBusiness() {
    this.clearStatement.run();
    const seen = new Set();
    for (const row of this.repositories.orders.list()) for (const kind of Object.keys(KINDS)) {
      const value = String(row.payload[numberField(kind)] || ''), rule = KINDS[kind];
      const match = value.match(new RegExp(`^${rule.prefix}-(\\d{${rule.dateLength}})-(\\d{3})$`));
      if (match) seen.add(`${kind}\0${match[1]}`);
    }
    for (const entry of seen) {
      const [kind, period] = entry.split('\0');
      this.setSequence.run(kind, period, this.maxUsed(kind, period) + 1, Date.now());
    }
  }
  clear() { this.clearStatement.run(); }
}

module.exports = { DocumentSequenceService, periodFor, numberField };
