'use strict';
// The launcher needs entry choices, not the module's histories, reports or
// review queues. All mutations still use their original services and fences.
const {randomUUID}=require('node:crypto');
const {hasPermission,hasModuleForUser}=require('./moduleAccess.service');
const {withoutReadView}=require('./branchView.service');
const currency=require('./branchCurrency.service');
const definitions=Object.freeze({
 transfer:{module:'money_transfer',permission:'money_transfer.create',role:['Tenant Owner','Money Transfer Operator'],page:'/tenant/money-transfer/send',action:'/tenant/money-transfer/requests',operation:'',title:'Send money / Generate PIN'},
 cash_in:{module:'mobile_money',permission:'mobile_money.cash_in',role:['Tenant Owner','Mobile Money Operator'],page:'/tenant/mobile-money/cash-in',action:'/tenant/mobile-money/cash-in',operation:'cash_in',title:'Cash-in'},
 cash_out:{module:'mobile_money',permission:'mobile_money.cash_out',role:['Tenant Owner','Mobile Money Operator'],page:'/tenant/mobile-money/cash-out',action:'/tenant/mobile-money/cash-out',operation:'cash_out',title:'Cash-out'},
 banking_deposit:{module:'banking',permission:'banking.requests.create',role:['Tenant Owner','Banking Operator'],page:'/tenant/banking/deposit',action:'/tenant/banking/requests',operation:'deposit_request',title:'Deposit'},
 banking_withdrawal:{module:'banking',permission:'banking.requests.create',role:['Tenant Owner','Banking Operator'],page:'/tenant/banking/withdraw',action:'/tenant/banking/requests',operation:'withdrawal_request',title:'Withdraw'},
 banking_transfer:{module:'banking',permission:'banking.requests.create',role:['Tenant Owner','Banking Operator'],page:'/tenant/banking/transfer',action:'/tenant/banking/requests',operation:'transfer_request',title:'Account transfer'},
 forex_buy:{module:'forex',permission:'forex.quotes.create',role:['Tenant Owner','Forex Operator'],page:'/tenant/forex/buy',action:'/tenant/forex/quotes',operation:'buy',title:'Buy forex from customer'},
 forex_sell:{module:'forex',permission:'forex.quotes.create',role:['Tenant Owner','Forex Operator'],page:'/tenant/forex/sell',action:'/tenant/forex/quotes',operation:'sell',title:'Sell forex to customer'}
});
function definition(kind){const spec=Object.hasOwn(definitions,kind)?definitions[kind]:null;if(!spec)throw Object.assign(Error('This operation does not have a quick entry form.'),{status:404});return spec;}
function authorize(tenant,actor,spec){
 if(!hasModuleForUser(tenant,actor,spec.module)||!hasPermission(actor,spec.permission)||!spec.role.includes(actor.role))throw Object.assign(Error('This operation is unavailable for your account.'),{status:403});
}
async function context(conn,tenant,actor,branch,kind,input={},options={}){
 const spec=definition(kind);authorize(tenant,actor,spec);
 if(!branch)throw Object.assign(Error('An active operating branch is required. Update your account assignment before recording transactions.'),{status:409});
 const selectedCurrency=currency.resolve(branch,input.currency),operatingActor=withoutReadView(actor);
 const data={idempotencyKey:randomUUID(),selectedBranchId:String(branch._id),branches:[branch],currencyChoices:currency.options(branch),selectedCurrency,
  workspaceTitle:spec.title,workspaceOperation:spec.operation,operation:spec.operation,entryCurrency:selectedCurrency,entryCurrencies:currency.options(branch),
  formatMoneyMinor:require('./mobileMoney.service').formatMoneyMinor};
 const pricing=require('../pricing/service').context(conn,tenant,branch);
 let choices;
 if(spec.module==='money_transfer'){
  choices=(async()=>{const branches=options.activeBranches||await require('../models').branchModel(conn).find({status:'active'}).select('_id name code currency currencies status').sort({_id:1}).lean();
   return {destinationBranches:branches.filter(row=>row.status==='active'&&String(row._id)!==String(branch._id))};})();
 }else if(spec.module==='mobile_money'){
  choices=hasPermission(actor,'treasury.view')?require('./mobileMoneyFunds.service').context(conn,tenant,actor,branch).then(funds=>({funds})):Promise.resolve({funds:{wallets:[],paymentAccounts:[],customerAccounts:[]}});
 }else if(spec.module==='banking'){
  choices=(async()=>{const banking=require('./banking.service');const references=await banking.listReferences(conn,tenant,operatingActor,{branchId:String(branch._id)});
   if(hasModuleForUser(tenant,actor,'accounts')&&hasPermission(actor,'accounts.view'))references.push(...await require('../customerAccounts/bankingBridge').choices(conn,tenant,actor,{branchId:String(branch._id)}));
   return {references};})();
 }else{
  const forex=require('./forex.service');choices=forex.listRates(conn,tenant,operatingActor,{status:'active',branchId:String(branch._id)}).then(rates=>({rates:rates.filter(rate=>forex.enabledRate(branch,rate))}));
 }
 const [matchingRules,selection]=await Promise.all([pricing,choices]);
 const pricingContext=matchingRules.filter(rule=>rule.operation.startsWith(spec.module+'.')).map(rule=>Object.fromEntries(['_id','revision','branchId','operation','currency','network','fixedFeeMinor','feeBps','fixedCostMinor','costBps','enabled'].map(key=>[key,rule[key]])));
 return {spec,data:{...data,...selection,pricingContext}};
}
module.exports={definitions,definition,authorize,context};
