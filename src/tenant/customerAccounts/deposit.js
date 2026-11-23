'use strict';

const banking = require('../services/banking.service');
const funded = require('../services/fundedOperations.service');
const cash = require('../services/cashDrawer.service');
const { resolveTransactionBranch } = require('../services/transactionBranch.service');
const { withoutReadView } = require('../services/branchView.service');
const { hasModuleForUser, hasPermission } = require('../services/moduleAccess.service');
const { branchModel, cashSessionModel } = require('../models');
const { models: fundedModels } = require('../funded/models');
const { accountModel } = require('./models');
const { id, key, fail } = require('./validation');

const paymentChannels = { cash: 'Cash', bank: 'Bank settlement', wallet: 'Mobile money' };

async function operatingContext(conn, tenant, actor, session = null) {
  const current = await funded.context(conn, tenant, withoutReadView(actor), 'banking', 'banking.requests.create', session);
  if (!banking.operator(current.actor) || !hasPermission(current.actor, 'treasury.view') ||
      !hasPermission(current.actor, 'accounts.view') || !hasModuleForUser(current.tenant, current.actor, 'accounts')) {
    throw fail('Customer Accounts and Banking deposit access are required', 403);
  }
  const Branch = {
    findOne: query => branchModel(conn).findOne(query).session(session),
    find: query => branchModel(conn).find(query).session(session)
  };
  const branch = await resolveTransactionBranch(conn, current.actor, {}, { Branch });
  return { ...current, branch };
}

async function paymentAccounts(conn, current, currency, session = null) {
  const accounts = await funded.availableAccounts(conn, current.tenant, current.actor, current.branch._id, 'banking', { currency, session });
  const shift = await cashSessionModel(conn).findOne({
    branchId: current.branch._id, operatorId: current.actor.id, currency, status: 'open', openingVerifiedAt: { $ne: null }
  }).select('treasuryAccountId').session(session).lean();
  return accounts.filter(account => Object.hasOwn(paymentChannels, account.kind) &&
    (account.kind !== 'cash' || (shift && (!shift.treasuryAccountId || String(shift.treasuryAccountId) === String(account._id)))));
}

async function options(conn, tenant, actor, account) {
  if (account.status !== 'active' || account.customer?.status !== 'active') return [];
  try {
    const current = await operatingContext(conn, tenant, actor);
    if (String(account.branchId) !== String(current.branch._id)) return [];
    return await paymentAccounts(conn, current, account.currency);
  } catch (error) {
    if ([403, 409].includes(error.status)) return [];
    throw error;
  }
}

async function request(conn, tenant, actor, accountId, input = {}) {
  const customerAccountId = id(accountId);
  const cashAccountId = id(input.cashAccountId);
  const idempotencyKey = key(input.idempotencyKey).toLowerCase();
  await funded.prepareIndexes(conn);
  const session = await conn.startSession();
  const submit = () => session.withTransaction(async () => {
    const current = await operatingContext(conn, tenant, actor, session);
    const account = await accountModel(conn).findOne({ _id: customerAccountId, branchId: current.branch._id }).session(session).lean();
    if (!account) throw fail('Choose a customer account in your operating branch', 404);

    const prior = await fundedModels(conn).execution.findOne({ idempotencyKey }).session(session).lean();
    let paymentChannel;
    if (prior) {
      if (String(prior.createdBy) !== current.actor.id || prior.sourceType !== 'banking' ||
          prior.sourceSnapshot.kind !== 'deposit_request' || prior.sourceSnapshot.customerAccountId !== customerAccountId) {
        throw fail('Deposit reference already used', 409);
      }
      paymentChannel = prior.sourceSnapshot.paymentChannel;
    } else {
      if (account.status !== 'active') throw fail('This customer account must be active to receive a deposit', 409);
      const available = await paymentAccounts(conn, current, account.currency, session);
      const receivedIn = available.find(candidate => String(candidate._id) === cashAccountId);
      if (!receivedIn) throw fail('Choose a verified funds account in this currency. Cash requires an open cash day.', 409);
      if (receivedIn.kind === 'cash') {
        // Serialize with day closing and link a valid legacy unbound shift.
        await cash.bindFundAccount(conn, session, receivedIn, receivedIn.bookBalanceMinor);
      }
      paymentChannel = paymentChannels[receivedIn.kind];
    }

    const { order } = await banking.createRequest(conn, current.tenant, current.actor, {
      kind: 'deposit_request', sourceId: 'account:' + customerAccountId, currency: account.currency,
      amount: input.amount, note: input.note, paymentChannel, idempotencyKey,
      pricingMode: input.pricingMode, pricingPolicy: input.pricingPolicy
    }, { session, directDeposit: true });
    return funded.request(conn, current.tenant, current.actor, 'banking', order._id, {
      cashAccountId, idempotencyKey, evidenceReference: input.evidenceReference, note: input.note
    }, { session });
  });
  try {
    try {
      return await submit();
    } catch (error) {
      if (error.code !== 11000) throw error;
      // A competing request may have committed this exact reference.
      try { return await submit(); }
      catch (retryError) {
        if (retryError.code === 11000) throw fail('Deposit reference already used', 409);
        throw retryError;
      }
    }
  } finally {
    await session.endSession();
  }
}

module.exports = { options, request };
