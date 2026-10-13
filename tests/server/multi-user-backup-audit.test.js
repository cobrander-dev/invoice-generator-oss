'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {fixture}=require('./helpers');

async function json(response){let value={};try{value=await response.json();}catch{}return value;}
async function api(f,c,method,route,data,headers={}){let token='';if(!['GET','HEAD'].includes(method))token=(await json(await c.request('/api/auth/csrf'))).csrfToken;return c.request(route,{method,headers:{...(!['GET','HEAD'].includes(method)?{Origin:f.config.origin,'X-CSRF-Token':token}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});}

test('business Backup v2 preserves optional ownership/lifecycle without authentication data',async()=>{
  const f=await fixture();try{
    const employee=await f.userService.createEmployee({username:'backup-employee',email:'backup-employee@example.invalid',displayName:'Backup Employee',temporaryPassword:'TEST-backup-employee-0001'});
    f.repositories.customers.put({id:'c1',buyerName:'TEST Backup Customer'},0);f.repositories.customers.setMetadata('c1',{owner_user_id:employee.id,lifecycle_state:'ARCHIVED'});
    f.repositories.orders.put({id:'o1',customerId:'c1',paymentRecords:[{id:'p1',amount:1,status:'Confirmed'}]},0);f.repositories.orders.setMetadata('o1',{owner_user_id:employee.id,customer_id:'c1',lifecycle_state:'VOID'});
    const backup=f.businessBackupService.exportAllBusinessData(),text=JSON.stringify(backup);
    assert.equal(backup.version,2);assert.deepEqual(backup.customers[0]._server,{ownerUserId:employee.id,ownerUsernameSnapshot:'backup-employee',lifecycleState:'ARCHIVED'});
    assert.equal(backup.orders[0]._server.lifecycleState,'VOID');assert.equal('_server' in backup.products,false);
    for(const forbidden of ['users','sessions','password_hash','passwordHash','SESSION_SECRET','csrf','auth_version','restore_points','schema_migrations','row_version'])assert.equal(text.includes(forbidden),false,forbidden);
    f.businessBackupService.replaceAllBusinessData(backup,true,f.user.id);
    assert.equal(f.repositories.customers.get('c1').owner_user_id,employee.id);assert.equal(f.repositories.customers.get('c1').lifecycle_state,'ARCHIVED');assert.equal(f.repositories.orders.get('o1').lifecycle_state,'VOID');
  }finally{await f.cleanup();}
});

test('legacy Backup without owner metadata imports under the current sole ADMIN and never overwrites users',async()=>{
  const f=await fixture();try{
    const before=f.db.prepare('SELECT id,username,password_hash,role FROM users ORDER BY id').all();
    const legacy={version:1,createdAt:'TEST',exportedAt:'TEST',company:[],customers:[{id:'legacy-c',buyerName:'Legacy TEST'}],products:[],orders:[{id:'legacy-o',customerId:'legacy-c'}],meta:[]};
    f.businessBackupService.replaceAllBusinessData(legacy,false,f.user.id);
    assert.equal(f.repositories.customers.get('legacy-c').owner_user_id,f.user.id);assert.equal(f.repositories.orders.get('legacy-o').owner_user_id,f.user.id);
    assert.deepEqual(f.db.prepare('SELECT id,username,password_hash,role FROM users ORDER BY id').all(),before);
  }finally{await f.cleanup();}
});

test('legacy restore point without owner metadata restores business under the current sole ADMIN',async()=>{
  const f=await fixture();try{
    const legacy={version:1,createdAt:'2026-09-11T00:00:00.000Z',exportedAt:'2026-09-11T00:00:00.000Z',
      company:[],customers:[{id:'legacy-restore-c',buyerName:'TEST Legacy Restore Customer'}],products:[],
      orders:[{id:'legacy-restore-o',customerId:'legacy-restore-c'}],packingLists:[{id:'legacy-restore-pl',orderId:'legacy-restore-o'}],meta:[]};
    f.repositories.restorePoints.put({id:'latest',createdAt:legacy.createdAt,data:legacy},0);
    const admin=f.client();await admin.login();
    const response=await admin.write('/api/server-backup/restore',{body:{}});assert.equal(response.status,200);
    assert.equal(f.repositories.customers.get('legacy-restore-c').owner_user_id,f.user.id);
    assert.equal(f.repositories.orders.get('legacy-restore-o').owner_user_id,f.user.id);
    assert.equal(f.repositories.packingLists.get('legacy-restore-pl').owner_user_id,f.user.id);
  }finally{await f.cleanup();}
});

test('audit SUCCESS insert and business mutation share one SQLite transaction',async()=>{
  const f=await fixture();try{
    const admin=f.client();await admin.login();
    f.db.exec("CREATE TRIGGER test_reject_audit BEFORE INSERT ON audit_logs WHEN NEW.action='CREATE_PRODUCT' BEGIN SELECT RAISE(ABORT,'TEST audit failure'); END");
    const response=await api(f,admin,'POST','/api/products',{id:'atomic-product',englishName:'TEST Atomic Product'});
    assert.equal(response.status,500);assert.equal(f.repositories.products.get('atomic-product'),null);
    f.db.exec('DROP TRIGGER test_reject_audit');
    assert.equal((await api(f,admin,'POST','/api/products',{id:'atomic-product',englishName:'TEST Atomic Product'})).status,201);
    assert.ok(f.repositories.products.get('atomic-product'));assert.ok(f.db.prepare("SELECT 1 FROM audit_logs WHERE action='CREATE_PRODUCT' AND entity_id='atomic-product' AND result='SUCCESS'").get());
  }finally{await f.cleanup();}
});

test('failed login audit is sanitized and never records submitted password',async()=>{
  const f=await fixture();try{
    const supplied='DO-NOT-STORE-TEST-PASSWORD';assert.equal((await f.client().login('unknown-audit-user',supplied)).status,401);
    const row=f.db.prepare("SELECT * FROM audit_logs WHERE action='LOGIN_FAILED'").get();assert.equal(row.username_snapshot,'unknown-audit-user');assert.equal(row.result,'FAILURE');assert.doesNotMatch(JSON.stringify(row),new RegExp(supplied));assert.equal(row.metadata_json,'{}');
  }finally{await f.cleanup();}
});

test('audit history cannot be updated or deleted at the SQLite layer',async()=>{
  const f=await fixture();try{
    await f.client().login('wrong-audit-user','WRONG-TEST-password');const row=f.db.prepare('SELECT id FROM audit_logs LIMIT 1').get();
    assert.throws(()=>f.db.prepare("UPDATE audit_logs SET action='FORGED' WHERE id=?").run(row.id),/immutable/);
    assert.throws(()=>f.db.prepare('DELETE FROM audit_logs WHERE id=?').run(row.id),/immutable/);
    assert.ok(f.db.prepare('SELECT 1 FROM audit_logs WHERE id=?').get(row.id));
  }finally{await f.cleanup();}
});

test('ownership transfer rejects a mismatched source Employee without changing any row',async()=>{
  const f=await fixture();try{
    const a=await f.userService.createEmployee({username:'source-a',displayName:'Source A',temporaryPassword:'TEST-source-A-0001'}),b=await f.userService.createEmployee({username:'source-b',displayName:'Source B',temporaryPassword:'TEST-source-B-0001'});
    f.repositories.customers.put({id:'owned-c',buyerName:'TEST'},0);f.repositories.customers.setMetadata('owned-c',{owner_user_id:a.id});
    assert.throws(()=>f.ownershipService.transferCustomer('owned-c',b.id,b.id),/not found/i);assert.equal(f.repositories.customers.get('owned-c').owner_user_id,a.id);
  }finally{await f.cleanup();}
});

test('frontend contains role-aware account surfaces without adding an ADMIN creation or IndexedDB fallback',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../../js/app.js'),'utf8'),adapter=fs.readFileSync(path.join(__dirname,'../../js/api-db.js'),'utf8'),html=fs.readFileSync(path.join(__dirname,'../../index.html'),'utf8');
  assert.match(html,/data-page="users" data-admin-only/);assert.match(html,/data-page="audit"/);assert.match(html,/data-page="account"/);
  assert.match(app,/只读公司资料/);assert.match(app,/该客户可能已存在/);assert.match(app,/归档/);assert.match(app,/作废/);
  assert.doesNotMatch(app,/Create Admin|创建ADMIN|role[^\n]{0,30}<option[^\n]*ADMIN/i);assert.doesNotMatch(adapter,/indexedDB|localStorage|js\/db\.js/i);
});

test('ADMIN password reset is CLI-only and no public forgotten-password route exists',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../../server/app.js'),'utf8'),routes=fs.readFileSync(path.join(__dirname,'../../server/routes/auth-routes.js'),'utf8'),pkg=require('../../package.json');
  assert.equal(pkg.scripts['admin:reset-password'],'node --env-file-if-exists=.env server/scripts/reset-admin-password.js');
  assert.doesNotMatch(server+routes,/forgot-password|reset-admin-password/);assert.equal(fs.existsSync(path.join(__dirname,'../../server/scripts/reset-admin-password.js')),true);
});
