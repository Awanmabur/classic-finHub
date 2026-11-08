'use strict';
const {Types}=require('mongoose');
const treasury=require('../treasury/service');
const fundsModels=require('../treasury/models');
const core=require('../models');
const directory=require('../customerAccounts/models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
function fail(message,status=409){return Object.assign(new Error(message),{status});}
function oid(value){if(!/^[a-f0-9]{24}$/i.test(String(value||'')))throw fail('Choose a valid funds account',400);return new Types.ObjectId(String(value));}
function money(value,currency){return require('./mobileMoney.service').formatMoneyMinor(value,currency);}
function summary(account){return {id:String(account._id),name:account.name,kind:account.kind,network:account.network,currency:account.currency,
 expected:account.openingBalanceMinor===null?null:money(account.bookBalanceMinor,account.currency),observed:account.lastObservedMinor===null?null:money(account.lastObservedMinor,account.currency),
 observedAt:account.lastObservationAt,variance:account.lastVarianceMinor===null?null:money(account.lastVarianceMinor,account.currency),state:account.status,reconciliation:account.reconciliationState,
 expectedMinor:account.openingBalanceMinor===null?null:String(account.bookBalanceMinor),lastFour:String(account.accountReference||'').slice(-4),isDefault:Boolean(account.selectionKey),feeTreatment:account.feeTreatment||'record_only'};}
async function context(conn,tenant,actor,branch){
 const trusted=await treasury.access(conn,tenant,actor,{sourceType:'mobile_money'});
 await fundsModels.ensure(conn);
 const currencies=require('./branchCurrency.service').supported(branch);
 const query={tenantId:tenant._id,branchId:branch._id,currency:{$in:currencies},status:{$ne:'archived'},$or:[{operatorId:actor.id},{operatorId:null}]};
 const accounts=await fundsModels.models(conn).account.find(query).sort({name:1}).limit(200).lean();
 let customerAccounts=[];
 if(hasModuleForUser(trusted.tenant,trusted.actor,'accounts')&&hasPermission(trusted.actor,'accounts.view')){
  await directory.ensureIndexes(conn);
  const rows=await directory.accountModel(conn).aggregate([{$match:{branchId:branch._id,currency:{$in:currencies},status:'active'}},
   {$lookup:{from:directory.customerModel(conn).collection.name,localField:'customerId',foreignField:'_id',as:'customer'}},{$unwind:'$customer'},{$match:{'customer.status':'active'}},{$sort:{accountNumber:1}},{$limit:100}]);
  const postings=rows.length?await core.ledgerPostingModel(conn).aggregate([{$match:{accountId:{$in:rows.map(row=>row.ledgerAccountId)},branchId:branch._id,currency:{$in:currencies}}},{$group:{_id:'$accountId',amount:{$sum:{$cond:[{$eq:['$side','credit']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}}}}]):[];
  const balances=new Map(postings.map(row=>[String(row._id),String(row.amount)]));
  customerAccounts=rows.map(row=>({id:String(row._id),name:row.customer.name,last4:row.accountNumber.slice(-4),currency:row.currency,balance:money(balances.get(String(row.ledgerAccountId))||'0',row.currency)}));
 }
 return {wallets:accounts.filter(account=>account.kind==='wallet').map(account=>({...summary(account),assignedToOperator:String(account.operatorId||'')===String(actor.id)})),paymentAccounts:accounts.filter(account=>['cash','bank'].includes(account.kind)).map(summary),customerAccounts,setupHref:'/tenant/treasury'};
}
async function shouldTrack(conn,tenant,values,required){
 if(required||values.walletAccountId)return true;
 return !!await fundsModels.models(conn).account.exists({tenantId:tenant._id,kind:'wallet',network:values.network,currency:values.currency,status:{$ne:'archived'}});
}
async function selectFund(conn,session,authorization,values,kind,explicitId){
 let account;
 if(explicitId)account=await fundsModels.models(conn).account.findOne({_id:oid(explicitId),tenantId:authorization.tenant._id,branchId:values.branchId,kind,currency:values.currency,...(kind==='wallet'?{network:values.network}:{})}).session(session).lean();
 else account=await treasury.findAccount(conn,session,{branchId:values.branchId,kind,network:kind==='wallet'?values.network:'',currency:values.currency,operatorId:authorization.actor.id});
 if(!account)throw fail(`Set up and independently confirm the ${kind==='wallet'?values.network+' wallet':kind+' account'} opening balance before processing.`);
 if(account.operatorId&&String(account.operatorId)!==String(authorization.actor.id))throw fail('Use the funds account assigned to your own operating drawer',403);
 if(account.status!=='active'||account.openingBalanceMinor===null)throw fail('This funds account needs opening approval or reconciliation before use.');
 return account;
}
async function customerCounter(conn,session,authorization,values,delta){
 if(!hasModuleForUser(authorization.tenant,authorization.actor,'accounts')||!hasPermission(authorization.actor,'accounts.view'))throw fail('Customer Accounts access is required for Wallet Balance payments',403);
 const row=await directory.accountModel(conn).findOneAndUpdate({_id:oid(values.customerAccountId),branchId:values.branchId,currency:values.currency,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
 if(!row)throw fail('Choose an active customer account in the operating branch and currency.');
 const customer=await directory.customerModel(conn).findOneAndUpdate({_id:row.customerId,branchId:values.branchId,status:'active'},{$inc:{revision:1}},{new:true,session}).lean();
 if(!customer)throw fail('The selected customer profile is unavailable.');
 const phone=value=>String(value||'').replace(/\D/g,'');
 if(!phone(values.customerPhone)||phone(values.customerPhone)!==phone(customer.phone))throw fail('The customer wallet must belong to the phone number on this transaction.',400);
 const mapping=await core.ledgerAccountModel(conn).findOne({_id:row.ledgerAccountId,branchId:values.branchId,currency:values.currency,category:'liability'}).session(session).lean();
 if(!mapping)throw fail('The customer account ledger mapping is unavailable.');
 const totals=await core.ledgerPostingModel(conn).aggregate([{$match:{accountId:row.ledgerAccountId,branchId:oid(values.branchId),currency:values.currency}},{$group:{_id:null,amount:{$sum:{$cond:[{$eq:['$side','credit']},'$amountMinor',{$multiply:['$amountMinor',-1]}]}}}}]).session(session);
 if(BigInt(String(totals[0]?.amount||'0'))+delta<0n)throw fail('The customer wallet balance is insufficient.');
 return {account:row,line:{currency:values.currency,accountId:row.ledgerAccountId,side:delta<0n?'debit':'credit',amountMinor:String(delta<0n?-delta:delta)}};
}
async function apply(conn,session,authorization,values,{requireObservation=false,receivedAt=null,feeTreatmentSpecified=true,expectedFeeTreatment=null,useConfiguredPolicy=false}={}){
 await fundsModels.ensure(conn);
 const amount=BigInt(values.amountMinor),fee=BigInt(values.feeMinor),sign=values.operation==='cash_in'?-1n:1n;
 const wallet=await selectFund(conn,session,authorization,values,'wallet',values.walletAccountId);
 if(expectedFeeTreatment!==null&&expectedFeeTreatment!==undefined){
  if(!['record_only','payment_collected','wallet_commission'].includes(expectedFeeTreatment))throw fail('Reload the transaction form to obtain valid wallet settings.',400);
  if(expectedFeeTreatment!==(wallet.feeTreatment||'record_only'))throw fail('Wallet settings changed. Reload this page before posting.',409);
 }
 const configuredPolicy=wallet.feeTreatment||'record_only';
 if(useConfiguredPolicy&&feeTreatmentSpecified&&values.feeTreatment!==configuredPolicy)throw fail('Use the fee policy configured on the Wallets page.',409);
 const feeTreatment=useConfiguredPolicy||!feeTreatmentSpecified?configuredPolicy:values.feeTreatment;
 let walletDelta=sign*amount,paymentDelta=-sign*amount;
 if(feeTreatment==='wallet_commission')walletDelta+=fee;
 if(feeTreatment==='payment_collected')paymentDelta+=fee;
 const legs=[{accountId:wallet._id,deltaMinor:String(walletDelta)}],ledgerLines=[];
 let payment=null,customer=null;
 if(values.paymentMethod==='Wallet Balance'){
  const counter=await customerCounter(conn,session,authorization,values,-paymentDelta);customer=counter.account;if(counter.line.amountMinor!=='0')ledgerLines.push(counter.line);
 }else{
  payment=await selectFund(conn,session,authorization,values,values.paymentMethod==='Cash'?'cash':'bank',values.paymentAccountId);
  legs.push({accountId:payment._id,deltaMinor:String(paymentDelta)});
 }
 if(fee>0n&&feeTreatment!=='record_only'){
  const counter=await treasury.ensureCounterAccount(conn,session,{tenantId:authorization.tenant._id,branchId:values.branchId,currency:values.currency,purpose:'fee_income',actorId:authorization.actor.id});
  ledgerLines.push({currency:values.currency,accountId:counter.ledgerAccountId,side:'credit',amountMinor:String(fee)});
 }
 const occurredAt=receivedAt?new Date(receivedAt):new Date();
 if(requireObservation&&(typeof values.observedWalletBalance!=='string'||!values.observedWalletBalance.trim()))throw fail('Enter the actual wallet balance shown after this transaction.',400);
 const applied=await treasury.applyMovements(conn,session,authorization,{sourceType:'mobile_money',sourceRef:`MM:${values.idempotencyKey}`,branchId:values.branchId,legs:legs.filter(leg=>BigInt(leg.deltaMinor)!==0n),ledgerLines,
  description:`${values.network} ${values.operation==='cash_in'?'Cash-in':'Cash-out'} ${values.networkReference}`,evidenceReference:values.networkReference,occurredAt});
 let observation=null;
 if(values.observedWalletBalance){
  const response=await treasury.requestObservationInSession(conn,session,authorization,wallet._id,{kind:'checkpoint',actualBalance:values.observedWalletBalance,observedAt:occurredAt.toISOString(),evidenceType:receivedAt?'provider_sms':'provider_app',
   evidenceReference:values.observationEvidenceReference||values.networkReference,note:'Actual wallet balance reported after the recorded network transaction; independent verification required.',idempotencyKey:require('node:crypto').createHash('sha256').update('wallet-observation:'+values.idempotencyKey).digest('hex').slice(0,8)+'-'+values.idempotencyKey.slice(9)});
  observation=response.observation;
 }
 return {walletAccountId:wallet._id,paymentAccountId:payment?._id||null,customerAccountId:customer?._id||null,feeTreatment,fundingState:'book_recorded',fundsSourceRef:`MM:${values.idempotencyKey}`,
  walletBalanceBeforeMinor:String(wallet.bookBalanceMinor),walletBalanceAfterMinor:String(BigInt(String(wallet.bookBalanceMinor))+walletDelta),walletObservationId:observation?._id||null,
  physicalCashMovementMinor:values.paymentMethod==='Cash'?String(paymentDelta):'0',fundJournalIds:applied.journalIds||[]};
}
module.exports={context,summary,shouldTrack,apply,selectFund};
