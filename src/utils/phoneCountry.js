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
function normalize(value,country='SS'){
 if(typeof value!=='string')return value;
 const clean=value.trim().replace(/[ ().-]/g,'');
 if(clean.startsWith('+'))return clean;
 const parsed=parsePhoneNumberFromString(clean,isSupportedCountry(country)?country:'SS');
 return parsed?.isPossible()?parsed.number:clean;
}
module.exports={countryForRequest,defaults,normalize};
