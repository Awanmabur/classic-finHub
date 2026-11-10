'use strict';
const mongoose=require('mongoose');
const rules=require('./models');
const workspace=require('../workspace/service');
const {forexCurrencies,currencyCodes}=require('../../config/currencies');
const {networks}=require('../../config/mobileNetworks');
const {branchModel,auditEventModel}=require('../models');
const moduleAccess=require('../services/moduleAccess.service');
const MAX_FIXED_MINOR=10000000000n;
const allowed=new Set(['id','branchId','operation','currency','network','feeFixed','feePercent','costFixed','costPercent','enabled','revision','_csrf']);
function fail(message,status=400){return Object.assign(Error(message),{status});}
function identifier(value,label='pricing rule'){
 if(typeof value!=='string'||!/^[a-f0-9]{24}$/i.test(value))throw fail('Choose a valid '+label+'.');
 return new mongoose.Types.ObjectId(value);
}
function decimalMinor(value,currency){
 const scale=forexCurrencies[currency];
 if(scale===undefined||value!==undefined&&typeof value!=='string')throw fail('Enter a valid fixed amount in the selected currency.');
 const text=(value??'0').trim();
 if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(text))throw fail('Enter a non-negative fixed amount in the selected currency.');
 const [whole,fraction='']=text.split('.');
 if(fraction.length>scale)throw fail('The fixed amount exceeds the selected currency precision.');
 const minor=BigInt(whole)*10n**BigInt(scale)+BigInt(fraction.padEnd(scale,'0')||'0');
 if(minor>MAX_FIXED_MINOR)throw fail('The fixed amount is outside permitted limits.');
 return String(minor);
}
function percentage(value){
 if(value!==undefined&&typeof value!=='string')throw fail('Enter a percentage from 0 to 100 with at most two decimal places.');
 const text=(value??'0').trim();
 if(!/^\d{1,3}(?:\.\d{1,2})?$/.test(text))throw fail('Enter a percentage from 0 to 100 with at most two decimal places.');
 const [whole,fraction='']=text.split('.'),bps=Number(whole)*100+Number(fraction.padEnd(2,'0'));
 if(bps>10000)throw fail('A percentage cannot exceed 100.');
 return bps;
}
function validate(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.has(key)))throw fail('This field cannot be changed from pricing settings.');
 const operation=typeof input.operation==='string'?input.operation:'',currency=typeof input.currency==='string'?input.currency:'';
 if(!rules.operations.some(row=>row.key===operation))throw fail('Choose a valid operation.');
 if(!Object.hasOwn(forexCurrencies,currency)||!operation.startsWith('forex.')&&!currencyCodes.includes(currency))throw fail('Choose a supported operation currency.');
 const network=input.network??'';
 if(typeof network!=='string'||network&&(!operation.startsWith('mobile_money.')||!networks.includes(network)))throw fail('Network-specific pricing applies only to a supported Mobile Money network.');
 const branchId=input.branchId===undefined||input.branchId===''?null:identifier(input.branchId,'branch');
 if(!['true','false','on',true,false,undefined].includes(input.enabled))throw fail('Choose whether the pricing rule is enabled.');
 const enabled=[true,'true','on',undefined].includes(input.enabled);
 return {branchId,operation,currency,network,fixedFeeMinor:decimalMinor(input.feeFixed,currency),feeBps:percentage(input.feePercent),fixedCostMinor:decimalMinor(input.costFixed,currency),costBps:percentage(input.costPercent),enabled};
}
function sameScope(row,input){return String(row.branchId||'')===String(input.branchId||'')&&row.operation===input.operation&&row.currency===input.currency&&(row.network||'')===input.network;}
function auditPrices(row){return row?{fixedFeeMinor:String(row.fixedFeeMinor),feeBps:row.feeBps,fixedCostMinor:String(row.fixedCostMinor),costBps:row.costBps,enabled:row.enabled,revision:row.revision}:null;}
function currentAccount(actor,trusted){const version=actor?.authVersion??0;if(!Number.isSafeInteger(version)||version<0||trusted.authVersion!==version)throw fail('Your account credentials changed. Sign in again before accessing pricing settings.',403);}
function permittedOperations(tenant,actor){return rules.operations.filter(row=>moduleAccess.hasModuleForUser(tenant,actor,row.moduleKey)&&moduleAccess.hasPermission(actor,row.moduleKey+'.view'));}
function operationAccess(tenant,actor,operation){if(!permittedOperations(tenant,actor).some(row=>row.key===operation))throw fail('An active subscription to this operational module is required to configure its prices.',403);}
async function read(conn,tenant,actor){
 const trusted=await workspace.access(conn,tenant,actor,{manage:true});
 currentAccount(actor,trusted.actor);
 const operations=permittedOperations(trusted.tenant,trusted.actor);
 const [found,branches]=await Promise.all([
  operations.length?rules.model(conn).find({tenantId:trusted.tenant._id,operation:{$in:operations.map(row=>row.key)}}).sort({operation:1,currency:1,branchId:1,network:1}).limit(5001).lean():[],
  branchModel(conn).find({status:'active'}).sort({name:1,_id:1}).lean()
 ]);
 if(found.length>5000)throw fail('This workspace has more than 5,000 pricing rules. Contact the platform administrator to review its configuration.',422);
 return {rules:found,branches,operations};
}
async function save(conn,tenant,actor,input){
 const first=await workspace.access(conn,tenant,actor,{manage:true});
 currentAccount(actor,first.actor);
 const value=validate(input),expected=workspace.revision(input.revision??'0'),recordId=input.id?identifier(input.id):null;
 operationAccess(first.tenant,first.actor,value.operation);
 if(!recordId&&expected!==0)throw fail('Pricing settings changed. Reload this page before saving.',409);
 await rules.ensure(conn);const session=await conn.startSession();let result;
 try{
  await session.withTransaction(async()=>{
   const trusted=await workspace.access(conn,tenant,actor,{manage:true,fence:true,session});
   operationAccess(trusted.tenant,trusted.actor,value.operation);
   if(value.branchId&&(!recordId||value.enabled)){
    const branch=await branchModel(conn).findOne({_id:value.branchId,status:'active'}).session(session).lean();
    if(!branch)throw fail('Choose an active branch in this workspace.',409);
    if(currencyCodes.includes(value.currency)&&!require('../services/branchCurrency.service').supports(branch,value.currency))throw fail('Enable this currency at the selected branch before configuring its price.',409);
   }
   const tenantId=trusted.tenant._id,Model=rules.model(conn),updatedBy=trusted.actor.id;
   let before=null;
   if(recordId){
    const existing=await Model.findOne({_id:recordId,tenantId}).session(session).lean();
    if(!existing||existing.revision!==expected)throw fail('Pricing settings changed. Reload this page before saving.',409);
    if(!sameScope(existing,value))throw fail('A pricing rule’s branch, operation, currency and network are fixed. Create another rule for a different scope.',409);
    before=auditPrices(existing);
    result=await Model.findOneAndUpdate({_id:recordId,tenantId,revision:expected},{$set:{fixedFeeMinor:value.fixedFeeMinor,feeBps:value.feeBps,fixedCostMinor:value.fixedCostMinor,costBps:value.costBps,enabled:value.enabled,updatedBy},$inc:{revision:1}},{session,new:true,runValidators:true});
    if(!result)throw fail('Pricing settings changed. Reload this page before saving.',409);
   }else{
    [result]=await Model.create([{...value,tenantId,revision:0,createdBy:updatedBy,updatedBy}],{session});
   }
   await auditEventModel(conn).create([{actorId:updatedBy,action:recordId?'workspace.pricing.updated':'workspace.pricing.created',targetId:result._id,
    metadata:{tenantId:String(tenantId),branchId:String(value.branchId||''),operation:value.operation,currency:value.currency,network:value.network,revision:result.revision,enabled:value.enabled,costEstimateOnly:true,before,after:auditPrices(result)}}],{session});
  });
  return result;
 }catch(error){if(error.code===11000)throw fail('A pricing rule already exists for this branch, operation, currency and network. Edit that rule instead.',409);throw error;}
 finally{await session.endSession();}
}
async function context(conn,tenant,branch,{session=null}={}){
 const branchId=branch?._id??branch;
 const filter={tenantId:tenant._id,$or:[{branchId:null},...(branchId?[{branchId}]:[])]};
 return rules.model(conn).find(filter).session(session).lean();
}
function select(found,{operation,currency,network='',branchId=null}){
 const candidates=found.filter(row=>row.enabled!==false&&row.operation===operation&&row.currency===currency&&
  (!row.branchId||String(row.branchId)===String(branchId||''))&&(!(row.network||'')||row.network===network));
 // A specific branch wins over a tenant default, then a network-specific rule
 // wins within that scope. The unique index makes this order unambiguous.
 candidates.sort((a,b)=>(Number(Boolean(b.branchId))*2+Number(Boolean(b.network)))-(Number(Boolean(a.branchId))*2+Number(Boolean(a.network))));
 return candidates[0]||null;
}
function snapshot(rule,amountMinor,currency){
 if(!Object.hasOwn(forexCurrencies,currency)||!/^\d{1,24}$/.test(String(amountMinor)))throw fail('Enter a valid positive pricing amount.');
 if(rule?.currency&&rule.currency!==currency)throw fail('Pricing currency does not match this operation.',409);
 if(rule&&(!/^[a-f0-9]{24}$/i.test(String(rule._id))||!Number.isSafeInteger(rule.revision)||rule.revision<0))throw fail('Pricing settings are invalid. Ask the tenant owner to review them.',409);
 const amount=BigInt(String(amountMinor));
 const fixedFeeMinor=String(rule?.fixedFeeMinor??'0'),fixedCostMinor=String(rule?.fixedCostMinor??'0'),feeBps=rule?.feeBps??0,costBps=rule?.costBps??0;
 if(!/^\d{1,11}$/.test(fixedFeeMinor)||!/^\d{1,11}$/.test(fixedCostMinor)||BigInt(fixedFeeMinor)>MAX_FIXED_MINOR||BigInt(fixedCostMinor)>MAX_FIXED_MINOR||![feeBps,costBps].every(value=>Number.isSafeInteger(value)&&value>=0&&value<=10000))throw fail('Pricing settings are invalid. Ask the tenant owner to review them.',409);
 return {policyId:rule?String(rule._id):null,revision:rule?.revision??0,operation:rule?.operation||'',currency,
  feeMinor:String(BigInt(fixedFeeMinor)+(amount*BigInt(feeBps)+5000n)/10000n),costMinor:String(BigInt(fixedCostMinor)+(amount*BigInt(costBps)+5000n)/10000n),fixedFeeMinor,feeBps,fixedCostMinor,costBps};
}
module.exports={operations:rules.operations,read,save,context,select,snapshot,validate,decimalMinor,percentage,permittedOperations};
