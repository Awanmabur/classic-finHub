'use strict';
// ISO codes are persisted. KSH is the approved interface label for Kenyan
// shillings; it is never a second currency or an implicit conversion.
const currencies=Object.freeze({UGX:0,USD:2,SSP:2,KES:2});
const currencyCodes=Object.freeze(Object.keys(currencies));
const forexCurrencies=Object.freeze({...currencies,EUR:2});
const forexCurrencyCodes=Object.freeze(Object.keys(forexCurrencies));
function currencyLabel(code){return code==='KES'?'KSH':String(code||'');}
const currencyOptions=Object.freeze(currencyCodes.map(code=>Object.freeze({code,label:currencyLabel(code),scale:currencies[code]})));
module.exports={currencies,currencyCodes,forexCurrencies,forexCurrencyCodes,currencyOptions,currencyLabel};
