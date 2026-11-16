'use strict';
// All persisted financial timestamps remain absolute UTC instants. Convert only
// business-day boundaries and user-facing labels using the branch's IANA zone.
const DEFAULT_TIME_ZONE='Africa/Kampala';
const CURRENCY_ZONES=Object.freeze({UGX:'Africa/Kampala',SSP:'Africa/Juba',KES:'Africa/Nairobi'});
function validTimeZone(value){
 if(typeof value!=='string'||value.length>64||!/^[A-Za-z0-9_+\/-]+$/.test(value))return false;
 try{new Intl.DateTimeFormat('en-US',{timeZone:value}).format(0);return true;}catch{return false;}
}
function defaultZone(currency){return CURRENCY_ZONES[currency]||DEFAULT_TIME_ZONE;}
function forBranch(branch){
 return validTimeZone(branch?.timeZone)?branch.timeZone:defaultZone(branch?.currency);
}
function parseDay(input){
 if(typeof input!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input))throw new RangeError('Enter a calendar date (YYYY-MM-DD)');
 const date=new Date(input+'T00:00:00.000Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==input)throw new RangeError('Invalid calendar date');
 return date;
}
function addDays(day,count){return new Date(parseDay(day).getTime()+count*86400000).toISOString().slice(0,10);}
function partsAt(value,timeZone){
 const tz=validTimeZone(timeZone)?timeZone:DEFAULT_TIME_ZONE;
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))throw new RangeError('Invalid timestamp');
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
 return Object.fromEntries(parts.filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
}
function localDay(value,timeZone){
 const p=partsAt(value,timeZone);
 return [p.year,p.month,p.day].map((x,i)=>i===0?String(x).padStart(4,'0'):String(x).padStart(2,'0')).join('-');
}
function startOfDay(day,timeZone){
 const tz=validTimeZone(timeZone)?timeZone:DEFAULT_TIME_ZONE;
 const target=parseDay(day).getTime();
 let instant=target;
 for(let i=0;i<4;i++){
  const p=partsAt(instant,tz);
  const wall=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second);
  const diff=target-wall;
  if(diff===0)break;
  instant+=diff;
 }
 return new Date(instant);
}
function dayBounds({from,to}={},timeZone=DEFAULT_TIME_ZONE,maxDays=90,now=new Date()){
 const today=localDay(now,timeZone);
 const first=from||(!to?today:null),last=to||(!from?today:null);
 if(!first||!last)throw new RangeError('Provide both start and end dates');
 const a=parseDay(first),b=parseDay(last);
 const days=(b.getTime()-a.getTime())/86400000;
 if(days<0||days>maxDays)throw new RangeError('Report date range is invalid or too long');
 return {from:first,to:last,$gte:startOfDay(first,timeZone),$lt:startOfDay(addDays(last,1),timeZone)};
}
function format(value,timeZone,withSeconds=false){
 if(value===undefined||value===null||value==='')return 'Unknown date';
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))return 'Unknown date';
 const tz=validTimeZone(timeZone)?timeZone:DEFAULT_TIME_ZONE;
 return new Intl.DateTimeFormat('en-GB',{timeZone:tz,day:'2-digit',month:'short',year:'numeric',
  hour:'2-digit',minute:'2-digit',...(withSeconds?{second:'2-digit'}:{}),hourCycle:'h23'}).format(date);
}
module.exports={DEFAULT_TIME_ZONE,defaultZone,validTimeZone,forBranch,parseDay,addDays,localDay,startOfDay,dayBounds,format};
