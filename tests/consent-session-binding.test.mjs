import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublisherServer} from '../dist/server.js';
const options={clientId:'wbproj_synthetic',secretKey:'sk_test_synthetic',preferenceSecret:'synthetic-preference-secret-32-bytes',
 authorize:r=>r.headers.get('authorization')==='Session synthetic',publicOrigins:['https://publisher.example'],surfaceId:'chat_assistant',placementKey:'default',
 jobType:'chat',locale:'en-US',timing:'after',consentMode:'wavebird_consent',allowedFormats:['banner'],positionHint:'below',allowedSizes:[{width:300,height:250}],
 publisher:{app_name:'Synthetic',app_domain:'publisher.example',categories:[]},sessionIdForRequest:()=> 'current_trusted_session',
 turnJournal:Object.fromEntries(['claimPlacement','releaseRejectedPlacement','bind','claimGeneration','phase'].map(k=>[k,async()=>true]))};
const request=(session,state='granted',headers={})=>new Request('https://publisher.example/api/consent',{method:'POST',headers:{host:'publisher.example',origin:'https://publisher.example',authorization:'Session synthetic','content-type':'application/json',...headers},
 body:JSON.stringify({session_id:session,lifecycle_state:state,revision:1,remember_for_30_days:true})});
async function upstream(run){
 const original=globalThis.fetch;const writes=[];
 globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);writes.push(body);return Response.json({authoritative_consent:{lifecycle_state:body.lifecycle_state,revision:body.revision}});};
 try{await run(writes);}finally{globalThis.fetch=original;}
}
test('trusted consent rejects another or stale body session without a write or cookie change',async()=>{
 await upstream(async writes=>{
  for(const state of ['granted','denied','withdrawn','cmp_error']){
   const result=await createPublisherServer(options).consentPOST(request('stale_browser_session',state));
   assert.equal(result.status,401);assert.deepEqual(await result.json(),{error:'publisher_session_mismatch'});
   assert.equal(result.headers.get('set-cookie'),null);
  }
  assert.equal(writes.length,0);
 });
});
test('matching trusted session still synchronizes each explicit choice and remembered preference',async()=>{
 await upstream(async writes=>{
  for(const state of ['granted','denied','withdrawn']){
   const result=await createPublisherServer(options).consentPOST(request(' current_trusted_session ',state));
   assert.equal(result.status,200);assert.ok(result.headers.get('set-cookie'));
   assert.equal(writes.at(-1).session_id,'current_trusted_session');assert.equal(writes.at(-1).lifecycle_state,state);
  }
  assert.equal(writes.length,3);
 });
});
test('unavailable and malformed trusted sessions fail closed without cookie or upstream changes',async()=>{
 await upstream(async writes=>{
  for(const [sessionIdForRequest,status] of [[()=>null,401],[()=>'',401],[()=> 'invalid session',401],[()=>Promise.reject(Error('offline')),503]]){
   const result=await createPublisherServer({...options,sessionIdForRequest}).consentPOST(request('current_trusted_session'));
   assert.equal(result.status,status);assert.equal(result.headers.get('set-cookie'),null);
  }
  assert.equal(writes.length,0);
 });
});
test('session resolver is current per request and does not use a cached identity',async()=>{
 await upstream(async writes=>{
  let current='current_trusted_session';const server=createPublisherServer({...options,sessionIdForRequest:()=>current});
  assert.equal((await server.consentPOST(request(current))).status,200);
  current='renewed_trusted_session';assert.equal((await server.consentPOST(request('current_trusted_session'))).status,401);
  assert.equal((await server.consentPOST(request(current))).status,200);assert.equal(writes.length,2);
 });
});
test('legacy applications without the trusted-session callback retain their explicit session contract',async()=>{
 await upstream(async writes=>{
  const {sessionIdForRequest,turnJournal,...legacy}=options;
  assert.equal((await createPublisherServer(legacy).consentPOST(request('legacy_session'))).status,200);
  assert.equal(writes.length,1);assert.equal(writes[0].session_id,'legacy_session');
 });
});
test('authentication, origin and GPC denial remain before trusted-session resolution',async()=>{
 await upstream(async writes=>{
  let resolutions=0;const server=createPublisherServer({...options,sessionIdForRequest:()=>{resolutions++;return 'current_trusted_session';}});
  for(const [headers,status] of [[{authorization:''},401],[{origin:'https://other.example'},403],[{'sec-gpc':'1'},403]])
   assert.equal((await server.consentPOST(request('current_trusted_session','granted',headers))).status,status);
  assert.equal(resolutions,0);assert.equal(writes.length,0);
 });
});
