'use strict';
// Minimal, redacted operational incident webhook. No tenant IDs, credentials,
// customer records, database URLs, stack traces, or arbitrary caller content.
const https=require('node:https');
const net=require('node:net');
const {loadSecretToken}=require('./ops-token.service');
const SOURCES=new Set(['backup-failure','backup-stale','offsite-failure','offsite-stale','recovery-drill','deployment-failure','backup-heartbeat','test']);
function validateAlertUrl(value){
  if(!value)throw new Error('OPS_ALERT_URL must be configured');
  const url=new URL(value);
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||url.search||url.hash||url.port)throw new Error('Operational webhook must use a credential-free HTTPS URL');
  if(net.isIP(url.hostname)||url.hostname.startsWith('[')||!url.hostname.includes('.')||/\.(local|internal|localhost)$/i.test(url.hostname)||url.hostname==='localhost')throw new Error('Operational webhook must use a public DNS hostname');
  return url;
}
function buildAlert(source,now=new Date()){
  if(!SOURCES.has(source))throw new Error('Invalid operational event type');
  if(!(now instanceof Date)||!Number.isFinite(now.valueOf()))throw new Error('Invalid alert timestamp');
  return {service:'classicfin-hub',severity:['test','backup-heartbeat'].includes(source)?'info':'critical',event:source,occurredAt:now.toISOString(),action:source==='backup-heartbeat'?'Local and offsite backup health checks passed; external monitor must alert if heartbeats stop.':'Investigate the operational control in private logs and follow the incident runbook.'};
}
async function postAlert({url,token,alert,timeoutMs=6000,transport=https}={}){
  const endpoint=validateAlertUrl(url);
  if(typeof token!=='string'||token.length<24||/[\r\n]/.test(token))throw new Error('A dedicated operational webhook token is required');
  const data=JSON.stringify(alert);
  if(Buffer.byteLength(data)>4096)throw new Error('Operational alert too large');
  return new Promise((resolve,reject)=>{
    const req=transport.request(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),'Authorization':`Bearer ${token}`},timeout:timeoutMs},res=>{
      res.resume();
      res.on('end',()=>{if(res.statusCode>=200&&res.statusCode<300)resolve({acceptedByEndpoint:true});else reject(new Error('Operational alert endpoint refused request'));});
    });
    req.on('timeout',()=>req.destroy(new Error('Operational alert timed out')));
    req.on('error',()=>reject(new Error('Operational alert delivery failed')));
    req.end(data);
  });
}
async function alertFromEnvironment(source){
  const token=await loadSecretToken(process.env.OPS_ALERT_TOKEN_FILE);
  return postAlert({url:process.env.OPS_ALERT_URL,token,alert:buildAlert(source)});
}
module.exports={SOURCES,validateAlertUrl,buildAlert,postAlert,alertFromEnvironment};
