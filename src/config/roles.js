// Fixed server-side capabilities: modules restrict roles but cannot grant extra permissions.
const ROLES = Object.freeze({
  'Tenant Owner': Object.freeze(['*']),
  'Branch Manager': Object.freeze(['customers.view','customers.create','customers.manage','accounts.view','expenses.view','expenses.create','expenses.review','expenses.void','mobile_money.report','notifications.view','notifications.send','notifications.logs','dashboard.view','branches.view','users.manage_branch','mobile_money.view','money_transfer.view','money_transfer.review','banking.view','banking.review','forex.view','forex.rate_review','forex.quotes.review','approvals.view','approvals.submit','approvals.decide','reports.view','analytics.view','audit.view']),
  'Money Transfer Operator': Object.freeze(['customers.view','customers.create','expenses.view','expenses.create','expenses.correct','notifications.view','dashboard.view','money_transfer.view','money_transfer.create','money_transfer.contacts']),
  'Forex Operator': Object.freeze(['customers.view','customers.create','expenses.view','expenses.create','expenses.correct','notifications.view','dashboard.view','forex.view','forex.rate_manage','forex.quotes.create']),
  'Banking Operator': Object.freeze(['customers.view','customers.create','accounts.view','accounts.manage','expenses.view','expenses.create','expenses.correct','notifications.view','dashboard.view','banking.view','banking.requests.create','banking.accounts.manage']),
  'Mobile Money Operator': Object.freeze(['customers.view','customers.create','expenses.view','expenses.create','expenses.correct','mobile_money.report','notifications.view','dashboard.view','mobile_money.view','mobile_money.cash_in','mobile_money.cash_out']),
  'Reports Analyst': Object.freeze(['notifications.view','dashboard.view','reports.view','reports.export','analytics.view','analytics.export']),
  'Analytics Analyst': Object.freeze(['notifications.view','dashboard.view','analytics.view','analytics.export']),
  'Approval Requester': Object.freeze(['notifications.view','dashboard.view','approvals.view','approvals.submit']),
  'Approval Officer': Object.freeze(['notifications.view','dashboard.view','approvals.view','approvals.submit','approvals.decide']),
  'Auditor': Object.freeze(['customers.view','customers.export','accounts.view','expenses.view','mobile_money.report','notifications.view','dashboard.view','mobile_money.view','money_transfer.view','banking.view','forex.view','approvals.view','reports.view','reports.export','analytics.view','analytics.export','audit.view']),
  'Reconciliation Officer': Object.freeze(['customers.view','accounts.view','expenses.view','mobile_money.report','expenses.review','expenses.void','notifications.view','dashboard.view','mobile_money.view','mobile_money.review','money_transfer.view','money_transfer.review','banking.view','banking.review','forex.view','forex.rate_review','forex.quotes.review','approvals.view','approvals.submit','approvals.decide','reports.view','reports.export','analytics.view','analytics.export','audit.view']),
  'Viewer': Object.freeze(['notifications.view','dashboard.view','mobile_money.view'])
});
function permissionsFor(role) { return Array.from(ROLES[role] || []); }
const INVITABLE = Object.freeze(['Branch Manager','Money Transfer Operator','Banking Operator','Forex Operator','Mobile Money Operator','Reconciliation Officer','Auditor','Reports Analyst','Analytics Analyst','Approval Requester','Approval Officer','Viewer']);
const BRANCH_INVITABLE = Object.freeze(['Money Transfer Operator','Banking Operator','Forex Operator','Mobile Money Operator','Approval Requester','Viewer']);
const TENANT_MFA_ROLES = Object.freeze(['Tenant Owner','Branch Manager','Reconciliation Officer','Auditor','Reports Analyst','Analytics Analyst','Approval Officer']);
function requiresTenantMfa(role) { return TENANT_MFA_ROLES.includes(role); }
module.exports = { ROLES, INVITABLE, BRANCH_INVITABLE, permissionsFor, requiresTenantMfa, TENANT_MFA_ROLES };
