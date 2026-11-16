'use strict';
// Advisory checks only. They never approve, block or settle a financial operation.
const models=require('../models');
const LABELS=Object.freeze({rapid_repeat:'Rapid repeat activity',unusual_amount:'Large compared with recent transactions',wallet_balance_mismatch:'Reported wallet balance differs from book'});
function classify({amountMinor,peerAmounts=[],previousForPhone=0,walletExpected=null,walletReported=null}={}){
 const flags=[];
 if(previousForPhone>=3)flags.push('rapid_repeat');
 if(peerAmounts.length>=10){
  const amounts=peerAmounts.map(x=>BigInt(String(x))).filter(x=>x>0n).sort((a,b)=>a<b?-1:a>b?1:0);
  if(amounts.length>=10&&BigInt(String(amountMinor))>=amounts[Math.floor(amounts.length/2)]*5n)flags.push('unusual_amount');
 }
 if(walletExpected!==null&&walletReported!==null&&BigInt(String(walletExpected))!==BigInt(String(walletReported)))flags.push('wallet_balance_mismatch');
 return flags;
}
async function assess(conn,session,Model,values,branchId,funding){
 const now=Date.now();
 const previousForPhone=values.customerPhone?await Model.countDocuments({branchId,network:values.network,operation:values.operation,
  customerPhone:values.customerPhone,status:{$nin:['voided_internal','rejected']},
  correctionState:{$ne:'voided'},createdAt:{$gte:new Date(now-10*60000)}}).session(session):0;
 const peers=await Model.find({branchId,currency:values.currency,network:values.network,operation:values.operation,
  status:{$nin:['voided_internal','rejected']},correctionState:{$ne:'voided'},
  createdAt:{$gte:new Date(now-90*86400000)}}).select('amountMinor')
  .sort({createdAt:-1,_id:-1}).limit(25).session(session).lean();
 let walletReported=null;
 if(values.observedWalletBalance&&funding?.walletBalanceAfterMinor!=null){
  try{walletReported=require('./mobileMoney.service').toMinor(values.observedWalletBalance,values.currency,true);}
  catch{walletReported=null;}
 }
 return classify({amountMinor:values.amountMinor,previousForPhone,peerAmounts:peers.map(x=>x.amountMinor),
  walletExpected:funding?.walletBalanceAfterMinor??null,walletReported});
}
async function notifyOwners(conn,session,record,actor){
 if(!record?.riskSignals?.length)return 0;
 const owners=await models.tenantUserModel(conn).find({role:'Tenant Owner',status:'active'})
  .select('_id').limit(10).session(session).lean();
 const Messages=models.notificationMessageModel(conn);let sent=0;
 for(const owner of owners){
  const existing=await Messages.exists({recipientId:owner._id,source:'risk_alert',branchId:String(record.branchId),
   emailState:{$in:['pending','processing','retry','accepted']},
   createdAt:{$gte:new Date(Date.now()-15*60000)}}).session(session);
  await Messages.create([{
   dedupeKey:`mm-risk:${record._id}:${owner._id}`,recipientId:owner._id,senderId:actor.id,branchId:String(record.branchId),
   templateCode:'mobile_money_risk',templateVersion:1,subject:'Mobile Money transaction needs attention',
   body:`Mobile Money record ${record.network} / ${record.networkReference} was saved and flagged: ${record.riskSignals.map(s=>LABELS[s]||s).join('; ')}. Investigate /tenant/mobile-money/${record._id}. Recording is final; this does not prove external settlement.`,
   source:'risk_alert',sourceId:record._id,emailState:existing?'not_requested':'pending'
  }],{session});sent++;
 }
 return sent;
}
module.exports={LABELS,classify,assess,notifyOwners};
