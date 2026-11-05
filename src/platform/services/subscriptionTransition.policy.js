'use strict';
// The base plan and standalone modules are separate contracts. A base-plan
// transition must preserve modules and workspace capacity still covered by
// independently active subscriptions. These helpers have no database effects.
function modulesLost(previousModules = [], nextModules = [], independentGrants = []) {
  const stillEntitled = new Set([
    ...nextModules,
    ...independentGrants.map(g => g.moduleKey)
  ]);
  return [...new Set(previousModules)].filter(key => !stillEntitled.has(key));
}
function combinedCapacity(planLimits = {}, independentGrants = []) {
  const limits = [planLimits, ...independentGrants.map(g => g.limits)];
  return {
    users: Math.max(0, ...limits.map(l => l?.users || 0)),
    branches: Math.max(0, ...limits.map(l => l?.branches || 0))
  };
}
module.exports = { modulesLost, combinedCapacity };
