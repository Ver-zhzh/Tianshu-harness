import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccountLedgerCredentials, type AccountLedgerCredential } from '../account-credentials.js'
import type { TokenData } from '../../auth/token-store.js'

const userId = '11111111-1111-4111-8111-111111111111'
const deviceId = '33333333-3333-4333-8333-333333333333'
const accountToken = (session = 'session-one') => 'fixture.'+Buffer.from(JSON.stringify({sub:userId,type:'access',session_id:session})).toString('base64url')+'.signature'
function fixture() {
  let now = Date.now()
  let saved: (TokenData & {ledgerCredential?: AccountLedgerCredential}) | null = {accessToken:accountToken(),expiresAt:now+86_400_000}
  const calls: string[] = []
  let respond = async () => Response.json({key:'tsu_'+'a'.repeat(32),userId,deviceId,scope:'usage:write',expiresAt:now+3_600_000})
  const provider = new AccountLedgerCredentials({load:()=>saved,save:value=>{saved=value}},async (input,init)=>{
    const url=String(input);calls.push(url)
    assert.equal(init?.redirect,'error')
    assert.ok(url.startsWith('https://tianshuharness.com/token/v1/client/'))
    if(url.endsWith('/revoke'))return Response.json({ok:true})
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer '+saved?.accessToken)
    assert.deepEqual(JSON.parse(init?.body as string),{deviceId})
    return respond()
  },()=>now)
  return {provider,calls,get saved(){return saved},set saved(value){saved=value},set respond(value:typeof respond){respond=value},advance(milliseconds:number){now+=milliseconds}}
}

test('client credential acquisition is single-flight, cached, renewed and never a manual config secret',async()=>{
  const context=fixture()
  const values=await Promise.all([context.provider.resolve(deviceId),context.provider.resolve(deviceId)])
  assert.ok(values[0]);assert.deepEqual(values[0],values[1]);assert.equal(context.calls.length,1)
  assert.equal(context.saved?.ledgerCredential?.scope,'usage:write')
  assert.equal(context.saved?.ledgerCredential?.sessionId,'session-one')
  assert.deepEqual(await context.provider.resolve(deviceId),values[0]);assert.equal(context.calls.length,1)
  context.advance(3_550_000)
  assert.ok(await context.provider.resolve(deviceId));assert.equal(context.calls.length,2)
  context.saved=null;context.provider.changed();await Promise.resolve()
  assert.ok(context.calls.at(-1)?.endsWith('/revoke'))
  assert.equal(await context.provider.resolve(deviceId),undefined)
})

test('logout or a new login cannot adopt a late credential, including the same user',async()=>{
  for(const next of [null,{accessToken:accountToken('new-session'),expiresAt:Date.now()+86_400_000}]) {
    const context=fixture()
    let release!:()=>void
    const gate=new Promise<void>(resolve=>{release=resolve})
    context.respond=async()=>{await gate;return Response.json({key:'tsu_'+'a'.repeat(32),userId,deviceId,scope:'usage:write',expiresAt:Date.now()+3_500_000})}
    const pending=context.provider.resolve(deviceId)
    context.saved=next;context.provider.changed();release()
    assert.equal(await pending,undefined)
    assert.ok(context.calls.at(-1)?.endsWith('/revoke'))
    assert.equal(context.saved?.ledgerCredential,undefined)
  }
})

test('invalid credential receipts and outages back off without persisting wrong ownership or scope',async()=>{
  for(const patch of [{userId:'another-user'},{deviceId:'another-device'},{scope:'admin'},{key:'administrator'},{expiresAt:Date.now()+86_400_000}]) {
    const context=fixture()
    context.respond=async()=>Response.json({key:'tsu_'+'a'.repeat(32),userId,deviceId,scope:'usage:write',expiresAt:Date.now()+3_500_000,...patch})
    assert.equal(await context.provider.resolve(deviceId),undefined)
    assert.equal(await context.provider.resolve(deviceId),undefined)
    assert.equal(context.calls.length,1);assert.equal(context.saved?.ledgerCredential,undefined)
  }
  const context=fixture();context.respond=async()=>Response.json({error:'busy'},{status:503})
  assert.equal(await context.provider.resolve(deviceId),undefined);assert.equal(await context.provider.resolve(deviceId),undefined)
  assert.equal(context.calls.length,1);context.advance(300_001);await context.provider.resolve(deviceId);assert.equal(context.calls.length,2)
})

test('credential rate limits honor the account retry deadline instead of polling every five minutes',async()=>{
  const context=fixture()
  context.respond=async()=>Response.json({error:'credential_rate_limited'},{status:429,headers:{'retry-after':'3600'}})
  assert.equal(await context.provider.resolve(deviceId),undefined)
  context.advance(300_001)
  assert.equal(await context.provider.resolve(deviceId),undefined)
  assert.equal(context.calls.length,1)
  context.advance(3_300_000)
  await context.provider.resolve(deviceId)
  assert.equal(context.calls.length,2)
})
