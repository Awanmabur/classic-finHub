'use strict';
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');

const published = Object.freeze({
  status:{$in:['active','trial']},
  setupStatus:{$ne:'invited'},
  'directory.publishedAt':{$exists:true,$ne:null}
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
  return {slug:String(tenant.slug),name:String(d.name||''),headline:String(d.headline||''),
    subtitle:String(d.subtitle||''),country:String(d.country||''),services:Array.isArray(d.services)?d.services:[],
    supportPhone:String(d.supportPhone||''),publishedAt:d.publishedAt};
}
async function sync(tenant,landing,publishedAt=new Date()){
  const snapshot=publicSnapshot(landing,publishedAt);
  if(!snapshot)throw new Error('A published public landing snapshot is required');
  return Tenant.updateOne({_id:tenant._id,slug:tenant.slug},
    {$set:{directory:snapshot}},{runValidators:true});
}
function ready(){return mongoose.connection.readyState===1;}
async function featured(limit=10){
  if(!ready())return {businesses:[],unavailable:true};
  const tenants=await Tenant.find(published).sort({'directory.publishedAt':-1,_id:-1})
    .limit(Math.max(1,Math.min(limit,12))).select('slug directory').maxTimeMS(2500).lean();
  return {businesses:tenants.map(card),unavailable:false};
}
async function search(input){
  if(!ready())return {unavailable:true,businesses:[],total:0,filters:normalize(input),countries:[],services:[]};
  const filters=normalize(input);
  const query={...published};
  if(filters.q){
    const rx=new RegExp(escaped(filters.q),'i');
    query.$or=[{'directory.name':rx},{'directory.headline':rx},
      {'directory.subtitle':rx},{'directory.services':rx}];
  }
  if(filters.country)query['directory.country']=filters.country;
  if(filters.service)query['directory.services']=filters.service;
  const sort=filters.sort==='name'?{'directory.name':1,_id:1}:{'directory.publishedAt':-1,_id:-1};
  const [tenants,total,countries,services]=await Promise.all([
    Tenant.find(query).sort(sort).skip((filters.page-1)*12).limit(12)
      .select('slug directory').maxTimeMS(3000).lean(),
    Tenant.countDocuments(query).maxTimeMS(3000),
    Tenant.distinct('directory.country',published),
    Tenant.distinct('directory.services',published)
  ]);
  return {unavailable:false,businesses:tenants.map(card),total,filters,
    countries:countries.filter(Boolean).sort().slice(0,100),
    services:services.filter(Boolean).sort().slice(0,100),
    pages:Math.max(1,Math.ceil(total/12))};
}
module.exports={normalize,publicSnapshot,sync,featured,search,card};
