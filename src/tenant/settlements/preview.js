'use strict';
// Server-side quote preview only. No wallet, cash or transfer changes.
// The same physical cash book is reused across all modules by branch,
// assigned cashier and native currency. Never manufacture a Forex drawer.
const {hasModule,hasModuleForUser,hasPermission}=require('../services/moduleAccess.service');
const {models}=require('../treasury/models');
const {branchModel}=require('../models');
const branchCurrency=require('../services/branchCurrency.service');
const {tenantDbNameFromSlug}=require('../../config/tenantDatabaseName');
const rates=require('./rateBook');
const planner=require('./planner');
const format=require('../services/mobileMoney.service').formatMoneyMinor;
function assertTenant(conn,tenant){
 if(!tenant?.slug||!tenant._id||tenant.dbName!==conn?.name||tenantDbNameFromSlug(tenant.slug)!==conn.name)
  throw planner.fail('Cross-currency quote requires the authenticated tenant database',403);
}
function requireAccess(conn,tenant,actor,moduleKey,permission){
 assertTenant(conn,tenant);
 if(!actor?.id||!hasModuleForUser(tenant,actor,moduleKey)||!hasPermission(actor,permission)||!hasModule(tenant,'forex'))
  throw planner.fail('The operating module and approved Forex pricing are required',403);
}
function activeAccount(account,tenant,branch,currency,kind){
 if(!account||String(account.tenantId)!==String(tenant._id)||String(account.branchId)!==String(branch._id)||
    account.kind!==kind||account.currency!==currency||account.status!=='active'||
    !account.openingApprovedAt||account.openingBalanceMinor===null||account.reconciliationState!=='matched')
  throw planner.fail('The actual '+kind+' account needs an approved opening and reconciliation',409);
 return account;
}
async function ownDrawer(conn,tenant,actor,branch,currency,accountId=null,session=null){
 planner.currency(currency);
 branchCurrency.resolve(branch,currency);
 const query={tenantId:tenant._id,branchId:branch._id,kind:'cash',
  moduleKey:'shared',currency,operatorId:planner.objectId(actor.id,'cashier account'),
  status:'active',reconciliationState:'matched',openingApprovedAt:{$ne:null},
  openingBalanceMinor:{$ne:null}};
 if(accountId)query._id=planner.objectId(accountId,'cash drawer');
 const candidates=await models(conn).account.find(query).limit(2).session(session).lean();
 if(candidates.length!==1)throw planner.fail(candidates.length?
  'Several cash drawers match. Select your actual existing drawer, not a new Forex drawer.':
  'No approved cash drawer for this cashier and currency. Configure the actual shared Treasury drawer.',409);
 return activeAccount(candidates[0],tenant,branch,currency,'cash');
}
async function wallet(conn,tenant,actor,branch,accountId,session=null){
 const account=await models(conn).account.findOne({
  _id:planner.objectId(accountId,'provider wallet'),tenantId:tenant._id,
  branchId:branch._id,kind:'wallet',moduleKey:'mobile_money',
  status:'active',reconciliationState:'matched',openingApprovedAt:{$ne:null},
  openingBalanceMinor:{$ne:null},
  $or:[{operatorId:planner.objectId(actor.id,'cashier account')},{operatorId:null}]
 }).session(session).lean();
 if(!account)throw planner.fail('Choose an approved provider wallet assigned to your branch',409);
 branchCurrency.resolve(branch,account.currency);
 return activeAccount(account,tenant,branch,account.currency,'wallet');
}
async function mobileMoney(conn,tenant,actor,branch,input={},session=null){
 requireAccess(conn,tenant,actor,'mobile_money','mobile_money.view');
 if(!branch||String(branch._id)!==String(actor?.transactionBranchId||actor?.branchId))
  throw planner.fail('Use your actual operating branch, not a selected reporting branch',403);
 if(!['cash_in','cash_out'].includes(input.operation)||
  !hasPermission(actor,'mobile_money.'+input.operation))
  throw planner.fail('You cannot record this Mobile Money operation',403);
 const float=await wallet(conn,tenant,actor,branch,input.walletAccountId,session);
 const cash=await ownDrawer(conn,tenant,actor,branch,input.cashCurrency,input.cashAccountId||null,session);
 if(cash.currency===float.currency)throw planner.fail('Use normal Mobile Money for a same-currency cash transaction',400);
 const quote=await rates.quoteMoMo(conn,session,{
  tenant,rateId:input.rateId,channel:'mobile_money',operation:input.operation,
  branchId:String(branch._id),providerCurrency:float.currency,cashCurrency:cash.currency,
  providerPrincipalMinor:input.providerPrincipalMinor,
  walletAccountId:String(float._id),cashAccountId:String(cash._id)
 });
 return {quote,display:{
  channel:'mobile_money',operation:quote.operation,
  providerNetwork:float.network,providerCurrency:float.currency,
  providerAmount:format(quote.providerPrincipalMinor,float.currency),
  physicalCashCurrency:cash.currency,physicalCashAmount:format(quote.actualCashMinor,cash.currency),
  walletChange:format(quote.custodyLegs[0].deltaMinor,float.currency),
  drawerChange:format(quote.custodyLegs[1].deltaMinor,cash.currency),
  exchangeSide:quote.rateSnapshot.side,exchangeRate:quote.rateSnapshot.rateDecimal,
  postingStatus:'quote_only',providerConfirmation:'not_yet_verified',
  note:'Preview only. The same existing physical cash drawer will be used by all modules; no provider transaction or cash movement has been posted.'
 }};
}
async function transfer(conn,tenant,actor,branch,input={},session=null){
 requireAccess(conn,tenant,actor,'money_transfer','money_transfer.view');
 if(!hasPermission(actor,'money_transfer.create'))throw planner.fail('Money Transfer creation permission required',403);
 if(!branch||String(branch._id)!==String(actor?.transactionBranchId||actor?.branchId))
  throw planner.fail('Transfer origin must be the actual operating branch',403);
 const origin=await ownDrawer(conn,tenant,actor,branch,input.collectionCurrency,input.originCashAccountId||null,session);
 const destinationId=planner.objectId(input.destinationBranchId,'destination branch');
 const dest=await branchModel(conn).findOne({_id:destinationId,status:'active'}).session(session).lean();
 if(!dest)throw planner.fail('The transfer destination branch is unavailable',409);
 branchCurrency.resolve(dest,input.payoutCurrency);
 const payout=await models(conn).account.findOne({
  _id:planner.objectId(input.destinationPayoutAccountId,'destination payout drawer'),
  tenantId:tenant._id,branchId:dest._id,kind:'cash',moduleKey:'shared',
  currency:input.payoutCurrency
 }).session(session).lean();
 activeAccount(payout,tenant,dest,input.payoutCurrency,'cash');
 const plan=await rates.quoteTransfer(conn,session,{
  tenant,rateId:input.rateId,originBranchId:String(branch._id),
  destinationBranchId:String(dest._id),originCashAccountId:String(origin._id),
  destinationPayoutAccountId:String(payout._id),
  collectionCurrency:origin.currency,payoutCurrency:payout.currency,
  payoutMinor:input.payoutMinor
 });
 return {quote:plan,display:{
  channel:'money_transfer',senderPays:format(plan.collectionCashMinor,origin.currency),
  recipientReceives:format(plan.recipientPayoutMinor,payout.currency),
  exchangeRate:plan.rateSnapshot.rateDecimal,exchangeSide:plan.rateSnapshot.side,
  originBranchId:String(branch._id),destinationBranchId:String(dest._id),
  collectionStatus:'not_posted',payoutStatus:'not_posted',
  note:'A quote, not a transfer. Collection and payout need separately verified events; each uses its existing real cash drawer.'
 }};
}
module.exports={assertTenant,requireAccess,activeAccount,ownDrawer,wallet,mobileMoney,transfer};
