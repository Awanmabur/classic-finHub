'use strict';
// Teller previews receive only the fee rules for their authorized module and
// operating branch, without administration or audit metadata.
const fields=['_id','revision','branchId','operation','currency','network','fixedFeeMinor','feeBps','fixedCostMinor','costBps','enabled'];
function project(rules,moduleKey){
 return rules.filter(rule=>rule.operation.startsWith(moduleKey+'.')).map(rule=>Object.fromEntries(fields.map(key=>[key,rule[key]])));
}
async function context(conn,tenant,branch,moduleKey){
 if(!branch)return [];
 return project(await require('./service').context(conn,tenant,branch),moduleKey);
}
module.exports={project,context};
