'use strict';
const crypto=require('node:crypto');

// Only internal identifiers are generated. Real network references, receipts,
// currency rates and bank/account identities must always come from actual evidence.
function base(name,separator,maxLength){
 let normalized=String(name||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .toLowerCase().replace(/[^a-z0-9]+/g,separator)
  .replace(new RegExp('^'+separator+'+|'+separator+'+$','g'),'');
 if(!/^[a-z]/.test(normalized))normalized='item'+separator+normalized;
 return normalized.slice(0,maxLength).replace(new RegExp(separator+'+$'),'')||'item';
}
function branchCode(name){
 return base(name,'-',18)+'-'+crypto.randomBytes(6).toString('hex');
}
function catalogCode(name){
 return base(name,'_',29)+'_'+crypto.randomBytes(5).toString('hex');
}
function notificationCode(name){return 'n_'+base(name,'_',27)+'_'+crypto.randomBytes(5).toString('hex');}
module.exports={branchCode,catalogCode,notificationCode};
