'use strict';
const {plans}=require('../../src/data/store');
const {asPlanVersion,planSnapshot}=require('../../src/platform/services/commercial.service');
function entitledTenant(base={}){
  const plan=plans.find(p=>p.code===(base.plan||'agent'));
  if(!plan)throw new Error('Unknown fixture plan');
  return {...base,status:base.status||'active',plan:plan.code,
    subscription:{...planSnapshot({...asPlanVersion(plan),status:'published'}),status:'granted',source:'manual_admin_grant',
      generation:1,periodStart:new Date('2026-01-01'),periodEnd:new Date('2030-01-01')},
    enabledModules:base.enabledModules||plan.modules.filter(key=>['mobile_money','money_transfer','notifications','banking','forex','analytics','approval_workflows','customer_portal'].includes(key))};
}
module.exports={entitledTenant};
