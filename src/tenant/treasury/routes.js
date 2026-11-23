'use strict';

const { Router } = require('express');
const { randomUUID } = require('node:crypto');
const requirePermission = require('../../middleware/requirePermission');
const throttle = require('../../platform/services/actionThrottle.service').financial;
const { flash } = require('../../utils/view');
const treasury = require('./service');
const funding = require('./funding.service');
const branchView = require('../services/branchView.service');
const { hasModuleForUser } = require('../services/moduleAccess.service');
const { tenantUserModel } = require('../models');

const treasuryUrl = '/tenant/treasury';
const accountUrl = id => `${treasuryUrl}/accounts/${id}`;
const moneyKinds = ['cash', 'bank', 'wallet'];

function usableForFunding(account, actor) {
  return moneyKinds.includes(account.kind) && account.status === 'active' &&
    account.openingBalanceMinor !== null && account.openingApprovedAt && account.reconciliationState === 'matched' &&
    (!account.operatorId || String(account.operatorId) === actor.id || actor.role === 'Tenant Owner');
}

function eligibleSource(source, destination, actor) {
  return usableForFunding(source, actor) && BigInt(String(source.bookBalanceMinor)) > 0n &&
    String(source._id) !== String(destination._id) && source.currency === destination.currency &&
    (!source.operatorId || !destination.operatorId || String(source.operatorId) === String(destination.operatorId));
}

function canReviewFunding(row, actor) {
  return row.status === 'pending_review' && String(row.requestedBy) !== actor.id && String(row.operatingActorId) !== actor.id;
}

function canReviewBalance(row, account, actor) {
  return row.status === 'pending_review' && String(row.requestedBy) !== actor.id && String(account.operatorId) !== actor.id;
}

function accountStatus(account) {
  if (account.status === 'archived') return 'Archived';
  if (account.pendingOpeningId) return 'Opening awaiting review';
  if (account.pendingObservation) return 'Check awaiting review';
  if (account.openingBalanceMinor === null) return 'Needs opening balance';
  if (account.reconciliationState === 'mismatch') return 'Balance difference';
  if (account.reconciliationState === 'stale') return 'Needs new balance check';
  if (account.status === 'held') return 'On hold';
  return 'Ready';
}

module.exports = function treasuryRoutes({ renderTenant }) {
  const router = Router();
  const wrap = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  router.use(requirePermission('treasury.view'));
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    next();
  });

  function permissions(req) {
    const can = permission => req.user.permissions.includes('*') || req.user.permissions.includes(permission);
    return { canManage: can('treasury.manage'), canObserve: can('treasury.observe'), canReview: can('treasury.review') };
  }

  async function renderList(req, res, mode) {
    const { canManage, canObserve, canReview } = permissions(req);
    const allBranches = req.viewBranchId === 'all';
    const reviewing = mode === 'review';
    const history = mode === 'history';
    const setupBranch = branchView.canViewBranches(req.user) ? req.viewBranch : req.operationBranch;
    const canCreateAccount = canManage && Boolean(setupBranch);
    const operatorScope = setupBranch ? [{ branchId: String(setupBranch._id) }] : [];
    if (setupBranch && String(req.operationBranch?._id || '') === String(setupBranch._id)) operatorScope.push({ _id: req.user.id });

    const [snapshot, queue, operators, fundings] = await Promise.all([
      treasury.balanceSnapshot(req.tenantDb, req.tenant, req.user, {
        branchId: allBranches || !setupBranch ? null : String(setupBranch._id),
        currency: req.query.currency || null
      }),
      reviewing ? treasury.reviewQueue(req.tenantDb, req.tenant, req.user) : { observations: [], adjustments: [] },
      canCreateAccount ? tenantUserModel(req.tenantDb).find({ status: 'active', $or: operatorScope }).select('name role branchId').sort({ name: 1 }).limit(300).lean() : [],
      reviewing || history ? funding.list(req.tenantDb, req.tenant, req.user, reviewing ? { status: 'pending_review' } : {}) : []
    ]);
    const kinds = treasury.KINDS.filter(kind => {
      const module = treasury.moduleForKind(kind);
      return module === 'shared' || hasModuleForUser(req.tenant, req.user, module);
    });
    const isFundingAccount = account => usableForFunding(account, req.user);
    const fundingAccounts = canObserve ? snapshot.accounts.filter(isFundingAccount) : [];
    const pendingFunding = canReview ? fundings.filter(row => canReviewFunding(row, req.user)) : [];
    renderTenant(req, res, 'treasury/index', 'Business funds', 'Manage business money by account.', {
      accounts: snapshot.accounts, queue, operators, setupBranch, allBranches, canCreateAccount,
      branchNames: Object.fromEntries((res.locals.viewBranches || []).map(branch => [String(branch._id), branch.name])),
      canManage, canObserve, canReview, accountStatus, usableForFunding: isFundingAccount, kinds, mode,
      pendingFunding, fundings: history ? fundings : [], fundingAccounts,
      fundingDestination: String(req.query.to || ''), networks: treasury.NETWORKS, format: treasury.format,
      accountCode: 'ACC_' + randomUUID().replaceAll('-', '').toUpperCase(), fundingIdempotencyKey: randomUUID()
    });
  }

  router.get('/', wrap((req, res) => renderList(req, res, req.query.view === 'history' ? 'history' : 'accounts')));
  router.get('/accounts/new', requirePermission('treasury.manage'), wrap((req, res) => renderList(req, res, 'create')));
  router.get('/review', requirePermission('treasury.review'), wrap((req, res) => renderList(req, res, 'review')));
  router.post('/accounts', requirePermission('treasury.manage'), throttle, wrap(async (req, res) => {
    if (branchView.canViewBranches(req.user) && !req.viewBranch) throw treasury.fail('Choose a branch before adding an account', 409);
    const account = await treasury.createAccount(req.tenantDb, req.tenant, req.user, req.body, {
      configurationBranchId: req.viewBranch ? String(req.viewBranch._id) : null
    });
    flash(req, 'good', 'Account created. Record its opening balance to get started.');
    branchView.followRecord(req, account);
    res.redirect(303, accountUrl(account._id));
  }));

  router.post('/funding', requirePermission('treasury.observe'), throttle, wrap(async (req, res) => {
    const result = await funding.request(req.tenantDb, req.tenant, req.user, req.body);
    const contribution = result.funding.sourceKind === 'owner_contribution';
    flash(req, 'good', result.duplicate ? 'This request already exists.' :
      contribution ? 'Money added to the review queue. The balance updates after approval.' :
      'Transfer sent for review. Both balances update after approval.');
    branchView.followRecord(req, result.funding);
    res.redirect(303, req.body.returnToAccount === 'true' ?
      accountUrl(result.funding.destinationAccountId) : `${treasuryUrl}?view=history#funding-history`);
  }));

  router.post('/funding/:id/review', requirePermission('treasury.review'), throttle, wrap(async (req, res) => {
    const result = await funding.review(req.tenantDb, req.tenant, req.user, req.params.id, req.body);
    flash(req, 'good', result.funding.status === 'posted' ? 'Money recorded. The balance is up to date.' : 'Request rejected.');
    branchView.followRecord(req, result.funding);
    const accountIds = [result.funding.destinationAccountId, result.funding.sourceAccountId].filter(Boolean).map(String);
    const returnAccount = req.body.returnToAccount === 'true' ? accountIds[0] : accountIds.find(id => id === req.body.returnToAccount);
    res.redirect(303, returnAccount ? accountUrl(returnAccount) : `${treasuryUrl}/review#money-review`);
  }));

  router.get('/accounts/:id', wrap(async (req, res) => {
    const detail = await treasury.accountDetail(req.tenantDb, req.tenant, req.user, req.params.id);
    const { account } = detail;
    const { canManage, canObserve, canReview } = permissions(req);
    const canFund = canObserve && usableForFunding(account, req.user);
    const filter = { branchId: String(account.branchId), currency: account.currency };
    const [fundings, sources] = await Promise.all([
      funding.list(req.tenantDb, req.tenant, req.user, { accountId: account._id }),
      canFund ? treasury.findOperatingAccounts(req.tenantDb, req.tenant, req.user, filter) : []
    ]);

    const pendingObservations = detail.observations.filter(row => row.status === 'pending_review');
    const pendingAdjustments = detail.adjustments.filter(row => row.status === 'pending_review');
    const pendingFunding = fundings.filter(row => row.status === 'pending_review');
    const nextAdjustment = !account.lastObservationStale && detail.observations.find(row =>
      String(row._id) === String(account.lastObservationId) && row.kind === 'checkpoint' && row.status === 'approved' &&
      String(row.varianceMinorAtReview || 0) !== '0' && !detail.adjustments.some(adjustment => String(adjustment.observationId) === String(row._id)));
    const canAdjust = canObserve && account.status !== 'archived' && Boolean(nextAdjustment);

    renderTenant(req, res, 'treasury/detail', account.name, '', {
      ...detail, canManage, canObserve, canReview, canFund, canAdjust, nextAdjustment, fundings,
      pendingObservations, pendingAdjustments, pendingFunding,
      canReviewBalance: row => canReview && account.status !== 'archived' && canReviewBalance(row, account, req.user),
      canReviewFunding: row => canReview && canReviewFunding(row, req.user),
      fundingAccounts: canFund ? sources.filter(source => eligibleSource(source, account, req.user)) : [],
      action: req.query.action,
      status: accountStatus({ ...account, pendingObservation: pendingObservations[0] }),
      idempotencyKey: randomUUID(), fundingIdempotencyKey: randomUUID(), contributionIdempotencyKey: randomUUID()
    });
  }));

  router.post('/accounts/:id/settings', requirePermission('treasury.manage'), throttle, wrap(async (req, res) => {
    const account = await treasury.configureAccount(req.tenantDb, req.tenant, req.user, req.params.id, req.body);
    flash(req, 'good', 'Account details saved.');
    branchView.followRecord(req, account);
    res.redirect(303, accountUrl(account._id));
  }));

  router.post('/accounts/:id/observations', requirePermission('treasury.observe'), throttle, wrap(async (req, res) => {
    const input = { ...req.body };
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(input.observedAt || '')) input.observedAt += 'Z';
    const result = await treasury.requestObservation(req.tenantDb, req.tenant, req.user, req.params.id, input);
    flash(req, 'good', 'Balance check sent for review.');
    branchView.followRecord(req, result.observation);
    res.redirect(303, accountUrl(req.params.id));
  }));

  router.post('/observations/:id/review', requirePermission('treasury.review'), throttle, wrap(async (req, res) => {
    const observation = await treasury.reviewObservation(req.tenantDb, req.tenant, req.user, req.params.id, req.body);
    flash(req, 'good', observation.status === 'approved' ? 'Balance check approved.' : 'Balance check rejected.');
    branchView.followRecord(req, observation);
    res.redirect(303, accountUrl(observation.accountId));
  }));

  router.post('/observations/:id/adjustments', requirePermission('treasury.observe'), throttle, wrap(async (req, res) => {
    const result = await treasury.requestAdjustment(req.tenantDb, req.tenant, req.user, req.params.id, req.body);
    flash(req, 'good', 'Balance correction sent for review.');
    branchView.followRecord(req, result.adjustment);
    res.redirect(303, accountUrl(result.adjustment.accountId));
  }));

  router.post('/adjustments/:id/review', requirePermission('treasury.review'), throttle, wrap(async (req, res) => {
    const result = await treasury.reviewAdjustment(req.tenantDb, req.tenant, req.user, req.params.id, req.body);
    flash(req, 'good', result.status === 'approved' ? 'Balance correction posted.' : 'Balance correction rejected.');
    branchView.followRecord(req, result);
    res.redirect(303, accountUrl(result.accountId));
  }));

  return router;
};
