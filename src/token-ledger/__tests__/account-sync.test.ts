import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {configSchema} from '../../config/schema.js'
import {TokenLedgerService} from '../service.js'
import {AccountLedgerCredentials,type AccountLedgerCredential} from '../account-credentials.js'
import type {TokenData} from '../../auth/token-store.js'
import {readTokenLedgerSettings,updateTokenLedgerSettings} from '../settings.js'

test('client credential renewal keeps confirmed sync receipts and cannot send identity tokens to a custom endpoint',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'ledger-account-sync-'))
  let now=Date.now(),issued=0,uploads=0
  const userId='11111111-1111-4111-8111-111111111111'
  const accessToken='fixture.'+Buffer.from(JSON.stringify({sub:userId,type:'access',session_id:'session'})).toString('base64url')+'.signature'
  let saved:TokenData&{ledgerCredential?:AccountLedgerCredential}={accessToken,expiresAt:now+86_400_000}
  const credentials=new AccountLedgerCredentials({load:()=>saved,save:value=>{saved=value}},async(input,init)=>{
    assert.equal(String(input),'https://tianshuharness.com/token/v1/client/credentials')
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+accessToken)
    issued++
    return Response.json({key:'tsu_'+String(issued).repeat(32),userId,deviceId:JSON.parse(init?.body as string).deviceId,scope:'usage:write',expiresAt:now+3_600_000})
  },()=>now)
  const sessions=join(directory,'sessions')
  mkdirSync(join(sessions,'project','session'),{recursive:true})
  writeFileSync(join(sessions,'project','session','cache-log.jsonl'),JSON.stringify({t:now,turn:1,model:'fixture',input:10,output:1,cacheRead:0,cacheCreate:0})+'\n')
  const config=configSchema.parse({provider:{default:'fixture',providers:{}},tokenLedger:{forum:{autoSync:false}}})
  const service=new TokenLedgerService(config,{accountCredentials:credentials,statePath:join(directory,'ledger.json'),sessionsRoot:sessions,now:()=>now,fetchImpl:async(input,init)=>{
    assert.equal(input,'https://tianshuharness.com/token/v1/token-usage')
    assert.match(init?.headers?.Authorization??'',/^Bearer tsu_/)
    assert.ok(!JSON.stringify(init).includes(accessToken))
    uploads++;return {status:200,text:async()=>' {"ok":true,"stale":false}'}
  }})
  try{
    assert.equal(service.startAutoSync(),false,'login must not silently opt the user into uploads')
    assert.equal((await service.syncNow()).ok,true)
    const confirmed=uploads
    now+=3_550_000
    assert.equal((await service.syncNow()).skipped,'unchanged')
    assert.equal(issued,2);assert.equal(uploads,confirmed,'renewing credentials must not replay the whole history')
    const settings=readTokenLedgerSettings(config,service.accountConnection().available)
    assert.equal(settings.forum.apiKeySource,'account')
    assert.ok(!JSON.stringify(settings).includes(saved.ledgerCredential!.key))
    assert.equal(updateTokenLedgerSettings({forum:{autoSync:true}},{load:()=>structuredClone(config),save:()=>{},accountAvailable:true}).tokenLedger.forum?.autoSync,true)
    service.reconfigure({...config,tokenLedger:{...config.tokenLedger,forum:{endpoint:'https://custom.example.test/usage'}}})
    assert.equal(service.accountConnection().available,false)
    assert.equal((await service.syncNow()).skipped,'no_key')
    assert.equal(uploads,confirmed);assert.equal(issued,2)
  }finally{service.stopAutoSync();rmSync(directory,{recursive:true,force:true})}
})
