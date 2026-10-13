(function(root,factory){
  const api=factory(root.fetch?root.fetch.bind(root):null);
  if(typeof module==='object'&&module.exports)module.exports={createApiDB:fetchImpl=>factory(fetchImpl,api.errors),...api.errors};
  else root.FTDB=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(fetchImpl,sharedErrors){
  'use strict';
  const ApiError=sharedErrors?.ApiError||class ApiError extends Error{constructor(message,status=0){super(message);this.name='ApiError';this.status=status;}};
  const ConflictError=sharedErrors?.ConflictError||class ConflictError extends ApiError{constructor(message='该记录已在其他会话中更新。当前修改尚未保存，请重新加载最新数据后再处理。'){super(message,409);this.name='ConflictError';}};
  const AuthExpiredError=sharedErrors?.AuthExpiredError||class AuthExpiredError extends ApiError{constructor(message='登录已过期，本次修改未保存。'){super(message,401);this.name='AuthExpiredError';}};
  const ServerError=sharedErrors?.ServerError||class ServerError extends ApiError{constructor(message='服务器暂时无法访问，本次修改未保存。',status=500){super(message,status);this.name='ServerError';}};
  const NetworkError=sharedErrors?.NetworkError||class NetworkError extends ApiError{constructor(message='服务器暂时无法访问，本次修改未保存。'){super(message,0);this.name='NetworkError';}};

  const paths=Object.freeze({
    company:'/api/company',customers:'/api/customers',products:'/api/products',orders:'/api/orders',
    packingLists:'/api/packing-lists',meta:'/api/meta',restorePoints:'/api/server-backup/restore-point'
  });
  const versions=new Map();
  const metadata=new Map();
  let csrfToken='';
  let currentUser=null;
  const key=(store,id)=>`${store}\u0000${id}`;
  const encode=id=>encodeURIComponent(String(id));
  function reportConnection(available){
    if(typeof globalThis.dispatchEvent==='function'&&typeof globalThis.CustomEvent==='function')globalThis.dispatchEvent(new globalThis.CustomEvent('ft-server-status',{detail:{available}}));
  }

  async function request(path,{method='GET',body,headers={}}={}){
    if(!fetchImpl){reportConnection(false);throw new NetworkError();}
    const write=!['GET','HEAD','OPTIONS'].includes(method);
    if(write&&!csrfToken){
      let tokenResponse;
      try{tokenResponse=await fetchImpl('/api/auth/csrf',{credentials:'same-origin',cache:'no-store'});}catch{reportConnection(false);throw new NetworkError();}
      reportConnection(tokenResponse.ok||tokenResponse.status===401);
      if(tokenResponse.status===401)throw new AuthExpiredError();
      if(!tokenResponse.ok){reportConnection(false);throw new ServerError('无法取得安全令牌，本次修改未保存。',tokenResponse.status);}
      csrfToken=(await tokenResponse.json()).csrfToken;
    }
    let response;
    try{response=await fetchImpl(path,{method,credentials:'same-origin',cache:'no-store',headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(write?{'X-CSRF-Token':csrfToken}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
    catch{reportConnection(false);throw new NetworkError();}
    reportConnection(response.status<500);
    let payload={};
    try{payload=await response.json();}catch{}
    if(response.status===401)throw new AuthExpiredError();
    if(response.status===409)throw new ConflictError(payload.error);
    if([400,403,404,422].includes(response.status))throw new ApiError(payload.error||'业务数据未通过服务器校验。',response.status);
    if(!response.ok){reportConnection(false);throw new ServerError(payload.error||'服务器请求失败，本次修改未保存。',response.status);}
    return payload;
  }

  function remember(store,data,meta={}){
    if(data&&meta.rowVersion!==undefined){versions.set(key(store,data.id),meta.rowVersion);metadata.set(key(store,data.id),{ownerUserId:meta.ownerUserId,lifecycleState:meta.lifecycleState});}
    if(Array.isArray(data)&&meta.rowVersions)for(const item of data){versions.set(key(store,item.id),meta.rowVersions[item.id]);metadata.set(key(store,item.id),{ownerUserId:meta.owners?.[item.id],lifecycleState:meta.lifecycle?.[item.id]});}
    if(meta.possibleDuplicate&&typeof globalThis.dispatchEvent==='function'&&typeof globalThis.CustomEvent==='function')globalThis.dispatchEvent(new globalThis.CustomEvent('ft-customer-duplicate-warning'));
    return data;
  }
  function recordPath(store,id){
    if(store==='company')return '/api/company/main';
    if(store==='restorePoints')return '/api/server-backup/restore-point';
    return `${paths[store]}/${encode(id)}`;
  }
  function ensureStore(store){if(!paths[store])throw new ApiError(`Unsupported server store: ${store}`,400);}
  async function orderAction(id,action,body={}){
    const version=versions.get(key('orders',id));
    if(version===undefined)throw new ConflictError('缺少服务器订单版本，请重新加载后再执行。');
    const response=await request(`/api/orders/${encode(id)}/${action}`,{method:'POST',body,headers:{'If-Match':String(version)}});
    return remember('orders',response.data,response.meta);
  }
  async function packingAction(id,action,packingList=null,extra={}){
    const orderVersion=versions.get(key('orders',id));
    if(orderVersion===undefined)throw new ConflictError('缺少服务器订单版本，请重新加载后再执行。');
    const packingId=packingList?.id;
    const response=await request(`/api/orders/${encode(id)}/${action}`,{method:'POST',headers:{'If-Match':String(orderVersion)},body:{...extra,...(packingList?{packingList}:{}),expectedPackingListVersion:packingId?(versions.get(key('packingLists',packingId))??0):0}});
    versions.set(key('orders',id),response.meta.orderRowVersion);
    versions.set(key('packingLists',response.data.packingList.id),response.meta.packingListRowVersion);
    return response.data;
  }

  const api={
    errors:{ApiError,ConflictError,AuthExpiredError,ServerError,NetworkError},
    async open(){currentUser=await request('/api/auth/me');return currentUser;},
    async get(store,id){ensureStore(store);try{const response=await request(recordPath(store,id));return remember(store,response.data,response.meta);}catch(err){if(err.status===404)return undefined;throw err;}},
    async getAll(store){ensureStore(store);if(['company','meta','restorePoints'].includes(store))throw new ApiError(`getAll is not available for ${store}`,400);const response=await request(paths[store]);return remember(store,response.data,response.meta);},
    async put(store,data,options={}){
      ensureStore(store);if(store==='packingLists'||store==='restorePoints')throw new ApiError(`${store} must use its protected server workflow`,400);
      const version=versions.get(key(store,data.id));
      const singleton=store==='company'||store==='meta';
      const requestHeaders=singleton||version!==undefined?{'If-Match':String(version??0)}:{};
      if(store==='customers'&&version===undefined&&options.ownerUserId)requestHeaders['X-Owner-User-Id']=String(options.ownerUserId);
      const response=await request(singleton?recordPath(store,data.id):(version===undefined?paths[store]:recordPath(store,data.id)),{
        method:singleton||version!==undefined?'PUT':'POST',body:data,headers:requestHeaders
      });
      return remember(store,response.data,response.meta);
    },
    async remove(store,id){
      ensureStore(store);const version=versions.get(key(store,id));
      if(version===undefined)throw new ConflictError('缺少服务器记录版本，未执行删除。请重新加载最新数据后再处理。');
      const response=await request(recordPath(store,id),{method:'DELETE',headers:{'If-Match':String(version)}});
      return remember(store,response.data,response.meta);
    },
    async putMany(store,items){
      if(store!=='products')throw new ApiError('Only product bulk import is supported',400);
      const response=await request('/api/products/bulk',{method:'POST',body:{items:items.map(data=>({data,expectedVersion:versions.get(key(store,data.id))??0}))}});
      remember(store,response.data,response.meta);return response.data;
    },
    finalizePI(id,options){return orderAction(id,'finalize-pi',options);},
    revisePI(id,options){return orderAction(id,'revise-pi',options);},
    generateCI(id){return orderAction(id,'generate-ci');},
    confirmCIDifferences(id){return orderAction(id,'confirm-ci-differences');},
    finalizeCI(id,options){return orderAction(id,'finalize-ci',options);},
    savePaymentTracking(id,paymentRecords,currentPaymentStage,extra={}){return orderAction(id,'payment-tracking',{paymentRecords,currentPaymentStage,...extra});},
    generatePackingList(id){return packingAction(id,'generate-packing-list');},
    savePackingList(id,packingList){return packingAction(id,'save-packing-list',packingList);},
    finalizePackingList(id,packingList,options){return packingAction(id,'finalize-packing-list',packingList,options);},
    async exportAll(){return request('/api/server-backup/export');},
    async inspectBackup(data){return request('/api/server-backup/inspect',{method:'POST',body:data});},
    async replaceAll(data){const result=await request('/api/server-backup/import',{method:'POST',body:data});versions.clear();metadata.clear();return result;},
    async restoreLatest(){const result=await request('/api/server-backup/restore',{method:'POST',body:{}});versions.clear();metadata.clear();return result;},
    async clearAll(confirmation){const result=await request('/api/server-backup/clear',{method:'POST',body:{confirmation}});versions.clear();metadata.clear();return result;},
    async listUsers(){return (await request('/api/users')).data;},
    async createEmployee(data){return (await request('/api/users',{method:'POST',body:data})).data;},
    async updateEmployee(id,data){return (await request(`/api/users/${encode(id)}`,{method:'PUT',body:data})).data;},
    async setEmployeeStatus(id,status){return (await request(`/api/users/${encode(id)}/${status==='ACTIVE'?'enable':'disable'}`,{method:'POST',body:{}})).data;},
    async resetEmployeePassword(id,temporaryPassword){return (await request(`/api/users/${encode(id)}/reset-password`,{method:'POST',body:{temporaryPassword}})).data;},
    async transferCustomer(sourceEmployeeId,customerId,targetOwnerUserId){return (await request(`/api/users/${encode(sourceEmployeeId)}/transfer-customer/${encode(customerId)}`,{method:'POST',body:{ownerUserId:targetOwnerUserId}})).data;},
    async listAuditLogs(){return (await request('/api/audit-logs')).data;},
    async changePassword(data){const result=await request('/api/auth/change-password',{method:'POST',body:data});currentUser=result.user;return result;},
    getCurrentUser(){return currentUser;},
    getMetadata(store,id){return metadata.get(key(store,id))||{};},
    _testing:{versions,metadata,request,reset(){versions.clear();metadata.clear();csrfToken='';currentUser=null;}}
  };
  return api;
});
