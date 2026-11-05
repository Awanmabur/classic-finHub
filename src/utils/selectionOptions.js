'use strict';
// Explicit selectable values, shared by views and server-side validation.
// The country list is ISO 3166-1 alpha-2; display labels are not persisted.
const countries = Object.freeze(require('../data/countries.json').map(c=>Object.freeze(c)));
const countryCodes = new Set(countries.map(c=>c.code));
const publicModules = Object.freeze(require('../data/store').modules
  .filter(m=>m.runtimeStatus!=='disabled')
  .map(m=>Object.freeze({key:m.key,name:m.name})));
const publicModuleKeys = new Set(publicModules.map(m=>m.key));
// Cached pre-upgrade forms may submit a known bundle label; map those to the
// same individual selections rather than rejecting otherwise valid requests.
const legacyBundles = Object.freeze({
  'Money Transfer + Mobile Money':['money_transfer','mobile_money'],
  'Banking + Forex':['banking','forex'],
  'All four core modules':['money_transfer','mobile_money','banking','forex'],
  'All core modules':['money_transfer','mobile_money','banking','forex'],
  'Enterprise plan with addons':publicModules.map(m=>m.key),
  'Enterprise with addons':publicModules.map(m=>m.key),
  'Not sure yet':[]
});
function countryOptions(){return countries;}
function isCountryCode(code){return typeof code==='string'&&countryCodes.has(code.toUpperCase());}
function bankInstitutionOptions(references){
  if(!Array.isArray(references)) return [];
  const institutions=new Set();
  for(const ref of references){
    if(typeof ref?.institutionName==='string' && ref.institutionName.trim())institutions.add(ref.institutionName.trim());
  }
  return [...institutions].sort((a,b)=>a.localeCompare(b,'en'));
}
function resolveBankInstitution(body, availableNames){
  const choice=body?.institutionChoice;
  if(choice===undefined) return body; // safe compatibility with existing API clients
  if(typeof choice!=='string')throw Object.assign(new Error('Invalid institution selection'),{status:400});
  if(choice==='__new__')return {...body,institutionName:body?.institutionName};
  if(!availableNames.includes(choice))throw Object.assign(new Error('Select a registered institution in your branch'),{status:400});
  return {...body,institutionName:choice};
}
function publicModuleOptions(){return publicModules;}
function parsePublicModuleSelection(value){
  if(value===undefined||value===null||value==='') return [];
  if(typeof value==='string'&&Object.hasOwn(legacyBundles,value))return [...legacyBundles[value]];
  const items=Array.isArray(value)?value:[value];
  if(items.length>publicModules.length)throw new Error('Select at most one of each listed module');
  const keys=[];
  for(const item of items){
    if(typeof item!=='string'||!publicModuleKeys.has(item))throw new Error('Choose modules from the available list');
    if(keys.includes(item))throw new Error('Duplicate module selection');
    keys.push(item);
  }
  return keys;
}
module.exports={countryOptions,isCountryCode,bankInstitutionOptions,resolveBankInstitution,publicModuleOptions,parsePublicModuleSelection};
