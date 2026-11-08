'use strict';
const provider=require('./provider'),encryption=require('./crypto');
function validateConfig(input=process.env,{worker=false}={}){const enabled=provider.mode(input)!=='none';if(enabled&&!encryption.configured(input))throw Object.assign(new Error('Transfer SMS encryption key is not configured'),{code:'SMS_KEY_NOT_CONFIGURED'});if(worker)provider.settings(input);return {enabled};}
module.exports={validateConfig};
