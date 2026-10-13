'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { before, after, beforeEach } = test;
const { fixture } = require('./helpers');

let f, sharedClient;
before(async () => { f = await fixture(); sharedClient=f.client(); assert.equal((await sharedClient.login()).status,200); });
after(async () => { await f.cleanup(); });
beforeEach(() => {
  for (const name of ['company','customers','products','orders','packingLists','meta','restorePoints']) f.repositories[name].clear();
});

async function api(c, method, path, body, { csrf = true, origin = f.config.origin, headers = {} } = {}) {
  let token = '';
  if (csrf && !['GET','HEAD'].includes(method)) token = (await (await c.request('/api/auth/csrf')).json()).csrfToken;
  return c.request(path, { method, headers: {
    ...(!['GET','HEAD'].includes(method) && origin !== null ? { Origin: origin } : {}),
    ...(!['GET','HEAD'].includes(method) && csrf ? { 'X-CSRF-Token': token } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function loggedIn() { return sharedClient; }
async function json(response) { return response.json(); }

test('all fixed business collections require authentication', async () => {
  const c=f.client();
  for (const path of ['/api/company/main','/api/customers','/api/products','/api/orders','/api/packing-lists','/api/meta/x']) assert.equal((await c.request(path)).status,401);
});
test('business POST without CSRF is rejected', async () => { const c=await loggedIn(); assert.equal((await api(c,'POST','/api/customers',{id:'c1'},{csrf:false})).status,403); });
test('business PUT with wrong Origin is rejected', async () => { const c=await loggedIn(); assert.equal((await api(c,'PUT','/api/company/main',{id:'main'},{origin:'https://attacker.example.invalid',headers:{'If-Match':'0'}})).status,403); });
test('business DELETE without authentication is rejected', async () => { assert.equal((await api(f.client(),'DELETE','/api/customers/c1',undefined,{csrf:false,origin:null,headers:{'If-Match':'1'}})).status,401); });
test('missing company returns 404 without creating Demo data', async () => { const c=await loggedIn(); assert.equal((await api(c,'GET','/api/company/main')).status,404); assert.equal(f.repositories.company.list().length,0); });
test('company PUT and GET preserve sensitive aliases and server metadata separately', async () => {
  const c=await loggedIn(), company={id:'main',englishName:'Example Server Testing Co., Ltd.',accounts:[{id:'a1',accountNumber:'000000000000'}],signatureImage:'data:image/png;base64,VEVTVA==',companyStampImage:'data:image/png;base64,VEVTVFNUQU1Q'};
  let r=await api(c,'PUT','/api/company/main',company,{headers:{'If-Match':'0'}}); assert.equal(r.status,200); let body=await json(r); assert.deepEqual(body.data,company); assert.equal(body.meta.rowVersion,1); assert.equal('row_version' in body.data,false);
  body=await json(await api(c,'GET','/api/company/main')); assert.deepEqual(body.data,company);
});
test('customer create, list and get use fixed routes', async () => {
  const c=await loggedIn(), customer={id:'customer-test-1',buyerName:'Sample Buyer Testing Ltd.',unknown:{kept:true}};
  let r=await api(c,'POST','/api/customers',customer); assert.equal(r.status,201); assert.equal((await json(r)).meta.rowVersion,1);
  assert.deepEqual((await json(await api(c,'GET','/api/customers'))).data,[customer]); assert.deepEqual((await json(await api(c,'GET','/api/customers/customer-test-1'))).data,customer);
});
test('customer update increments rowVersion', async () => { const c=await loggedIn(); await api(c,'POST','/api/customers',{id:'c1',buyerName:'A'}); const body=await json(await api(c,'PUT','/api/customers/c1',{id:'c1',buyerName:'B'},{headers:{'If-Match':'1'}})); assert.equal(body.meta.rowVersion,2); assert.equal(body.data.buyerName,'B'); });
test('stale customer update returns 409 and preserves newer data', async () => { const c=await loggedIn(); await api(c,'POST','/api/customers',{id:'c1',buyerName:'A'}); await api(c,'PUT','/api/customers/c1',{id:'c1',buyerName:'B'},{headers:{'If-Match':'1'}}); assert.equal((await api(c,'PUT','/api/customers/c1',{id:'c1',buyerName:'STALE'},{headers:{'If-Match':'1'}})).status,409); assert.equal(f.repositories.customers.get('c1').payload.buyerName,'B'); });
test('stale customer delete returns 409', async () => { const c=await loggedIn(); f.repositories.customers.put({id:'c1'},0); f.repositories.customers.put({id:'c1',x:1},1); assert.equal((await api(c,'DELETE','/api/customers/c1',undefined,{headers:{'If-Match':'1'}})).status,409); });
test('current customer DELETE archives without physical deletion', async () => { const c=await loggedIn(); f.repositories.customers.put({id:'c1'},0); const body=await json(await api(c,'DELETE','/api/customers/c1',undefined,{headers:{'If-Match':'1'}})); assert.equal(body.meta.lifecycleState,'ARCHIVED'); assert.ok(f.repositories.customers.get('c1')); assert.equal((await json(await api(c,'GET','/api/customers'))).data.length,0); });
test('product CRUD preserves unknown fields and Base64', async () => { const c=await loggedIn(), p={id:'p1',englishName:'TEST Product',image:'data:image/png;base64,VEVTVA==',unknown:['x']}; await api(c,'POST','/api/products',p); assert.deepEqual((await json(await api(c,'GET','/api/products/p1'))).data,p); });
test('product bulk import commits all records in one transaction', async () => { const c=await loggedIn(); const items=[1,2,3].map(n=>({data:{id:`p${n}`,englishName:`TEST ${n}`},expectedVersion:0})); const r=await api(c,'POST','/api/products/bulk',{items}); assert.equal(r.status,200); assert.equal(f.repositories.products.list().length,3); });
test('product bulk conflict rolls back every item', async () => { const c=await loggedIn(); f.repositories.products.put({id:'p2',name:'newer'},0); const items=[{data:{id:'p1'},expectedVersion:0},{data:{id:'p2',name:'stale'},expectedVersion:0}]; assert.equal((await api(c,'POST','/api/products/bulk',{items})).status,409); assert.equal(f.repositories.products.get('p1'),null); assert.equal(f.repositories.products.get('p2').payload.name,'newer'); });
test('complex order create preserves ordinary fields but strips forged protected state and recalculates', async () => { const c=await loggedIn();await api(c,'POST','/api/customers',{id:'c1',buyerName:'TEST'});const order={id:'o1',customerId:'c1',items:[{id:'l1',quantity:2,unitPrice:3}],charges:[{amount:4}],paymentRecords:[{id:'forged',amount:999,status:'Confirmed'}],piHistory:[{revision:99}],ciDocument:{data:{x:1}},packingListDocument:{id:'pl1'},attachments:[{data:'data:text/plain;base64,VEVTVA=='}],unknown:{nested:true}}; await api(c,'POST','/api/orders',order); const saved=(await json(await api(c,'GET','/api/orders/o1'))).data; assert.equal(saved.total,6); assert.equal(saved.amountPaid,0); assert.deepEqual(saved.piHistory,[]); assert.equal(saved.ciDocument,null); assert.equal(saved.packingListDocument,null); assert.deepEqual(saved.unknown,order.unknown); assert.equal(saved.attachments[0].data,order.attachments[0].data); });
test('order stale update returns 409', async () => { const c=await loggedIn(); f.repositories.orders.put({id:'o1'},0); f.repositories.orders.put({id:'o1',newer:true},1); assert.equal((await api(c,'PUT','/api/orders/o1',{id:'o1',stale:true},{headers:{'If-Match':'1'}})).status,409); });
test('order DELETE voids without physically removing order or Packing Lists', async () => { const c=await loggedIn(); f.repositories.orders.put({id:'o1'},0); f.repositories.packingLists.put({id:'pl1',orderId:'o1'},0); f.repositories.packingLists.put({id:'pl2',orderId:'other'},0); const body=await json(await api(c,'DELETE','/api/orders/o1',undefined,{headers:{'If-Match':'1'}})); assert.equal(body.meta.lifecycleState,'VOID'); assert.ok(f.repositories.orders.get('o1')); assert.ok(f.repositories.packingLists.get('pl1')); assert.ok(f.repositories.packingLists.get('pl2')); });
test('legacy arbitrary Packing List dual-write endpoint is unavailable', async () => { const c=await loggedIn(); f.repositories.orders.put({id:'o1',packingListDocument:null},0); const input={order:{id:'o1',packingListDocument:{id:'pl1'}},packingList:{id:'pl1',orderId:'o1',cartons:2},expectedOrderVersion:1,expectedPackingListVersion:0}; assert.equal((await api(c,'PUT','/api/orders/o1/packing-list',input)).status,404); assert.equal(f.repositories.orders.get('o1').payload.packingListDocument,null); assert.equal(f.repositories.packingLists.get('pl1'),null); });
test('legacy dual-write endpoint cannot bypass a newer Packing List version', async () => { const c=await loggedIn(); f.repositories.orders.put({id:'o1',value:'before'},0); f.repositories.packingLists.put({id:'pl1',orderId:'o1',value:'newer'},0); const input={order:{id:'o1',value:'after'},packingList:{id:'pl1',orderId:'o1',value:'stale'},expectedOrderVersion:1,expectedPackingListVersion:0}; assert.equal((await api(c,'PUT','/api/orders/o1/packing-list',input)).status,404); assert.equal(f.repositories.orders.get('o1').payload.value,'before'); assert.equal(f.repositories.packingLists.get('pl1').payload.value,'newer'); });
test('meta GET and PUT expose only requested key', async () => { const c=await loggedIn(); const meta={id:'last-full-backup',value:'TEST-TIME'}; await api(c,'PUT','/api/meta/last-full-backup',meta,{headers:{'If-Match':'0'}}); assert.deepEqual((await json(await api(c,'GET','/api/meta/last-full-backup'))).data,meta); });
test('server export reflects CRUD data and remains backup-compatible', async () => { const c=await loggedIn(); f.repositories.customers.put({id:'c1',buyerName:'TEST'},0); const body=await json(await api(c,'GET','/api/server-backup/export')); assert.equal(body.version,2); assert.equal(body.customers.length,1); assert.equal('users' in body,false); });
test('server inspect validates actual backup instead of trusting preview counts', async () => { const c=await loggedIn(); const backup={version:2,createdAt:'TEST',exportedAt:'TEST',company:[],customers:[{id:'c1'}],products:[],orders:[],packingLists:[],meta:[]}; const body=await json(await api(c,'POST','/api/server-backup/inspect',backup)); assert.equal(body.customers,1); });
test('server import and restore preserve pre-import data', async () => { const c=await loggedIn(); const make=name=>({version:2,createdAt:'TEST',exportedAt:'TEST',company:[{id:'main',englishName:name}],customers:[],products:[],orders:[],packingLists:[],meta:[]}); await api(c,'POST','/api/server-backup/import',make('A')); await api(c,'POST','/api/server-backup/import',make('B')); await api(c,'POST','/api/server-backup/restore',{}); assert.equal(f.repositories.company.get('main').payload.englishName,'A'); });
test('server clear rejects wrong confirmation and changes nothing', async () => { const c=await loggedIn(); f.repositories.customers.put({id:'c1'},0); assert.equal((await api(c,'POST','/api/server-backup/clear',{confirmation:'wrong'})).status,400); assert.ok(f.repositories.customers.get('c1')); });
test('server clear with exact phrase creates restore point and preserves users', async () => { const c=await loggedIn(), users=f.db.prepare('SELECT COUNT(*) n FROM users').get().n; f.repositories.customers.put({id:'c1'},0); assert.equal((await api(c,'POST','/api/server-backup/clear',{confirmation:'清空数据'})).status,200); assert.equal(f.repositories.customers.get('c1'),null); assert.equal(f.repositories.restorePoints.get('latest').payload.data.customers.length,1); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM users').get().n,users); });
test('API validation errors never expose SQLite paths or SQL details', async () => { const c=await loggedIn(); const r=await api(c,'PUT','/api/customers/c1',{id:'different'},{headers:{'If-Match':'1'}}); assert.equal(r.status,400); const text=JSON.stringify(await json(r)); assert.doesNotMatch(text,/sqlite|select|insert|\/tmp\//i); });
