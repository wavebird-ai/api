import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublisherServer } from '../dist/server.js';

const options = {
  clientId:'wbproj_synthetic', secretKey:'sk_test_synthetic',
  preferenceSecret:'synthetic-preference-secret-32-bytes',
  authorize:r=>r.headers.get('authorization')==='Session synthetic',
  publicOrigins:['https://publisher.example'], surfaceId:'chat_assistant',
  placementKey:'default', jobType:'chat', locale:'en-US', timing:'after',
  consentMode:'wavebird_consent', allowedFormats:['banner'], positionHint:'below',
  allowedSizes:[{width:300,height:250}], publisher:{app_name:'Synthetic',app_domain:'publisher.example',categories:[]},
  sessionIdForRequest:()=> 'trusted_session',
  turnJournal:Object.fromEntries(['claimPlacement','releaseRejectedPlacement','bind','claimGeneration','phase'].map(k=>[k,async()=>true]))
};
const request=(body,headers={})=>new Request('https://publisher.example/api/consent?session_id=attacker',{
  method:body?'POST':'GET',headers:{host:'publisher.example',origin:'https://publisher.example',authorization:'Session synthetic','content-type':'application/json',...headers},
  ...(body?{body:JSON.stringify(body)}:{})
});
async function mocked(fetcher, run) {const original=globalThis.fetch;globalThis.fetch=fetcher;try{await run();}finally{globalThis.fetch=original;}}

test('reload reads authoritative revision for trusted session, preserving signed choice', async()=>{
  let revision=0; const methods=[];
  await mocked(async(url,init)=>{
    methods.push(init.method);
    assert.equal(init.headers.Authorization,'Bearer sk_test_synthetic');
    if(init.method==='GET'){
      const u=new URL(url);assert.equal(u.pathname,'/v1/consent');
      assert.equal(u.searchParams.get('session_id'),'trusted_session');
      assert.equal(u.searchParams.get('client_id'),options.clientId);
      return Response.json({current_revision:revision});
    }
    const b=JSON.parse(init.body);
    if(b.revision<=revision)return Response.json({error:'consent_state_conflict'},{status:409});
    revision=b.revision;
    return Response.json({authoritative_consent:{lifecycle_state:b.lifecycle_state,revision}});
  },async()=>{
    const first=createPublisherServer(options);
    const grant=await first.consentPOST(request({session_id:'trusted_session',lifecycle_state:'granted',revision:7,remember_for_30_days:true}));
    const cookie=grant.headers.get('set-cookie').split(';')[0];
    const reloaded=createPublisherServer(options);
    const restored=await reloaded.consentGET(request(null,{cookie}));
    const state=await restored.json();assert.equal(state.current_revision,7);assert.equal(state.preference.state,'granted');
    const sync=await reloaded.consentPOST(request({session_id:'trusted_session',lifecycle_state:state.preference.state,revision:state.current_revision+1,remember_for_30_days:false}));
    assert.equal(sync.status,200);assert.equal(revision,8);
    assert.deepEqual(methods,['POST','GET','POST']);
  });
});

test('missing or tampered preference returns revision without creating consent',async()=>{
  await mocked(async()=>Response.json({current_revision:12}),async()=>{
    const server=createPublisherServer(options);
    for(const cookie of ['', '__Host-wavebird-preference-wbproj_synthetic-chat_assistant=tampered.signature']){
      assert.deepEqual(await (await server.consentGET(request(null,{cookie}))).json(),{preference:null,current_revision:12});
    }
  });
});

test('authentication, origin, GPC and invalid session stop revision lookup',async()=>{
  await mocked(async()=>{assert.fail('must not contact upstream');},async()=>{
    const server=createPublisherServer(options);
    for(const [headers,status] of [[{authorization:''},401],[{origin:'https://foreign.example'},403]])
      assert.equal((await server.consentGET(request(null,headers))).status,status);
    assert.deepEqual(await (await server.consentGET(request(null,{'sec-gpc':'1'}))).json(),{preference:null});
    assert.equal((await createPublisherServer({...options,sessionIdForRequest:()=>null}).consentGET(request())).status,401);
    assert.equal((await createPublisherServer({...options,sessionIdForRequest:()=>{throw Error('unavailable');}}).consentGET(request())).status,503);
  });
});

test('failed, malformed and exhausted revision reads never invent revision zero or grant',async()=>{
  for(const fetcher of [async()=>{throw Error('offline');},async()=>Response.json({current_revision:4},{status:403}),
    ...[undefined,-1,1.5,'2',Number.MAX_SAFE_INTEGER].map(current_revision=>async()=>Response.json({current_revision})),
    async()=>new Response('invalid')]) {
    await mocked(fetcher,async()=>{
      const result=await createPublisherServer(options).consentGET(request());
      assert.equal(result.status,503);assert.deepEqual(await result.json(),{error:'consent_revision_unavailable'});
      assert.equal(result.headers.get('cache-control'),'no-store');
    });
  }
});
