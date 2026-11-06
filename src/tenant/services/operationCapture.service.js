'use strict';
// Optional approved form fields are immutable instructions, never proof of
// identity verification, fees collected, payment execution or an FX trade.
const mongoose=require('mongoose');
function fail(message){return Object.assign(new Error(message),{status:400});}
function field(value,label,max=120){
 if(value===undefined||value===null)return '';
 if(typeof value!=='string'||value.trim().length>max||/[<>\u0000-\u001f\u007f]/.test(value))throw fail(`Invalid ${label}`);
 return value.trim();
}
function phone(value){const result=field(value,'customer phone',16);if(result&&!/^\+[1-9]\d{7,14}$/.test(result))throw fail('Use an international customer phone beginning with +');return result;}
function choice(value,choices,fallback,label){const result=value===undefined||value===''?fallback:field(value,label,40);if(!choices.includes(result))throw fail(`Invalid ${label}`);return result;}
function decimal(value,label,{empty=false}={}){
 const result=field(value,label,24);if(!result)return empty?'':'0';
 if(!/^(?:0|[1-9]\d{0,8})(?:\.\d{1,8})?$/.test(result))throw fail(`Invalid ${label}`);
 const [whole,fraction='']=result.split('.');const trimmed=fraction.replace(/0+$/,'');return whole+(trimmed?'.'+trimmed:'');
}
function parse(key,input={}){
 if(key==='money_transfer')return {senderDocument:field(input.senderDocument,'sender document',80),receiverDocument:field(input.receiverDocument,'receiver document',80),
  method:choice(input.transferMethod,['Cash','Bank','Mobile Money','Online'],'Cash','transfer method'),purpose:field(input.purpose,'purpose / narration',400),exchangeRate:decimal(input.exchangeRate,'indicative exchange rate',{empty:true})};
 if(key==='banking')return {paymentChannel:choice(input.paymentChannel,['Cash','Internal transfer','Bank settlement','Mobile money'],'Cash','payment channel'),customerPhone:phone(input.customerPhone),externalReference:field(input.externalReference,'external reference')};
 if(key==='forex')return {customerPhone:phone(input.customerPhone),identityDocument:field(input.identityDocument,'ID / Passport No.',80),commission:decimal(input.commission,'commission / fee'),
  settlementMethod:choice(input.settlementMethod,['Cash','Bank settlement','Mobile money','Wallet balance'],'Cash','settlement method'),rateSource:field(input.rateSource,'rate source'),externalReference:field(input.externalReference,'external reference')};
 throw fail('Unknown operation fields');
}
function equivalent(key,stored,input){
 const defaults=parse(key,{}),old=stored||{};
 return Object.keys(defaults).every(name=>(old[name]??defaults[name])===(input?.[name]??defaults[name]));
}
function commissionMinor(capture,currency){
 const scale=require('../../config/currencies').forexCurrencies[currency];
 if(scale===undefined)throw fail('Unsupported commission currency');
 const [whole,part='']=String(capture.commission||'0').split('.');
 if(part.length>scale)throw fail('Commission precision exceeds the settlement currency');
 return BigInt(whole)*10n**BigInt(scale)+BigInt(part.padEnd(scale,'0')||'0');
}
const text=(max=120)=>({type:String,default:'',maxlength:max,immutable:true});
const definitions={
 money_transfer:{senderDocument:text(80),receiverDocument:text(80),method:{type:String,enum:['Cash','Bank','Mobile Money','Online'],default:'Cash',immutable:true},purpose:text(400),exchangeRate:text(24)},
 banking:{paymentChannel:{type:String,enum:['Cash','Internal transfer','Bank settlement','Mobile money'],default:'Cash',immutable:true},customerPhone:text(16),externalReference:text()},
 forex:{customerPhone:text(16),identityDocument:text(80),commission:{type:String,default:'0',maxlength:24,immutable:true},settlementMethod:{type:String,enum:['Cash','Bank settlement','Mobile money','Wallet balance'],default:'Cash',immutable:true},rateSource:text(),externalReference:text()}
};
function schema(key){return new mongoose.Schema(definitions[key],{_id:false,strict:'throw'});}
module.exports={parse,equivalent,commissionMinor,schema};
