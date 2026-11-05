#!/usr/bin/env node
'use strict';
const {SOURCES,validateAlertUrl,alertFromEnvironment}=require('../src/platform/services/ops-alert.service');
async function main(){
 const [action,source,extra]=process.argv.slice(2);
 if(extra||!['doctor','send'].includes(action))throw new Error('Usage: npm run ops:doctor OR node scripts/ops-alert.js send backup-failure');
 validateAlertUrl(process.env.OPS_ALERT_URL);
 if(action==='doctor'){
  await require('../src/platform/services/ops-token.service').loadSecretToken(process.env.OPS_ALERT_TOKEN_FILE);
  console.log(JSON.stringify({event:'ops.alert.config',status:'valid',deliveryTested:false}));return;
 }
 if(!SOURCES.has(source))throw new Error('Unknown operational event');
 await alertFromEnvironment(source);
 console.log(JSON.stringify({event:'ops.alert',status:'accepted-by-endpoint',source}));
}
main().catch(error=>{console.error(JSON.stringify({event:'ops.alert',status:'failed',reason:error.message.replace(/https?:\/\/\S+/g,'[redacted-url]')}));process.exitCode=2;});
