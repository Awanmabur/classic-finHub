'use strict';
const crypto=require('node:crypto');
const OID=/^[a-f0-9]{24}$/i;
function fail(message,status=400){return Object.assign(new Error(message),{status});}
function id(value){if(!OID.test(String(value||'')))throw fail('Invalid record identifier');return String(value).toLowerCase();}
function text(value,label,min=0,max=120){
 if(value==null)value='';if(typeof value!=='string')throw fail(`Enter a valid ${label}`);
 const v=value.normalize('NFKC').trim().replace(/\s+/g,' ');
 if(v.length<min||v.length>max||/[<>\x00-\x1f\x7f]/.test(v))throw fail(`Enter a valid ${label} (${min}–${max} characters)`);return v;
}
function phone(value,required=false){const v=text(value,'phone',required?7:0,40);if(!v)return '';const p=v.replace(/[\s().-]/g,'');if(!/^\+[1-9][0-9]{6,14}$/.test(p))throw fail('Enter a phone with country code, for example +256700123456');return p;}
function reference(value,prefix){const v=text(value,'reference',0,32).toUpperCase();if(v&&!/^[A-Z0-9][A-Z0-9-]{5,31}$/.test(v))throw fail('Use 6–32 letters, digits or hyphens for the reference');return v||`${prefix}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;}
function key(value){if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw fail('Reload the form to obtain a valid creation reference');return value;}
function customer(input={}){
 const name=text(input.name,'full name',2,120),email=text(input.email,'email',0,254).toLowerCase();
 if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw fail('Enter a valid email address');
 const type=text(input.type||'Individual','customer type',1,20);if(!['Individual','Business','Agent'].includes(type))throw fail('Invalid customer type');
 const identityNumber=text(input.identityNumber,'ID / passport number',0,60);if(identityNumber&&!/^[\p{L}\p{N}][\p{L}\p{N} .\/-]{2,59}$/u.test(identityNumber))throw fail('Enter a valid ID / passport number');
 const country=text(input.country,'country',0,80);if(country&&!/^[\p{L}][\p{L} .'-]+$/u.test(country))throw fail('Enter a valid country');
 const nextOfKinName=text(input.nextOfKinName,'next of kin name',0,120),nextOfKinPhone=phone(input.nextOfKinPhone),relationship=text(input.relationship,'relationship',0,60);
 if((nextOfKinPhone||relationship)&&nextOfKinName.length<2)throw fail('Enter the next of kin name with the contact details');
 return {name,normalizedName:name.toLocaleLowerCase('en'),phone:phone(input.phone,true),email,identityNumber,type,nextOfKinName,nextOfKinPhone,relationship,country,city:text(input.city,'city / area',0,100),note:text(input.note,'address / notes',0,500)};
}
function account(input={}){
 for(const field of ['overdraftLimit','openingUGX','openingUSD','openingSSP','openingKES','openingBalance'])if(input[field]!=null&&input[field]!==''&&!/^0(?:\.0{1,2})?$/.test(String(input[field])))throw fail('Opening balances and overdraft facilities require an approved financial workflow and cannot be set here');
 const type=text(input.type||'Current Account','account type',1,30),status=text(input.status||'active','status',1,12),risk=text(input.risk||'Low','KYC risk level',1,6);
 if(!['Current Account','Savings Account','Agent Account','Business Account'].includes(type)||!['active','pending','suspended','closed'].includes(status)||!['Low','Medium','High'].includes(risk))throw fail('Invalid account type, status or KYC risk level');
 return {type,status,risk,officer:text(input.officer,'account officer',0,120),purpose:text(input.purpose,'purpose / source of funds',0,240)};
}
function revision(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw fail('Reload this record before saving');return n;}
function cursor(value){if(!value)return null;if(typeof value!=='string'||value.length>256)throw fail('Invalid directory cursor');try{const v=JSON.parse(Buffer.from(value,'base64url').toString());id(v.id);if(typeof v.at!=='string'||!Number.isFinite(Date.parse(v.at)))throw Error();return {at:new Date(v.at),id:v.id};}catch{throw fail('Invalid directory cursor');}}
function pageFilter(value){const c=cursor(value);return c?{$or:[{createdAt:{$lt:c.at}},{createdAt:c.at,_id:{$lt:c.id}}]}:{};}
function nextCursor(items){const row=items.at(-1);return row?Buffer.from(JSON.stringify({at:new Date(row.createdAt).toISOString(),id:String(row._id)})).toString('base64url'):null;}
module.exports={fail,id,text,phone,reference,key,customer,account,revision,cursor,pageFilter,nextCursor};
