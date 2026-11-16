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
// Risk flags are committed with the transaction and act as a durable outbox.
// Notification or email failures cannot roll back a legitimate cash/float entry.
// Upserts are idempotent across crashes, restarts and concurrent workers.
async function dispatchPending(conn,{limit=10,tenantModels=models}={}){
 if(!Number.isSafeInteger(limit)||limit<1||limit>25)throw new Error('Invalid risk alert dispatch limit');
 const Mobile=tenantModels.mobileTransactionModel(conn),Messages=tenantModels.notificationMessageModel(conn);
 const pending=await Mobile.find({'riskSignals.0':{$exists:true},riskAlertsSynced:{$ne:true}})
  .select('_id riskSignals network branchId operatorId createdAt')
  .sort({createdAt:1,_id:1}).limit(limit).lean();
 if(!pending.length)return 0;
 const owners=await tenantModels.tenantUserModel(conn).find({role:'Tenant Owner',status:'active'})
  .select('_id').limit(51).lean();
 if(owners.length>50)throw new Error('Too many active tenant owners for risk alert dispatch');
 if(!owners.length)return 0;
 let processed=0;
 for(const record of pending){
  for(const owner of owners){
   const dedupeKey=`mm-risk:${record._id}:${owner._id}`;
   const recent=await Messages.exists({recipientId:owner._id,source:'risk_alert',
    emailState:{$in:['pending','processing','retry','accepted']},
    createdAt:{$gte:new Date(Date.now()-15*60000)}});
   try{
    await Messages.updateOne({dedupeKey},{$setOnInsert:{
     dedupeKey,recipientId:owner._id,senderId:record.operatorId,branchId:String(record.branchId||''),
     templateCode:'mobile_money_risk',templateVersion:1,
     subject:'Mobile Money transaction needs attention',
     body:`Mobile Money ${record.network} transaction ${record._id} was recorded and flagged: ${record.riskSignals.map(s=>LABELS[s]||s).join('; ')}. Investigate /tenant/mobile-money/${record._id}. This record does not prove external provider settlement.`,
     source:'risk_alert',sourceId:record._id,emailState:recent?'not_requested':'pending'
    }},{upsert:true,runValidators:true});
   }catch(error){if(error?.code!==11000)throw error;}
  }
  // A failed owner notice leaves this transaction pending for the next sweep.
  await Mobile.updateOne({_id:record._id,riskAlertsSynced:{$ne:true}},
   {$set:{riskAlertsSynced:true,riskAlertsSyncedAt:new Date()}});
  processed++;
 }
 return processed;
}
module.exports={LABELS,classify,assess,dispatchPending};
