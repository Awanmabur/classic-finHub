'use strict';
// Use only real, approved provider wallets when deciding the Mobile Money
// default. Never infer agent balances or make up a currency from branch settings.
const {NETWORKS}=require('../pricing/networkTariffs');
function eligibleWallet(wallet){
 return wallet&&wallet.state==='active'&&wallet.reconciliation==='matched'&&
  wallet.expectedMinor!==null&&wallet.expectedMinor!==undefined;
}
function markets(wallets=[]){
 const seen=new Map();
 for(const wallet of wallets){
  if(!eligibleWallet(wallet)||!NETWORKS[wallet.network])continue;
  if(NETWORKS[wallet.network].currency&&NETWORKS[wallet.network].currency!==wallet.currency)continue;
  const key=wallet.network+':'+wallet.currency;
  if(!seen.has(key))seen.set(key,{network:wallet.network,currency:wallet.currency,
   label:NETWORKS[wallet.network].displayName||wallet.network});
 }
 return [...seen.values()].sort((a,b)=>(a.network==='MTN'?-1:0)-(b.network==='MTN'?-1:0)||
  a.network.localeCompare(b.network)||a.currency.localeCompare(b.currency));
}
function preferred(wallets=[]){return markets(wallets)[0]||null;}
function withDefaultFilters(input={},wallets=[]){
 const choices=markets(wallets),preferredMarket=choices[0];
 const result={...input};
 if(!preferredMarket)return result;
 const networkProvided=Object.hasOwn(result,'network');
 if(!networkProvided)result.network=preferredMarket.network;
 if(!Object.hasOwn(result,'currency')){
  const matching=choices.find(m=>m.network===result.network);
  result.currency=matching?.currency||'';
 }
 return result;
}
module.exports={eligibleWallet,markets,preferred,withDefaultFilters};
