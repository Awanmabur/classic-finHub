'use strict';
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');

const eligible = Object.freeze({
  status:{$in:['active','trial']},
  setupStatus:{$ne:'invited'},
  'directoryListing.visibility':{$ne:'hidden'},
  $or:[
    {'directory.publishedAt':{$exists:true,$ne:null}},
    {'directoryListing.visibility':'published'}
  ]
});
const text = (value,limit=120) => typeof value==='string' ? value.trim().slice(0,limit) : '';
const escaped = value => value.replace(/[|\\{}()[\]^$+*?.]/g,'\\$&');
function normalize(input={}) {
  const q=text(input.q,80),country=text(input.country,80),service=text(input.service,80);
  const rawPage=Number(input.page),page=Number.isSafeInteger(rawPage)&&rawPage>0?Math.min(50,rawPage):1;
  const sort=input.sort==='name'?'name':'recent';
  return {q,country,service,page,sort};
}
function publicSnapshot(landing,publishedAt=new Date()) {
  if(!landing||!text(landing.name,150)||!text(landing.headline,200))return null;
  return {name:text(landing.name,150),headline:text(landing.headline,200),
    subtitle:text(landing.subtitle,1000),country:text(landing.country,80),
    services:Array.isArray(landing.services)?[...new Set(landing.services.map(s=>text(s,80)).filter(Boolean))].slice(0,12):[],
    supportPhone:text(landing.supportPhone,40),publishedAt};
}
function card(tenant){
  const d=tenant.directory||{};
  const isPublished=Boolean(d.publishedAt);
  return {slug:String(tenant.slug),name:String(isPublished&&d.name||tenant.name||''),
    headline:isPublished?String(d.headline||''):'',
    subtitle:isPublished?String(d.subtitle||''):'',
    country:isPublished?String(d.country||''):'',
    services:isPublished&&Array.isArray(d.services)?d.services:[],
    supportPhone:isPublished?String(d.supportPhone||''):'',
    publishedAt:isPublished?d.publishedAt:null,isPublished};
}
async function sync(tenant,landing,publishedAt=new Date()){
  const snapshot=publicSnapshot(landing,publishedAt);
  if(!snapshot)throw new Error('A published public landing snapshot is required');
  // A delayed reconciliation must never overwrite a more recent owner publication.
  return Tenant.updateOne({_id:tenant._id,slug:tenant.slug,
    $or:[{'directory.publishedAt':{$exists:false}},{'directory.publishedAt':{$lte:snapshot.publishedAt}}]},
    {$set:{directory:snapshot}},{runValidators:true});
}
function ready(){return mongoose.connection.readyState===1;}
async function featured(limit=10){
  if(!ready())return {businesses:[],unavailable:true};
  const tenants=await Tenant.find(eligible).sort({createdAt:-1,_id:-1})
    .limit(Math.max(1,Math.min(limit,12))).select('slug name directory').maxTimeMS(2500).lean();
  return {businesses:tenants.map(card),unavailable:false};
}
async function search(input){
  if(!ready())return {unavailable:true,businesses:[],total:0,filters:normalize(input),countries:[],services:[]};
  const filters=normalize(input);
  const query={...eligible};
  if(filters.q){
    const rx=new RegExp(escaped(filters.q),'i');
    // Keep the publication/approval gate when a name search is added.
    query.$and=[{$or:[{name:rx},{'directory.name':rx},{'directory.headline':rx},
      {'directory.subtitle':rx},{'directory.services':rx}]}];
  }
  if(filters.country)query['directory.country']=filters.country;
  if(filters.service)query['directory.services']=filters.service;
  const sort=filters.sort==='name'?{name:1,_id:1}:{createdAt:-1,_id:-1};
  const [tenants,total,countries,services]=await Promise.all([
    Tenant.find(query).sort(sort).skip((filters.page-1)*12).limit(12)
      .select('slug name directory').maxTimeMS(3000).lean(),
    Tenant.countDocuments(query).maxTimeMS(3000),
    Tenant.distinct('directory.country',{...eligible,'directory.publishedAt':{$ne:null}}),
    Tenant.distinct('directory.services',{...eligible,'directory.publishedAt':{$ne:null}})
  ]);
  return {unavailable:false,businesses:tenants.map(card),total,filters,
    countries:countries.filter(Boolean).sort().slice(0,100),
    services:services.filter(Boolean).sort().slice(0,100),
    pages:Math.max(1,Math.ceil(total/12))};
}
module.exports={normalize,publicSnapshot,sync,featured,search,card,listingFilter:()=>({...eligible})};
