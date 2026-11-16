'use strict';
// Core operational alerts: unusual patterns prompt a human check, never
// assert fraud, reverse cash or block the normal cashier workflow.
const {currencies}=require('../../config/currencies');
const {mobileTransactionModel,notificationMessageModel,tenantUserModel,auditEventModel}=require('../models');
const FLAGS=Object.freeze(['large_relative_to_float','rapid_repeat']);
function classify({amountMinor,currency,priorFloatMinor=0n,recentExactCount=0}={}){
 if(!Object.hasOwn(currencies,currency))throw Error('Unsupported Mobile Money risk currency');
 const amount=BigInt(String(amountMinor??'0'));
 const prior=BigInt(String(priorFloatMinor??'0'));
 const minimum=1000n*10n**BigInt(currencies[currency]);
 // Uganda's high-value alert floor avoids disturbing owners for tiny tickets.
 const floor=currency==='UGX'?100000n:minimum;
 const signals=[];
 if(prior>0n&&amount>=floor&&amount*2n>=prior)signals.push('large_relative_to_float');
 if(Number(recentExactCount)>=2)signals.push('rapid_repeat');
 return signals;
}
async function assess(conn,session,values,funding,now=new Date()){
 if(!session)throw Error('Financial risk assessment requires the transaction session');
 let recentExactCount=0;
 if(values.customerPhone){
  recentExactCount=await mobileTransactionModel(conn).countDocuments({
   branchId:values.branchId,network:values.network,operation:values.operation,
   customerPhone:values.customerPhone,amountMinor:String(values.amountMinor),
   createdAt:{$gte:new Date(now.valueOf()-10*60000),$lte:now},
   status:{$ne:'voided_internal'},correctionState:{$ne:'voided'}
  }).session(session);
 }
 const flags=classify({amountMinor:values.amountMinor,currency:values.currency,
  priorFloatMinor:funding.walletBalanceBeforeMinor||0,recentExactCount});
 return flags;
}
async function queueOwnerAlerts(conn,session,record,operator,flags){
 if(!session||!record?._id)throw Error('Committed record and transaction session required');
 if(!flags?.length)return 0;
 if(flags.some(f=>!FLAGS.includes(f)))throw Error('Unsupported financial flag');
 const owners=await tenantUserModel(conn).find({role:'Tenant Owner',status:'active'})
  .select('_id role status').limit(5).session(session).lean();
 for(const owner of owners){
  const reasons=flags.map(f=>f==='rapid_repeat'?'several similar customer operations within 10 minutes':
   'a transaction large relative to the recorded provider float').join('; ');
  const text='A Mobile Money entry was recorded with an unusual pattern ('+reasons+
   '). This is an attention flag, not proof of fraud or a provider confirmation. '+
   'Review the entry and its provider evidence in Classic FinHub, Mobile Money history. '+
   'Reference ID: '+String(record._id)+'. No cash or float movement was made by this notification.';
  const [message]=await notificationMessageModel(conn).create([{
   dedupeKey:'momo-risk:'+String(record._id)+':'+String(owner._id),
   recipientId:owner._id,senderId:operator.id,branchId:String(record.branchId),
   templateCode:'system_momo_exception',templateVersion:1,
   subject:'Mobile Money transaction needs attention',
   body:text,source:'financial_exception',sourceId:record._id,
   emailState:'pending'
  }],{session});
  await auditEventModel(conn).create([{
   actorId:operator.id,targetId:record._id,action:'mobile_money.risk.notice_queued',
   metadata:{flags,noticeId:String(message._id),ownerId:String(owner._id),branchId:String(record.branchId)}
  }],{session});
 }
 return owners.length;
}
async function ownerAlerts(conn,actor,limit=12){
 if(actor?.role!=='Tenant Owner')return [];
 const take=Number.isSafeInteger(limit)?Math.min(25,Math.max(1,limit)):12;
 return notificationMessageModel(conn).find({
  recipientId:actor.id,source:'financial_exception'
 }).select('_id sourceId subject body createdAt readAt emailState').sort({createdAt:-1}).limit(take).lean();
}
async function acknowledge(conn,actor,id){
 if(actor?.role!=='Tenant Owner'||!String(id||'').match(/^[a-f0-9]{24}$/i))
  throw Object.assign(new Error('Owner financial alert unavailable'),{status:403});
 const row=await notificationMessageModel(conn).findOneAndUpdate({
  _id:id,recipientId:actor.id,source:'financial_exception',readAt:null
 },{$set:{readAt:new Date()}},{new:true}).lean();
 return row||notificationMessageModel(conn).findOne({_id:id,recipientId:actor.id,
  source:'financial_exception'}).lean();
}
module.exports={FLAGS,classify,assess,queueOwnerAlerts,ownerAlerts,acknowledge};
