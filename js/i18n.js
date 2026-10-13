(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FTI18N = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Bilingual administration UI: Chinese first, English as a smaller secondary line.
  // Only UI vocabulary is translated. Document content (PI, CI, Packing List previews
  // and PDFs), stored values, field names and API payloads are never changed.

  // English UI term -> Chinese.
  const TERMS = Object.freeze({
    // Customers
    Customer: '客户',
    Customers: '客户',
    'Customer Identity': '客户主体',
    'Primary Contact': '主要联系人',
    'Buyer Address': '买方地址',
    'Consignee / Shipping Contact': '收货人',
    'Buyer Type': '客户类型',
    'Buyer Name': '买方名称',
    Buyer: '买方',
    'Company Name': '公司名称',
    'Registration Number': '注册号',
    'Tax Number': '税号',
    'Contact Person': '联系人',
    Contact: '联系人',
    'Contact Details': '联系方式',
    Email: '电子邮箱',
    Telephone: '电话',
    Website: '网站',
    Address: '地址',
    Country: '国家/地区',
    Consignee: '收货人',
    'Consignee Name': '收货人名称',
    'Consignee Country': '收货人国家/地区',
    'Consignee Telephone': '收货人电话',
    'Consignee Address': '收货人地址',
    Owner: '负责人',
    // Products
    Product: '产品',
    'Product Identity': '产品基本信息',
    'Product English Name': '产品英文名称',
    'Product Name': '产品名称',
    'Chinese Name': '中文名称',
    Model: '型号',
    SKU: '库存编号',
    'Model / SKU': '型号 / SKU',
    'SKU / Model': 'SKU / 型号',
    'Product Image': '产品图片',
    'Product Description': '产品描述',
    'Detailed Description': '详细描述',
    Description: '描述',
    Material: '材质',
    'Trade & Classification': '贸易与归类',
    'HS Code': 'HS 编码',
    'Country of Origin': '原产国',
    Origin: '原产地',
    Unit: '单位',
    'Default Pricing': '默认价格',
    'Default Unit Price': '默认单价',
    'Default Price': '默认价格',
    'Default Packing': '默认包装',
    'Carton Quantity': '每箱数量',
    'Net Weight (kg)': '净重（kg）',
    'Gross Weight (kg)': '毛重（kg）',
    'Carton Length (cm)': '箱长（cm）',
    'Carton Width (cm)': '箱宽（cm）',
    'Carton Height (cm)': '箱高（cm）',
    'Internal Notes': '内部备注',
    Notes: '备注',
    'Product Details': '产品信息',
    'Weight Details': '重量信息',
    'Packing Details': '包装信息',
    // Orders and documents (labels only; the documents themselves stay English)
    'Trade & Delivery': '贸易与交货',
    Payment: '付款',
    'Total Amount': '订单总额',
    'Deposit Required': '应付定金',
    'Amount Paid': '已收金额',
    'Outstanding Amount': '未收金额',
    'Amount Payable Now': '本次应付',
    'CI STATUS': 'CI 状态',
    'CI Number': 'CI 编号',
    'Related PI': '关联 PI',
    Revision: '修订版',
    '· Revision': '· 修订版',
    'Order Number': '订单编号',
    'Document Parties': '单据当事方',
    'Shipment Reference': '出货参考',
    'Related CI': '关联 CI',
    'Exporter / Seller': '出口商 / 卖方',
    'Actual Shipment Date': '实际发货日期',
    'Actual Transport Method': '实际运输方式',
    'Port of Loading': '装运港',
    'Port of Discharge': '卸货港',
    Incoterm: '贸易术语',
    'Actual Shipped Products': '实际出货产品',
    'PI Qty': 'PI 数量',
    'PI Quantity': 'PI 数量',
    'CI Qty / Actual Shipped Qty': 'CI 数量 / 实际出货数量',
    'CI Quantity': 'CI 数量',
    'Total Qty / Actual Shipped Qty': '总数量 / 实际出货数量',
    'Total Qty': '总数量',
    'Unit Price': '单价',
    Amount: '金额',
    Quantity: '数量',
    'CI Amount Summary': 'CI 金额汇总',
    'CI Total / Total Amount': 'CI 总额',
    Currency: '币种',
    'PI / CI Differences': 'PI / CI 差异',
    'Signing & Export': '签署与导出',
    Primary: '主要操作',
    Secondary: '其他操作',
    'Next Step': '下一步',
    'Incoterms® 2020': '国际贸易术语',
    'Show Packing List declaration': '显示装箱单声明',
    'Total Cartons': '总箱数',
    'Total N.W.': '总净重',
    'Total G.W.': '总毛重',
    'Total CBM': '总体积',
    'Document Identity': '单据信息',
    'Packaging details': '包装信息',
    'Product Context': '产品信息',
    'Weight per Carton': '每箱重量',
    'Carton Dimensions (cm)': '纸箱尺寸（cm）',
    'Packing List': '装箱单',
    'Packing List Declaration': '装箱单声明',
    'Packing List Number': '装箱单编号',
    'Packing List Quantity': '装箱数量',
    'Packing Remarks': '包装备注',
    'Package Type': '包装类型',
    'Shipping Mark': '唛头',
    'Shipping Marks / Marks & Numbers': '唛头',
    'Shipping Mark / Marks & Numbers': '唛头',
    'Tax ID': '税号',
    'Carton Number': '箱号',
    'Carton No.': '箱号',
    Cartons: '箱数',
    'Qty / Carton': '每箱数量',
    'Quantity per Carton': '每箱数量',
    'N.W. / Carton (KG)': '每箱净重（kg）',
    'G.W. / Carton (KG)': '每箱毛重（kg）',
    'Net Weight per Unit': '单件净重',
    'Gross Weight per Unit': '单件毛重',
    'N.W.': '净重',
    'G.W.': '毛重',
    CBM: '体积',
    Length: '长',
    Width: '宽',
    Height: '高',
    Dimensions: '尺寸',
    Item: '序号',
    // Company and bank accounts
    Company: '公司',
    Products: '产品',
    Orders: '订单',
    'Packing Lists': '装箱单',
    'PI History': 'PI 历史',
    'Payment Records': '收款记录',
    Attachments: '附件',
    'Internal Configuration': '内部配置',
    'Document Environment': '单据环境',
    'Document-facing information': '用于单据',
    'Company Identity': '公司主体',
    'Company English Name': '公司英文名称',
    'Contact & Registered Information': '联系与注册信息',
    'Authorized Signatory': '授权签字人',
    'Authorized Signatory Name': '授权签字人姓名',
    'Authorized Signatory Title': '授权签字人职务',
    'Document Assets': '单据资料',
    'Brand Assets': '品牌资料',
    'Signing Assets': '签章资料',
    'Bank Accounts': '收款账户',
    'Account Identity': '账户信息',
    Bank: '银行',
    'Routing & Account Details': '路由与账户信息',
    'Payment Reference': '付款参考',
    'Account Name': '账户名称',
    'Account Number': '账号',
    'Bank Name': '银行名称',
    'Bank Address': '银行地址',
    'Beneficiary Name': '收款人名称',
    'ACH Routing Number': 'ACH 路由号',
    'Wire Routing Number': '电汇路由号',
    'SWIFT/BIC': 'SWIFT 代码',
    IBAN: '国际银行账号',
    'Sort Code': '银行分类代码',
    'Local Clearing Code': '本地清算代码',
    // Dashboard, backup, users, audit, account
    'Server Environment': '服务器环境',
    'Data Safety / Environment': '数据安全与环境',
    'Data Safety': '数据安全',
    'Document Mode': '单据模式',
    'Last Full Backup': '最近完整备份',
    Reminder: '提醒',
    'Restore Point': '恢复点',
    'Read-only Summary': '只读摘要',
    'Current Server Data': '当前服务器数据',
    'Safe Operation': '安全操作',
    'Export Current Data': '导出当前数据',
    Recommended: '推荐',
    'High-risk Operation': '高风险操作',
    'Import Full Backup': '导入完整备份',
    'Full Replacement': '整体替换',
    'Single Recovery Slot': '单一恢复槽',
    'Latest Restore Point': '最新恢复点',
    'Irreversible-looking Operation': '需谨慎操作',
    'Dangerous Actions': '危险操作',
    'Export formats': '导出格式',
    'File Name': '文件名',
    'File Size': '文件大小',
    'Backup Version': '备份版本',
    'Created / Exported': '创建 / 导出时间',
    'Backup File Contents': '备份文件内容',
    'Display Name / Username': '显示名称 / 用户名',
    'Display Name': '显示名称',
    Username: '用户名',
    'Temporary Password': '临时密码',
    Status: '状态',
    Created: '创建时间',
    'Last Login': '最近登录',
    'Customers / Orders': '客户 / 订单',
    Time: '时间',
    User: '用户',
    Action: '操作',
    Actions: '操作',
    Entity: '对象',
    Result: '结果',
    IP: 'IP 地址',
    'Account Information': '账号信息',
    Role: '角色',
    'Change Password': '修改密码',
    'Current Password': '当前密码',
    'New Password': '新密码',
    'Confirm New Password': '确认新密码',
  });

  // English hints and notes shown in Chinese only (a second language would only add noise).
  const SENTENCES = Object.freeze({
    'CBM is calculated from the existing carton dimensions.': '体积根据纸箱尺寸自动计算。',
    'HS Code must be confirmed by the customs broker or declarant.':
      'HS 编码须由报关行或申报人确认。',
    'Currency is determined by the order.': '币种由订单决定。',
    'Optional reference image.': '可选的参考图片。',
    'Related PI:': '关联 PI：',
    // Short statuses shown in Chinese only.
    'Pending Final Requirements': '待补充 Final 所需资料',
    'Ready for Final': '可生成 Final',
  });

  // Chinese-only labels and headings -> English secondary line.
  const ZH_EN = Object.freeze({
    公司中文名: 'Company Chinese Name',
    其他实际运输方式: 'Other Actual Transport Method',
    其他用途: 'Other Purpose',
    其他计划运输方式: 'Other Planned Transport Method',
    其他运输单据类型: 'Other Transport Document Type',
    '物流公司 / 承运人': 'Carrier',
    '船名 / 航班号': 'Vessel / Flight No.',
    运输单据号码: 'Transport Document No.',
    运输单据类型: 'Transport Document Type',
    预计到达日期: 'Estimated Arrival Date',
    上传日期: 'Uploaded',
    产品: 'Product',
    分类: 'Category',
    单价: 'Unit Price',
    单位: 'Unit',
    单据编号: 'Document No.',
    大小: 'Size',
    客户: 'Customer',
    操作: 'Actions',
    文件名: 'File Name',
    文件类型: 'File Type',
    日期: 'Date',
    状态: 'Status',
    '订单 / PI': 'Order / PI',
    订单编号: 'Order No.',
    金额: 'Amount',
    最近订单: 'Recent Orders',
    快速操作: 'Quick Actions',
    快速上手: 'Getting Started',
    重要说明: 'Important Notes',
    基本订单信息: 'Order Basics',
    PI交易与付款信息: 'PI Terms & Payment',
    交易与交付条件: 'Trade & Delivery Terms',
    CI实际发货: 'Actual Shipment (CI)',
    产品明细: 'Products',
    金额与收款: 'Amounts & Payments',
    附件归档: 'Attachments',
    '客户备注 / 内部备注': 'Customer & Internal Notes',
    'PI历史 / 附件': 'PI History & Attachments',
  });

  // Options inside selects (plain text only, so a compact single language).
  const OPTIONS = Object.freeze({
    'All Countries': '全部国家/地区',
    'Production / 正式生产': '正式生产 Production',
    'Test / 测试样例': '测试样例 Test',
    'All Types': '全部类型',
    'All Units': '全部单位',
    'All Origins': '全部原产地',
    Company: '公司 Company',
    Individual: '个人 Individual',
    'Company / Buyer Name': '名称',
    Country: '国家/地区',
    'Recently Updated': '最近更新',
    'Product Name': '产品名称',
    SKU: 'SKU',
    'HS Code': 'HS 编码',
    Pending: '待确认',
    Confirmed: '已确认',
    Rejected: '已拒绝',
  });

  // Order workflow statuses are stored in English; the UI shows Chinese.
  const STATUSES = Object.freeze({
    Draft: '草稿',
    'PI Sent': 'PI 已发送',
    'Deposit Received': '已收定金',
    'In Production': '生产中',
    'Ready to Ship': '待出货',
    'Balance Received': '已收尾款',
    Shipped: '已发货',
    Completed: '已完成',
    Cancelled: '已取消',
    Pending: '待确认',
    Confirmed: '已确认',
    Rejected: '已拒绝',
    ACTIVE: '启用',
    DISABLED: '已停用',
    SUCCESS: '成功',
    FAILURE: '失败',
  });

  // Audit log action codes and entity types (stored English codes stay visible as reference).
  const AUDIT_ACTIONS = Object.freeze({
    LOGIN_SUCCESS: '登录成功',
    LOGIN_FAILED: '登录失败',
    LOGIN_RATE_LIMITED: '登录尝试过多，已暂时限制',
    CHANGE_PASSWORD: '修改密码',
    ADMIN_CLI_RESET_PASSWORD: '命令行重置管理员密码',
    CREATE_EMPLOYEE: '创建员工账号',
    UPDATE_EMPLOYEE: '修改员工资料',
    DISABLE_EMPLOYEE: '停用员工账号',
    ENABLE_EMPLOYEE: '启用员工账号',
    RESET_EMPLOYEE_PASSWORD: '重置员工密码',
    TRANSFER_OWNERSHIP: '转移客户归属',
    UPDATE_COMPANY: '修改公司资料',
    UPDATE_PAYMENT_ACCOUNTS: '修改收款账户',
    REPLACE_SIGNATURE: '更换签名',
    REPLACE_COMPANY_STAMP: '更换公司印章',
    UPDATE_META: '修改系统记录',
    CREATE_CUSTOMER: '新增客户',
    UPDATE_CUSTOMER: '修改客户',
    ARCHIVE_CUSTOMER: '归档客户',
    RESTORE_CUSTOMER: '恢复客户',
    PERMANENT_DELETE_CUSTOMER: '永久删除客户',
    CREATE_PRODUCT: '新增产品',
    UPDATE_PRODUCT: '修改产品',
    ARCHIVE_PRODUCT: '归档产品',
    RESTORE_PRODUCT: '恢复产品',
    PERMANENT_DELETE_PRODUCT: '永久删除产品',
    BULK_IMPORT_PRODUCTS: '批量导入产品',
    CREATE_ORDER: '新建订单',
    UPDATE_ORDER: '修改订单',
    VOID_ORDER: '作废订单',
    RESTORE_ORDER: '恢复订单',
    PERMANENT_DELETE_ORDER: '永久删除订单',
    FINALIZE_PI: '生成 Final PI',
    REVISE_PI: '修订 PI',
    GENERATE_CI: '生成 CI',
    CONFIRM_CI_DIFFERENCES: '确认 PI / CI 差异',
    FINALIZE_CI: '生成 Final CI',
    UPDATE_PAYMENT_TRACKING: '更新收款记录',
    GENERATE_PACKING_LIST: '生成装箱单',
    UPDATE_PACKING_LIST: '修改装箱单',
    FINALIZE_PACKING_LIST: '生成 Final 装箱单',
    EXPORT_BACKUP: '导出完整备份',
    IMPORT_BACKUP: '导入完整备份',
    RESTORE_BACKUP: '恢复到恢复点',
    CLEAR_BUSINESS_DATA: '清空业务数据',
  });
  const ENTITY_TYPES = Object.freeze({
    CUSTOMER: '客户',
    CUSTOMERS: '客户',
    PRODUCT: '产品',
    PRODUCTS: '产品',
    ORDER: '订单',
    ORDERS: '订单',
    PACKING_LIST: '装箱单',
    COMPANY: '公司',
    META: '系统记录',
    BACKUP: '备份',
    USER: '用户',
    AUTH: '登录',
  });

  // Server error texts (English API messages) -> Chinese for toasts and dialogs.
  const SERVER_ERRORS = [
    [/^(Business )?[Rr]ecord not found$|^Order not found$/, '记录不存在，或您无权访问该记录。'],
    [/^Archived or void records are read-only$/, '已归档或已作废的记录为只读，请先恢复后再修改。'],
    [/^Administrator permission is required$/, '此操作需要管理员权限。'],
    [/^This operation is not permitted$/, '您无权执行此操作。'],
    [/^Account is disabled$/, '账号已停用。'],
    [/^Record is not archived or void$/, '该记录不在归档或作废状态，无需恢复。'],
    [/^Permanent deletion confirmation phrase is invalid$/, '确认文字不正确，未执行删除。'],
    [
      /^(A valid expected record version|If-Match record version) is required$/,
      '缺少记录版本，请刷新页面后重试。',
    ],
    [/^Invalid business data$/, '业务数据未通过服务器校验。'],
    [
      /^Protected order field requires a business action/,
      '正式单据相关字段只能通过对应的单据操作修改。',
    ],
  ];

  const CJK = /[㐀-鿿豈-﫿]/;
  const escapeHtml = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );

  // Splits a UI label into { prefix, zh, en }. Understands "中文 / English", "中文 English",
  // "English / 中文", English-only (via TERMS) and Chinese-only (via ZH_EN) forms.
  function split(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const numbered = raw.match(/^(\d+\.\s*)(.+)$/),
      prefix = numbered ? numbered[1] : '',
      value = numbered ? numbered[2] : raw;
    if (Object.prototype.hasOwnProperty.call(SENTENCES, value))
      return { prefix, zh: SENTENCES[value], en: '', sentence: true };
    if (Object.prototype.hasOwnProperty.call(TERMS, value))
      return { prefix, zh: TERMS[value], en: value };
    if (Object.prototype.hasOwnProperty.call(ZH_EN, value))
      return { prefix, zh: value, en: ZH_EN[value] };
    const special = value.match(/^([A-Za-z][A-Za-z .]*?)\s*[（(]([^）)]*[㐀-鿿][^）)]*)[）)]$/);
    if (special && TERMS[special[1]])
      return { prefix, zh: `${TERMS[special[1]]}（${special[2]}）`, en: special[1] };
    const slash = value.match(/^(.*[㐀-鿿）)][^A-Za-z/]*?)\s*\/\s*([A-Za-z0-9].*)$/);
    if (slash && !CJK.test(slash[2])) return { prefix, zh: slash[1].trim(), en: slash[2].trim() };
    const reverse = value.match(/^([A-Za-z][^㐀-鿿]*?)\s*\/\s*([㐀-鿿].*)$/);
    if (reverse) return { prefix, zh: reverse[2].trim(), en: reverse[1].trim() };
    const spaced = value.match(/^(.*[㐀-鿿）)])\s+([A-Za-z][A-Za-z0-9 &.,()/'-]*)$/);
    if (spaced && !CJK.test(spaced[2]))
      return { prefix, zh: spaced[1].trim(), en: spaced[2].trim() };
    return null;
  }

  function bilingualHtml(zh, en) {
    return en
      ? `<span class="i18n-zh">${escapeHtml(zh)}</span><span class="i18n-en">${escapeHtml(en)}</span>`
      : escapeHtml(zh);
  }
  // HTML for a label or heading; unknown text is returned escaped and unchanged.
  function label(text) {
    const parts = split(text);
    if (!parts) return escapeHtml(text);
    return escapeHtml(parts.prefix) + bilingualHtml(parts.zh, parts.en);
  }
  function status(value) {
    return STATUSES[value] || String(value ?? '');
  }
  function auditAction(code) {
    return AUDIT_ACTIONS[code] || String(code ?? '');
  }
  function entityType(code) {
    return ENTITY_TYPES[code] || String(code ?? '');
  }
  function serverError(message) {
    const text = String(message || '');
    for (const [pattern, translated] of SERVER_ERRORS) if (pattern.test(text)) return translated;
    return text;
  }

  // Never translated: document previews, stored data, and form controls.
  const SKIP =
    '.paper,[data-no-i18n],.record-title,.record-sub,.badge,script,style,textarea,input,select,.i18n-zh,.i18n-en';
  const CHINESE_ONLY_PARENTS = /^(BUTTON|A|OPTION)$/;

  function localizeText(node) {
    const parent = node.parentElement;
    // Text directly inside a table cell is data, never UI vocabulary.
    if (!parent || parent.tagName === 'TD' || parent.closest(SKIP)) return;
    const text = node.nodeValue,
      parts = split(text);
    if (!parts) return;
    const doc = node.ownerDocument;
    const chineseOnly =
      parts.sentence ||
      !parts.en ||
      CHINESE_ONLY_PARENTS.test(parent.tagName) ||
      /kicker/.test(parent.getAttribute('class') || '');
    if (chineseOnly) {
      const next = text.replace(text.trim(), parts.prefix + parts.zh);
      // Assigning an unchanged value would still queue a mutation and loop the observer.
      if (next !== text) node.nodeValue = next;
      return;
    }
    const fragment = doc.createDocumentFragment();
    if (parts.prefix) fragment.append(doc.createTextNode(parts.prefix));
    const zh = doc.createElement('span'),
      en = doc.createElement('span');
    zh.className = 'i18n-zh';
    zh.textContent = parts.zh;
    en.className = 'i18n-en';
    en.textContent = parts.en;
    fragment.append(zh, en);
    parent.replaceChild(fragment, node);
  }
  function localizeOptions(root) {
    const list = root.tagName === 'OPTION' ? [root] : root.querySelectorAll?.('option') || [];
    for (const option of list) {
      if (option.closest('[data-no-i18n],.paper')) continue;
      const text = option.textContent.trim(),
        next = Object.prototype.hasOwnProperty.call(OPTIONS, text) ? OPTIONS[text] : STATUSES[text];
      if (next && next !== text) option.textContent = next;
    }
  }
  // Translates UI chrome inside root in place. Safe to call repeatedly.
  function localize(root) {
    if (!root) return;
    if (root.nodeType === 3) return localizeText(root);
    if (root.nodeType !== 1) return;
    if (root.tagName === 'OPTION') localizeOptions(root.parentElement || root);
    else localizeOptions(root);
    if (root.closest(SKIP)) return;
    const walker = root.ownerDocument.createTreeWalker(root, 5, {
      // 1 = accept, 2 = reject the whole subtree, 3 = skip only this element.
      acceptNode: (node) => (node.nodeType === 3 ? 1 : node.matches(SKIP) ? 2 : 3),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(localizeText);
  }
  // Keeps dynamically inserted UI translated as well.
  function observe(...roots) {
    if (typeof MutationObserver !== 'function') return null;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') localize(record.target);
        else for (const node of record.addedNodes) localize(node);
      }
    });
    for (const target of roots.filter(Boolean)) {
      localize(target);
      observer.observe(target, { childList: true, subtree: true, characterData: true });
    }
    return observer;
  }

  return {
    TERMS,
    SENTENCES,
    ZH_EN,
    OPTIONS,
    STATUSES,
    split,
    label,
    bilingualHtml,
    status,
    auditAction,
    entityType,
    serverError,
    localize,
    observe,
    escapeHtml,
  };
});
