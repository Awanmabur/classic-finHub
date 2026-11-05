'use strict';
const mongoose=require('mongoose');
const PlanVersion=require('../models/PlanVersion');
const {plans,modules}=require('../../data/store');
const liveModules=new Map(modules.filter(module=>module.runtimeStatus!=='disabled').map(module=>[module.key,module.name]));
function publicShape(plan,persisted=false){
  const keys=plan.modules.filter(key=>liveModules.has(key));
  return {code:plan.code,name:plan.name,description:plan.description,currency:plan.currency,
    priceMonthly:persisted?plan.priceMonthlyMinor/100:plan.priceMonthly,
    priceYearly:persisted?plan.priceYearlyMinor/100:plan.priceYearly,
    trialMonths:plan.trialMonths,modules:keys,moduleLabels:keys.map(key=>liveModules.get(key)),
    limits:{...plan.limits},entryMode:plan.entryMode||'manual',manualPlanCode:plan.manualPlanCode||null,
    ...(persisted?{version:plan.version}:{})};
}
async function publicPlans(){
  // Informational pages remain renderable in the disconnected source-test
  // workflow. A connected deployment must always use its persisted catalogue;
  // missing/hidden plans are never replaced with stale standard prices.
  if(mongoose.connection.readyState!==1)return {plans:plans.map(plan=>publicShape(plan)),persisted:false};
  const latest=await PlanVersion.aggregate([
    {$match:{status:'published'}},{$sort:{code:1,version:-1}},
    {$group:{_id:'$code',plan:{$first:'$$ROOT'}}},{$replaceRoot:{newRoot:'$plan'}},
    {$match:{availableForNewTenants:{$ne:false}}},{$sort:{priceMonthlyMinor:1,code:1}}
  ]).option({maxTimeMS:2500});
  return {plans:latest.map(plan=>publicShape(plan,true)),persisted:true};
}
module.exports={publicPlans,publicShape};
