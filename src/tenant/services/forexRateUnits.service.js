'use strict';
// Human-readable rate units are NOT a change to accounting convention.
// Persist rates as "target units per ONE source unit" to preserve all historical
// quotes and immutable posted transactions.
const SCALE=100000000n;
function basis(currency){return ['UGX','SSP','KES'].includes(currency)?1000:1;}
function number(value,label){
 if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,8})?$/.test(value))throw new Error('Enter a positive '+label+' with at most eight decimal places');
 const [a,b='']=value.split('.');
 const scaled=BigInt(a)*SCALE+BigInt(b.padEnd(8,'0'));
 if(scaled<=0n)throw new Error(label+' must be greater than zero');
 return scaled;
}
function decimal(scaled){
 const whole=scaled/SCALE,frac=(scaled%SCALE).toString().padStart(8,'0').replace(/0+$/,'');
 return whole.toString()+(frac?'.'+frac:'');
}
function normalize({quotedRate,rateBaseUnits}){
 const units=Number(rateBaseUnits);
 if(![1,100,1000].includes(units))throw new Error('Select 1, 100 or 1,000 source units');
 const scaled=number(quotedRate,'quoted rate');
 if(scaled%BigInt(units)!==0n)throw new Error('Rate needs more precision: use fewer source units or a more exact quote');
 const perUnit=scaled/BigInt(units);
 if(perUnit<=0n||perUnit>=1000000000n*SCALE)throw new Error('Normalized exchange rate is outside supported limits');
 return decimal(perUnit);
}
function display(rateDecimal,sourceCurrency){
 const units=basis(sourceCurrency);
 return {units,rate:decimal(number(rateDecimal,'stored rate')*BigInt(units)),
  text:units.toLocaleString('en-US')+' '+sourceCurrency};
}
module.exports={basis,normalize,display};
