'use strict';
const {currencyCodes,currencyOptions}=require('../../config/currencies');
function fail(){return Object.assign(new Error('Choose an enabled operating currency for this branch'),{status:409});}
// Older branches stored only a default currency. They now support the complete
// operating catalogue; an explicit saved list remains authoritative.
function supported(branch){
 if(branch?.currencies===undefined||branch?.currencies===null)return [...currencyCodes];
 if(!Array.isArray(branch.currencies)||!branch.currencies.length||new Set(branch.currencies).size!==branch.currencies.length||branch.currencies.some(code=>!currencyCodes.includes(code)))return [];
 return currencyCodes.filter(code=>branch.currencies.includes(code));
}
function supports(branch,currency){return supported(branch).includes(currency);}
function resolve(branch,inputCurrency){const selected=inputCurrency===undefined||inputCurrency===null||inputCurrency===''?branch?.currency:inputCurrency;if(typeof selected!=='string'||!supports(branch,selected))throw fail();return selected;}
function options(branch){const enabled=supported(branch);return currencyOptions.filter(option=>enabled.includes(option.code));}
module.exports={supported,supports,resolve,options};
