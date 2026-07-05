const { plans } = require('../../data/store');
function listPlans() { return plans; }
function findPlan(code) { return plans.find(plan => plan.code === code); }
module.exports = { listPlans, findPlan };
