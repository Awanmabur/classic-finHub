const { modules } = require('../data/store');

const coreModuleKeys = ['money_transfer', 'mobile_money', 'banking', 'forex'];
const supportingModuleKeys = ['notifications', 'analytics', 'approval_workflows', 'customer_portal'];

function getModuleRegistry() {
  return modules;
}

function getModuleByKey(key) {
  return modules.find((module) => module.key === key);
}

function moduleMenuItems(enabledModules = [], permissions = []) {
  const all = modules
    .filter((module) => enabledModules.includes(module.key))
    .filter((module) => permissions.includes('*') || module.permissions.some((p) => permissions.includes(p)))
    .map((module) => ({
      label: module.name,
      href: `/tenant/${module.key.replace('_', '-')}`,
      icon: module.icon,
      permission: module.permissions[0]
    }));
  return all;
}

module.exports = { coreModuleKeys, supportingModuleKeys, getModuleRegistry, getModuleByKey, moduleMenuItems };
