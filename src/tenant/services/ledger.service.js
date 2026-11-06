'use strict';
// Accounting foundation only. There is deliberately NO HTTP posting endpoint and NO
// provider settlement here. Financial adapters must independently verify provider
// evidence before a later release is allowed to invoke postJournal.
const crypto = require('node:crypto');
const {currencyCodes}=require('../../config/currencies');
const mongoose = require('mongoose');
const { ledgerAccountModel, ledgerJournalModel, ledgerPostingModel,
  branchModel, tenantUserModel, auditEventModel, financialOperationModel, ensureTenantIndexes } = require('../models');
const { Types } = mongoose;
const SOURCE_TYPES = new Set(['mobile_money', 'money_transfer', 'banking', 'forex', 'treasury']);
const MAX_MINOR = 999999999999999999n;
const OBJECT_ID = /^[a-f\d]{24}$/i;
function error(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function objectId(value, field) {
  if (!OBJECT_ID.test(String(value || ''))) throw error(`Invalid ${field}`);
  return String(value).toLowerCase();
}
function amount(value) {
  const s = String(value ?? '');
  if (!/^[1-9][0-9]{0,17}$/.test(s) || BigInt(s) > MAX_MINOR) throw error('Ledger amounts must be positive exact integer minor units');
  return s;
}
function validCode(value) {
  const s = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(s)) throw error('Invalid ledger account code');
  return s;
}
function validReference(value) {
  const s = String(value || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{5,119}$/.test(s)) throw error('Invalid ledger source reference');
  return s;
}
function validateLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 50) throw error('A journal needs 2–50 posting lines');
  const seen = new Set();
  let debits = 0n, credits = 0n;
  const validated = lines.map(line => {
    if (!line || !['debit', 'credit'].includes(line.side)) throw error('Invalid ledger posting side');
    const code = validCode(line.accountCode);
    if (seen.has(code)) throw error('Each account may appear only once in a journal');
    seen.add(code);
    const minor = amount(line.amountMinor);
    if (line.side === 'debit') debits += BigInt(minor);
    else credits += BigInt(minor);
    return { accountCode: code, side: line.side, amountMinor: minor };
  }).sort((a,b) => a.accountCode.localeCompare(b.accountCode));
  if (debits !== credits || debits === 0n) throw error('Journal debits must equal credits in one currency');
  return validated;
}
function validateJournal(input) {
  if (!input || !SOURCE_TYPES.has(input.sourceType)) throw error('Unapproved ledger source type');
  const branchId = objectId(input.branchId, 'branch');
  const actorId = objectId(input.actorId, 'actor');
  const sourceRef = validReference(input.sourceRef);
  const currency = input.currency;
  if (!currencyCodes.includes(currency)) throw error('Unsupported ledger currency');
  const lines = validateLines(input.lines);
  const canonical = { branchId, actorId, sourceType: input.sourceType, sourceRef, currency, lines };
  return { ...canonical, fingerprint: crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex') };
}
function normalizeReversal(input) {
  const journalId = objectId(input?.journalId, 'journal');
  const requestedBy = objectId(input?.requestedBy, 'requester');
  const approvedBy = objectId(input?.approvedBy, 'approver');
  if (requestedBy === approvedBy) throw error('Reversal requires two independent people', 403);
  const reason = String(input.reason || '').trim();
  const ticketRef = validReference(input.ticketRef);
  if (reason.length < 20 || reason.length > 400) throw error('Reversal needs a detailed reason of 20–400 characters');
  return { journalId, requestedBy, approvedBy, reason, ticketRef };
}
async function checkBranch(conn, branchId, currency, session, allowArchived = false, treasury = false) {
  // Write to the branch's revision inside the financial transaction. Without
  // this conflict guard, a concurrent archive could commit while the first
  // journal was being posted based on an older 'active' snapshot.
  const branch = await branchModel(conn).findOneAndUpdate(
    { _id: branchId, ...(allowArchived ? {} : {status:'active'}) },
    {$inc:{revision:1}}, {session,new:true}).lean();
  if (!branch || (!treasury && branch.currency !== currency)) throw error('Inactive branch or currency mismatch', 409);
  return branch;
}
async function checkActor(conn, actorId, branchId, roles, session, operationalTreasury = false) {
  const person = await tenantUserModel(conn).findOne({ _id: actorId, status: 'active' })
    .select('role branchId mfaEnabledAt').session(session).lean();
  if (!person || !roles.includes(person.role)) throw error('Ledger action requires an authorized active user', 403);
  if (person.role !== 'Tenant Owner' && String(person.branchId) !== String(branchId)) throw error('Cross-branch ledger access prohibited', 403);
  // The platform requires TOTP enrollment for privileged tenant roles. This is
  // independent of the HTTP authentication middleware's session MFA check.
  if (!person.mfaEnabledAt && (!operationalTreasury || require('../../config/roles').requiresTenantMfa(person.role))) throw error('Privileged ledger actor must have MFA enrolled', 403);
  return person;
}
async function createAccount(conn, input) {
  const branchId = objectId(input.branchId, 'branch');
  const actorId = objectId(input.actorId, 'actor');
  const code = validCode(input.code);
  const name = String(input.name || '').trim();
  const category = String(input.category || '');
  const currency = input.currency;
  if (name.length < 3 || name.length > 120 || !['asset','liability','equity','income','expense'].includes(category)) throw error('Invalid chart account');
  if (!currencyCodes.includes(currency)) throw error('Invalid chart currency');
  await ensureTenantIndexes(conn);
  const session = await conn.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      await checkBranch(conn, branchId, currency, session);
      await checkActor(conn, actorId, branchId, ['Tenant Owner'], session);
      [created] = await ledgerAccountModel(conn).create([{ branchId, code, name, category, currency, createdBy: actorId }], { session });
      await auditEventModel(conn).create([{ action: 'ledger.account.created', actorId,
        targetId: created._id, metadata: { branchId, code, category, currency } }], { session });
    });
    return created;
  } catch (e) {
    if (e.code === 11000) throw error('Ledger account code already exists in this branch', 409);
    throw e;
  } finally { await session.endSession(); }
}
async function findMatchingExisting(Journal, lookup, fingerprint) {
  const prior = await Journal.findOne(lookup).lean();
  if (!prior) return null;
  if (prior.fingerprint !== fingerprint) throw error('Ledger source reference reused with different posting details', 409);
  return prior;
}
async function writeJournal(conn, validated, session, extras = {}) {
  const Account = ledgerAccountModel(conn), Journal = ledgerJournalModel(conn), Posting = ledgerPostingModel(conn);
  if(extras.operationalTreasury && (validated.sourceType!=='treasury'||!session?.inTransaction()))throw error('Treasury posting requires its active business transaction',403);
  await checkBranch(conn, validated.branchId, validated.currency, session, Boolean(extras.reverses), validated.sourceType==='treasury');
  await checkActor(conn, validated.actorId, validated.branchId, extras.operationalTreasury?['Tenant Owner','Branch Manager','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator','Reconciliation Officer']:['Tenant Owner','Reconciliation Officer'], session,Boolean(extras.operationalTreasury));
  const codes = validated.lines.map(p=>p.accountCode);
  const accounts = await Account.find({branchId:validated.branchId, currency:validated.currency, code:{$in:codes}}).session(session).lean();
  if (accounts.length !== codes.length) throw error('Ledger account missing or belongs to another branch/currency', 409);
  const byCode = new Map(accounts.map(a=>[a.code,a]));
  const [journal] = await Journal.create([{
    branchId:validated.branchId, currency:validated.currency, sourceType:validated.sourceType,
    sourceRef:validated.sourceRef, fingerprint:validated.fingerprint, actorId:validated.actorId,
    ...(extras.reverses ? {reverses:extras.reverses,approval:extras.approval} : {})
  }], { session });
  await Posting.create(validated.lines.map((p,i)=>({journalId:journal._id,branchId:validated.branchId,
    accountId:byCode.get(p.accountCode)._id,currency:validated.currency,lineNo:i,side:p.side,amountMinor:p.amountMinor})),{session,ordered:true});
  await auditEventModel(conn).create([{ action: extras.reverses ? 'ledger.journal.reversed' : 'ledger.journal.posted',
    actorId:validated.actorId,targetId:journal._id,metadata:{branchId:validated.branchId,
      sourceType:validated.sourceType,sourceRef:validated.sourceRef,
      ...(extras.reverses ? {reverses:String(extras.reverses),ticketRef:extras.approval.ticketRef} : {})} }],{session});
  return journal;
}
async function postJournal(conn, input) {
  const request = validateJournal(input);
  if(request.sourceType==='treasury')throw error('Use the reviewed treasury balance or funded operation workflow',403);
  await ensureTenantIndexes(conn);
  const Journal = ledgerJournalModel(conn);
  const lookup = {sourceType:request.sourceType,sourceRef:request.sourceRef};
  // Even an idempotent read must not disclose journals to a revoked actor.
  await checkActor(conn,request.actorId,request.branchId,['Tenant Owner','Reconciliation Officer'],null);
  const prior = await findMatchingExisting(Journal,lookup,request.fingerprint);
  if (prior) return {journal:prior,duplicate:true};
  const session = await conn.startSession();
  try {
    let journal;
    await session.withTransaction(async()=>{journal=await writeJournal(conn,request,session);});
    return {journal,duplicate:false};
  } catch(e) {
    if (e.code === 11000) {
      const existing = await findMatchingExisting(Journal,lookup,request.fingerprint);
      if (existing) return {journal:existing,duplicate:true};
    }
    throw e;
  } finally { await session.endSession(); }
}
async function reverseJournal(conn, input) {
  const request = normalizeReversal(input);
  await ensureTenantIndexes(conn);
  const Journal = ledgerJournalModel(conn), Posting = ledgerPostingModel(conn), Account = ledgerAccountModel(conn);
  const original = await Journal.findById(request.journalId).lean();
  if (!original || original.reverses || original.sourceType === 'reversal') throw error('Original journal is missing or not reversible',409);
  if(original.sourceType==='treasury')throw error('Treasury corrections must reverse their linked balance movements in the funded workflow',409);
  // A posted provider settlement must never be undone solely by a local journal
  // reversal. External compensation/refund evidence and reconciliation are
  // required first. The dedicated provider reversal lifecycle is not enabled.
  if (await financialOperationModel(conn).exists({sourceType:original.sourceType,sourceRef:original.sourceRef,status:'reconciled'}))
    throw error('Provider-reconciled financial entries require independently verified external reversal evidence',409);
  // Validate identities before returning any previous reversal metadata.
  await checkActor(conn,request.approvedBy,String(original.branchId),['Tenant Owner','Reconciliation Officer'],null);
  const requester=await tenantUserModel(conn).findOne({_id:request.requestedBy,status:'active'}).select('role branchId').lean();
  if(!requester || (requester.role!=='Tenant Owner' && String(requester.branchId)!==String(original.branchId)))throw error('Invalid reversal requester',403);
  const prior = await Journal.findOne({reverses:original._id}).lean();
  if (prior) {
    if (prior.approval?.ticketRef === request.ticketRef && String(prior.approval?.requestedBy) === request.requestedBy &&
      String(prior.approval?.approvedBy) === request.approvedBy && prior.approval?.reason === request.reason) return {journal:prior,duplicate:true};
    throw error('This journal has already been reversed',409);
  }
  // A damaged source must never be turned into a second 'valid' ledger entry.
  await inspectJournal(conn,request.journalId);
  const session = await conn.startSession();
  try {
    let journal;
    await session.withTransaction(async()=>{
      if(await financialOperationModel(conn).exists({sourceType:original.sourceType,sourceRef:original.sourceRef,status:'reconciled'}).session(session))
        throw error('Provider settlement cannot be reversed without external correction evidence',409);
      await checkBranch(conn,String(original.branchId),original.currency,session,true);
      const requester = await tenantUserModel(conn).findOne({_id:request.requestedBy,status:'active'}).select('role branchId').session(session).lean();
      if (!requester || (requester.role !== 'Tenant Owner' && String(requester.branchId)!==String(original.branchId))) throw error('Invalid reversal requester',403);
      await checkActor(conn,request.approvedBy,String(original.branchId),['Tenant Owner','Reconciliation Officer'],session);
      if (request.approvedBy === String(original.actorId)) throw error('Original poster cannot approve their own reversal',403);
      const entries = await Posting.find({journalId:original._id}).sort({lineNo:1}).session(session).lean();
      if (entries.length < 2 || entries.length > 50) throw error('Original ledger postings incomplete',409);
      const accounts = await Account.find({_id:{$in:entries.map(e=>e.accountId)},branchId:original.branchId}).session(session).lean();
      const names = new Map(accounts.map(a=>[String(a._id),a.code]));
      if (names.size !== entries.length) throw error('Original ledger account references are missing',409);
      const validation = validateLines(entries.map(p=>({accountCode:names.get(String(p.accountId)),
        side:p.side==='debit'?'credit':'debit',amountMinor:String(p.amountMinor)})));
      const sourceRef = validReference(`rev:${request.ticketRef}`);
      const canonical = {branchId:String(original.branchId),actorId:request.approvedBy,
        sourceType:'reversal',sourceRef,currency:original.currency,lines:validation,originalId:String(original._id),
        approval:{requestedBy:request.requestedBy,approvedBy:request.approvedBy,reason:request.reason,ticketRef:request.ticketRef}};
      const fingerprint=crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
      journal = await writeJournal(conn,{...canonical,fingerprint},session,{reverses:original._id,approval:canonical.approval});
    });
    return {journal,duplicate:false};
  } catch(e) {
    if (e.code === 11000) {
      const existing = await Journal.findOne({reverses:original._id}).lean();
      if (existing && existing.approval?.ticketRef===request.ticketRef &&
        String(existing.approval?.requestedBy)===request.requestedBy &&
        String(existing.approval?.approvedBy)===request.approvedBy && existing.approval?.reason===request.reason) return {journal:existing,duplicate:true};
      throw error('Journal or reversal reference already used',409);
    }
    throw e;
  } finally { await session.endSession(); }
}
async function trialBalance(conn, {branchId,currency}={}) {
  const id=objectId(branchId,'branch');
  if (!currencyCodes.includes(currency)) throw error('Unsupported ledger currency');
  const Account=ledgerAccountModel(conn), Posting=ledgerPostingModel(conn);
  const accounts=await Account.find({branchId:id,currency}).sort({code:1}).limit(501).lean();
  if (accounts.length > 500) throw error('Trial balance requires paginated account reporting',422);
  const sums=await Posting.aggregate([
    {$match:{branchId:new Types.ObjectId(id),currency}},
    {$group:{_id:{accountId:'$accountId',side:'$side'},amount:{$sum:'$amountMinor'}}}
  ]).option({maxTimeMS:10000});
  const totals=new Map();
  for(const r of sums){
    const k=String(r._id.accountId), p=totals.get(k)||{debit:0n,credit:0n};
    p[r._id.side]+=BigInt(String(r.amount)); totals.set(k,p);
  }
  const rows=accounts.map(a=>{const p=totals.get(String(a._id))||{debit:0n,credit:0n};
    return {accountId:String(a._id),code:a.code,name:a.name,category:a.category,
      debitsMinor:String(p.debit),creditsMinor:String(p.credit),netDebitMinor:String(p.debit-p.credit)};});
  const totalDebit=rows.reduce((n,r)=>n+BigInt(r.debitsMinor),0n);
  const totalCredit=rows.reduce((n,r)=>n+BigInt(r.creditsMinor),0n);
  if (totals.size > accounts.length || totalDebit!==totalCredit) throw error('Ledger integrity exception: trial balance does not reconcile',503);
  return {branchId:id,currency,rows,totalDebitsMinor:String(totalDebit),totalCreditsMinor:String(totalCredit),balanced:true};
}
async function inspectJournal(conn, journalId) {
  const id=objectId(journalId,'journal');
  const Journal=ledgerJournalModel(conn),Posting=ledgerPostingModel(conn),Account=ledgerAccountModel(conn);
  const journal=await Journal.findById(id).lean();
  if(!journal)throw error('Ledger journal not found',404);
  const entries=await Posting.find({journalId:id}).sort({lineNo:1}).lean();
  if(entries.length<2 || entries.length>50 || entries.some((p,i)=>p.lineNo!==i ||
      String(p.branchId)!==String(journal.branchId)||p.currency!==journal.currency))throw error('Ledger journal line integrity failure',503);
  const accounts=await Account.find({_id:{$in:entries.map(e=>e.accountId)}}).lean();
  const names=new Map(accounts.map(a=>[String(a._id),a]));
  if(names.size!==entries.length)throw error('Ledger account integrity failure',503);
  const lines=validateLines(entries.map(p=>{
    const account=names.get(String(p.accountId));
    if(!account || String(account.branchId)!==String(journal.branchId) || account.currency!==journal.currency)
      throw error('Cross-branch/currency ledger integrity violation',503);
    return {accountCode:account.code,side:p.side,amountMinor:String(p.amountMinor)};
  }));
  const canonical={branchId:String(journal.branchId),actorId:String(journal.actorId),
    sourceType:journal.sourceType,sourceRef:journal.sourceRef,currency:journal.currency,lines};
  if(journal.reverses) {
    if(journal.sourceType!=='reversal'||!journal.approval)throw error('Reversal approval missing',503);
    canonical.originalId=String(journal.reverses);
    canonical.approval={requestedBy:String(journal.approval.requestedBy),approvedBy:String(journal.approval.approvedBy),
      reason:journal.approval.reason,ticketRef:journal.approval.ticketRef};
    const original=await Journal.findById(journal.reverses).lean();
    if(!original || original.reverses || original.currency!==journal.currency ||
      String(original.branchId)!==String(journal.branchId))throw error('Reversal source integrity failure',503);
    const source=await Posting.find({journalId:original._id}).lean();
    const map=new Map(entries.map(p=>[String(p.accountId),p]));
    if(source.length!==entries.length || source.some(p=>{
      const flipped=map.get(String(p.accountId));
      return !flipped || flipped.side===p.side || String(flipped.amountMinor)!==String(p.amountMinor);
    }))throw error('Reversal does not exactly offset its source',503);
  } else if(journal.sourceType==='reversal')throw error('Reversal source missing',503);
  const hash=crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  if(journal.fingerprint!==hash)throw error('Ledger journal fingerprint mismatch',503);
  return {valid:true,journalId:id,postingCount:entries.length,currency:journal.currency};
}
// Keep legacy entrypoints explicitly disabled. No old controller may silently
// start posting through the new accounting foundation.
const unavailable=require('../../utils/unavailableOperation');
module.exports={createAccount,postJournal,reverseJournal,trialBalance,inspectJournal,
  writeJournalInSession:writeJournal,
  writeOperationalJournalInSession:async(conn,input,session)=>{
    if(input?.sourceType!=='treasury')throw error('Only treasury journals use operational posting',403);
    return writeJournal(conn,validateJournal(input),session,{operationalTreasury:true});
  },
  validateLines,validateJournal,normalizeReversal,amount,
  postEntry:()=>unavailable('Legacy unverified financial posting'),
  get entries(){return unavailable('Legacy ledger entries');}};
