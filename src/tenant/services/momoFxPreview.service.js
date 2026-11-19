'use strict';
// Server-authoritative, READ-ONLY preview. No provider execution, cash movement
// or settlement is inferred from a screen quote.
const {forexRateModel}=require('../models');
const {models}=require('../treasury/models');
const {hasModuleForUser,hasPermission}=require('./moduleAccess.service');
const {quote}=require('./momoFxQuote.service');
const branchCurrency=require('./branchCurrency.service');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=409){return Object.assign(new Error(message),{status});}
async function preview(conn,tenant,actor,branch,input){
 if(!branch||branch.status!=='active')throw fail('Select an active operating branch');
 if(!hasModuleForUser(tenant,actor,'mobile_money')||
    !hasPermission(actor,'mobile_money.view')||
    !hasPermission(actor,'treasury.view'))throw fail('Mobile Money and Treasury access are required',403);
 if(actor.role!=='Tenant Owner'&&String(actor.branchId)!==String(branch._id))throw fail('Cannot access another branch',403);
 const walletId=String(input.walletAccountId||''),cashId=String(input.cashAccountId||'');
 if(!OID.test(walletId)||!OID.test(cashId)||walletId===cashId)throw fail('Choose the actual provider wallet and cash drawer',400);
 const operation=String(input.operation||'');
 if(!['withdraw_provider_receive_cash','deposit_cash_send_provider'].includes(operation))throw fail('Choose an exchange direction',400);
 const account=models(conn).account;
 const pair=await account.find({_id:{$in:[walletId,cashId]},tenantId:tenant._id,branchId:branch._id,
  status:'active',reconciliationState:'matched',openingApprovedAt:{$ne:null}}).lean();
 const wallet=pair.find(row=>String(row._id)===walletId&&row.kind==='wallet');
 const cash=pair.find(row=>String(row._id)===cashId&&row.kind==='cash');
 if(!wallet||!cash)throw fail('The selected wallet and drawer must have independently approved, reconciled opening balances');
 if(wallet.currency===cash.currency)throw fail('Select accounts with different native currencies');
 if(!branchCurrency.supports(branch,wallet.currency)||!branchCurrency.supports(branch,cash.currency))throw fail('Currency disabled in this branch');
 for(const row of [wallet,cash])if(row.operatorId&&String(row.operatorId)!==String(actor.id))throw fail('Account belongs to another cashier',403);
 const side=operation==='withdraw_provider_receive_cash'?'buy':'sell';
 const rate=await forexRateModel(conn).findOne({branchId:branch._id,fromCurrency:wallet.currency,
  toCurrency:cash.currency,side,status:'active',reviewedBy:{$ne:null},expiresAt:{$gt:new Date()}}).lean();
 if(!rate)throw fail('No active Buy/Sell rate for this currency direction. Ask the authorized owner to set the rate');
 const value=quote({operation,providerCurrency:wallet.currency,cashCurrency:cash.currency,
  providerAmountMinor:input.providerAmountMinor!==undefined?String(input.providerAmountMinor):String(require('../treasury/service').major(String(input.providerAmount||''),wallet.currency)),rateDecimal:rate.rateDecimal,
  rateSide:rate.side,rateId:String(rate._id),rateVersion:rate.revision,approved:true,
  expiresAt:new Date(rate.expiresAt).toISOString()});
 // Cashier sees approved-sheet amounts without treating expected commission
 // or the customer's network charge as an extra agent fee or realized income.
 const estimates=await require('../pricing/networkTariffService').transactionEstimates(
  conn,tenant,branch,{network:wallet.network,currency:wallet.currency,
   operation:operation==='withdraw_provider_receive_cash'?'cash_out':'cash_in',
   amountMinor:value.providerAmountMinor,at:new Date()});
 return {...value,expectedCommissionMinor:estimates.agentCommissionEstimate?.amountMinor??null,
  customerNetworkChargeMinor:estimates.customerNetworkFeeEstimate?.amountMinor??null,
  branchId:String(branch._id),walletAccountId:walletId,cashAccountId:cashId,
  network:wallet.network,walletName:wallet.name,cashName:cash.name,rateExpiresAt:rate.expiresAt,
  financialPosting:process.env.CLASSICFIN_MOMO_FX_POSTING_ENABLED==='true'?'manual_book_recording':'disabled',providerVerification:'required'};
}
module.exports={preview};
