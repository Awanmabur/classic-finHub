'use strict';
const {getCountryCallingCode,parsePhoneNumberFromString,isSupportedCountry}=require('libphonenumber-js');
function countryForRequest(req,input=process.env){
 const header=input.GEO_COUNTRY_HEADER;
 // The edge must strip client-supplied copies before this opt-in is enabled.
 if(input.GEO_COUNTRY_HEADERS_TRUSTED==='true'&&/^[12]$/.test(input.TRUST_PROXY||'')&&['cf-ipcountry','cloudfront-viewer-country','x-country-code'].includes(header)){
  const value=req.get(header);if(typeof value==='string'&&isSupportedCountry(value.toUpperCase()))return value.toUpperCase();
 }
 return 'SS';
}
function defaults(req,input=process.env){const country=countryForRequest(req,input);return {country,dialCode:'+'+getCountryCallingCode(country)};}
// A Mobile Money customer may be entered with a local number. For this
// specific entry, use the provider wallet's known market, not the server's
// default South Sudan location. Explicit +international numbers are preserved.
function mobileMoneyCountry(network,currency,fallback='SS'){
 const known={'MTN':'UG','MTN SSD':'SS','Airtel':'UG','mGURUSH':'SS','Digi Cash':'SS'};
 const value=known[network]||({UGX:'UG',SSP:'SS',KES:'KE'}[currency]);
 return value&&isSupportedCountry(value)?value:fallback;
}
function normalize(value,country='SS'){
 if(typeof value!=='string')return value;
 const clean=value.trim().replace(/[ ().-]/g,'');
 if(clean.startsWith('+'))return clean;
 const candidate=typeof country==='string'?country.trim().toUpperCase():'SS';
 const region=isSupportedCountry(candidate)?candidate:'SS';
 const parsed=parsePhoneNumberFromString(clean,region);
 return parsed?.isPossible()?parsed.number:clean;
}
module.exports={countryForRequest,defaults,mobileMoneyCountry,normalize};
