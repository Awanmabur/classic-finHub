'use strict';
function fail(code){return Object.assign(new Error('Transfer SMS provider request did not complete'),{code});}
function mode(input=process.env){const value=input.TRANSFER_SMS_PROVIDER||'none';if(!['none','twilio'].includes(value))throw fail('SMS_PROVIDER_NOT_CONFIGURED');return value;}
function settings(input=process.env){
 if(mode(input)==='none')return null;
 const account=input.TWILIO_ACCOUNT_SID,token=input.TWILIO_AUTH_TOKEN,from=input.TWILIO_FROM_NUMBER,service=input.TWILIO_MESSAGING_SERVICE_SID;
 if(!/^AC[a-f0-9]{32}$/i.test(account||'')||typeof token!=='string'||token.length<16||token.length>200||/[\s\x00-\x1f\x7f]/.test(token)||!!from===!!service||(from&&!/^\+[1-9]\d{7,14}$/.test(from))||(service&&!/^MG[a-f0-9]{32}$/i.test(service)))throw fail('SMS_PROVIDER_NOT_CONFIGURED');
 return {account,token,from,service};
}
function payload(value){if(!value||typeof value.to!=='string'||!/^\+[1-9]\d{7,14}$/.test(value.to)||typeof value.body!=='string'||!value.body.trim()||value.body.length>1200||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.body))throw fail('SMS_PAYLOAD_INVALID');return {to:value.to,body:value.body};}
async function readResponse(response){
 const limit=16384,declared=Number(response.headers?.get?.('content-length'));if(Number.isFinite(declared)&&declared>limit)throw fail('SMS_SUBMISSION_UNCERTAIN');
 if(!response.body||typeof response.body.getReader!=='function')throw fail('SMS_SUBMISSION_UNCERTAIN');
 const reader=response.body.getReader(),chunks=[];let bytes=0;
 try{for(;;){const result=await reader.read();if(result.done)break;bytes+=result.value.byteLength;if(bytes>limit){await reader.cancel().catch(()=>{});throw fail('SMS_SUBMISSION_UNCERTAIN');}chunks.push(Buffer.from(result.value));}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw fail('SMS_SUBMISSION_UNCERTAIN');}finally{reader.releaseLock();}
}
async function send(input,{fetcher=fetch,timeoutMs=15000}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>15000)throw fail('SMS_PROVIDER_NOT_CONFIGURED');
 const config=settings();if(!config)throw fail('SMS_PROVIDER_NOT_CONFIGURED');const content=payload(input);
 const body=new URLSearchParams({To:content.to,Body:content.body,...(config.from?{From:config.from}:{MessagingServiceSid:config.service})});
 let response;
 try{response=await fetcher(`https://api.twilio.com/2010-04-01/Accounts/${config.account}/Messages.json`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(config.account+':'+config.token).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}catch{throw fail('SMS_SUBMISSION_UNCERTAIN');}
 if(response.status===429)throw fail('SMS_RATE_LIMITED');
 if(response.status===408||response.status>=500)throw fail('SMS_SUBMISSION_UNCERTAIN');
 if(!response.ok)throw fail('SMS_PROVIDER_REJECTED');
 const result=await readResponse(response);
 if(!/^SM[a-f0-9]{32}$/i.test(result?.sid||'')||!['accepted','queued','sending','sent','delivered'].includes(result.status))throw fail('SMS_SUBMISSION_UNCERTAIN');
 return {status:'accepted',messageId:result.sid,providerState:result.status};
}
module.exports={mode,settings,payload,send,readResponse};
