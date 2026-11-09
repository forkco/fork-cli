import {createCipheriv,createDecipheriv,createPublicKey,publicEncrypt,privateDecrypt,generateKeyPair,randomBytes,randomUUID,constants} from 'node:crypto';
import {promisify} from 'node:util';
import {Failure,check} from './errors.js';

const generate=promisify(generateKeyPair);
const b64=bytes=>Buffer.from(bytes).toString('base64url');
const fail=()=>new Failure(409,'vault_key_unavailable','Unlock this browser profile from a trusted device');

export function seal(plain,publicKey,context){
  const key=randomBytes(32),iv=randomBytes(12);
  try{
    const recipient=createPublicKey({key:Buffer.from(publicKey,'base64'),format:'der',type:'spki'});
    check(recipient.asymmetricKeyType==='rsa'&&recipient.asymmetricKeyDetails.modulusLength===3072,'Invalid vault public key');
    const protectedHeader=b64(JSON.stringify({alg:'RSA-OAEP-256',enc:'A256GCM',ctx:context}));
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(protectedHeader,'ascii'));
    const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
    return {protected:protectedHeader,encrypted_key:b64(publicEncrypt({key:recipient,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},key)),iv:b64(iv),ciphertext:b64(ciphertext),tag:b64(cipher.getAuthTag())};
  }finally{key.fill(0)}
}
export function unseal(envelope,privateKey,context,max=4096){
  let key;
  try{
    const h=JSON.parse(Buffer.from(envelope.protected,'base64url'));
    if(h.alg!=='RSA-OAEP-256'||h.enc!=='A256GCM'||h.ctx!==context)throw fail();
    const wrapped=Buffer.from(envelope.encrypted_key,'base64url'),iv=Buffer.from(envelope.iv,'base64url'),tag=Buffer.from(envelope.tag,'base64url'),ciphertext=Buffer.from(envelope.ciphertext,'base64url');
    if(wrapped.length!==384||iv.length!==12||tag.length!==16||ciphertext.length>max||!ciphertext.length)throw fail();
    key=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},wrapped);
    if(key.length!==32)throw fail();
    const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(envelope.protected,'ascii'));cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext),cipher.final()]);
  }catch{throw fail()}finally{key?.fill(0)}
}

// Ephemeral decryptors live only in this runner, never in Go, SQL or S3.
const exchanges=new Map();let pending=0;
const inputExchanges=new Map();
export async function createExchange(owner,vaultID,profileID,runID=''){
  const now=Date.now();for(const[id,value]of exchanges)if(value.expires<=now)exchanges.delete(id);
  if(exchanges.size+inputExchanges.size+pending>=64)throw new Failure(429,'vault_exchange_limit','Too many pending unlocks');
  pending++;
  try{
    const keys=await generate('rsa',{modulusLength:3072,publicExponent:65537});
    const id=randomUUID();exchanges.set(id,{owner:owner.user_id+':'+owner.app_id,vaultID,profileID,runID,key:keys.privateKey,expires:Date.now()+120000});
    setTimeout(()=>exchanges.delete(id),120000).unref();
    return {id,public_key:keys.publicKey.export({format:'der',type:'spki'}).toString('base64')};
  }finally{pending--}
}

export async function createInputExchange(owner,session,origin){
  if(exchanges.size+inputExchanges.size+pending>=64)throw new Failure(429,'vault_exchange_limit','Too many pending unlocks');
  pending++;
  try{
    const keys=await generate('rsa',{modulusLength:3072,publicExponent:65537}),id=randomUUID();
    const context=JSON.stringify(['fork-computer-input-v1',owner.user_id,owner.app_id,session,id,origin]);
    inputExchanges.set(id,{owner:owner.user_id+':'+owner.app_id,session,origin,key:keys.privateKey,expires:Date.now()+900000,context});
    setTimeout(()=>inputExchanges.delete(id),900000).unref();
    return {exchange_id:id,public_key:keys.publicKey.export({format:'der',type:'spki'}).toString('base64'),context};
  }finally{pending--}
}
export function openInput(owner,session,origin,input){
  const entry=inputExchanges.get(input.exchange_id);
  if(!entry||entry.expires<=Date.now()||entry.owner!==owner.user_id+':'+owner.app_id||entry.session!==session||entry.origin!==origin||typeof input.field_id!=='string'||input.field_id.length>64)throw fail();
  const context=JSON.stringify([...JSON.parse(entry.context),input.field_id]);
  const plain=unseal(input.envelope,entry.key,context,50000);
  try{const value=JSON.parse(plain.toString('utf8'));if(typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)))throw fail();return String(value)}finally{plain.fill(0)}
}
export function dropInputExchanges(session){for(const[id,entry]of inputExchanges)if(entry.session===session)inputExchanges.delete(id)}
// Opens a key a device sealed to one of our exchange keys. The exchange is
// bound to the owner, vault, key ID and run it was created for, and is single-use.
export function consumeExchange(owner,sealed,vaultID,runID=''){
  const entry=exchanges.get(sealed.exchange_id);
  if(!entry||entry.expires<=Date.now()||entry.owner!==owner.user_id+':'+owner.app_id||entry.vaultID!==vaultID||entry.profileID!==sealed.id||entry.runID!==(runID||''))throw fail();
  exchanges.delete(sealed.exchange_id);
  const context=JSON.stringify(['fork-vault-unlock-v1',owner.user_id,vaultID,sealed.id,sealed.exchange_id]);
  const key=unseal(sealed.sealed_key,entry.key,context,32);
  if(key.length!==32){key.fill(0);throw fail()};return key;
}
