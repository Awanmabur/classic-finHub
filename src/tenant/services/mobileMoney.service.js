const { mobileTransactionModel, auditEventModel, branchModel, ensureTenantIndexes } = require('../models');
const currencies = { UGX: 0, KES: 2 };
const MAX_MINOR = 10000000000;
function toMinor(value, currency, allowZero = false) {
  const s = String(value ?? '').trim();
  const decimals = currencies[currency];
  if (decimals === undefined || !/^\d{1,11}(?:\.\d{1,2})?$/.test(s)) throw bad('Enter a valid amount and supported currency');
  const parts = s.split('.');
  if ((parts[1] || '').length > decimals) throw bad('Too many decimal places for currency');
  const minor = Number(parts[0]) * 10**decimals + Number((parts[1] || '').padEnd(decimals,'0'));
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR || (!allowZero && minor < 1)) throw bad('Amount is outside permitted limits');
  return minor;
}
function fromMinor(value, currency) { return Number(String(value)) / 10 ** currencies[currency]; }
function formatMoneyMinor(value, currency) {
  const decimalPlaces = currencies[currency];
  if (decimalPlaces === undefined) throw bad('Unsupported currency');
  const int = BigInt(String(value));
  const absolute = int < 0n ? -int : int;
  const base = 10n ** BigInt(decimalPlaces);
  const whole = absolute / base;
  const cents = decimalPlaces ? '.' + (absolute % base).toString().padStart(decimalPlaces,'0') : '';
  return `${currency} ${int < 0n ? '-' : ''}${whole.toLocaleString('en-US')}${cents}`;
}
function bad(message, status=400) { const e = new Error(message); e.status = status; return e; }
function validate(input, operation) {
  if (!['cash_in','cash_out'].includes(operation)) throw bad('Unsupported operation');
  const customer = String(input.customer || '').trim();
  const network = String(input.network || '');
  const currency = String(input.currency || '');
  const networkReference = String(input.networkReference || '').trim();
  const idempotencyKey = String(input.idempotencyKey || '');
  if (customer.length < 2 || customer.length > 120 || !['MTN','Airtel','M-Pesa'].includes(network)) throw bad('Customer and network are required');
  if (!/^[A-Za-z0-9._:/-]{5,100}$/.test(networkReference)) throw bad('Provide the valid network transaction reference (5–100 characters)');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) throw bad('Expired form reference. Reload the page and retry.');
  const amountMinor = toMinor(input.amount, currency);
  const feeMinor = toMinor(input.fee ?? '0', currency, true);
  if (feeMinor > amountMinor) throw bad('Fee cannot exceed amount');
  return { operation, customer, network, networkReference, currency, amountMinor, feeMinor, idempotencyKey };
}
async function recordMobileMoney(conn, operator, input, operation, tenant) {
  if(!operator?.id || !['Tenant Owner','Mobile Money Operator'].includes(operator.role))throw bad('This role cannot record Mobile Money operations',403);
  const values = validate(input, operation);
  if(!require('./moduleAccess.service').hasModule(tenant,'mobile_money'))throw bad('An active Mobile Money module subscription is required',403);
  const requestedBranchId=operator.role==='Tenant Owner' ? String(input.branchId||'') : String(operator.branchId||'');
  if(!/^[a-f0-9]{24}$/i.test(requestedBranchId))throw bad('Choose an active branch before recording an operation',400);
  await ensureTenantIndexes(conn);
  const Model = mobileTransactionModel(conn);
  // A retry for a committed operation is idempotent even when the monthly
  // allowance was subsequently exhausted. It must never consume another unit.
  const prior=await Model.findOne({idempotencyKey:values.idempotencyKey}).lean();
  if(prior){
    if(String(prior.operatorId)!==String(operator.id)||prior.operation!==operation||
      String(prior.branchId)!==requestedBranchId||
      ['amountMinor','feeMinor','currency','customer','network','networkReference']
        .some(k=>String(prior[k])!==String(values[k])))throw bad('This operation reference was already used for different details.',409);
    return {created:prior,duplicate:true};
  }
  const Audit = auditEventModel(conn);
  const session = await conn.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      const branch=await branchModel(conn).findOneAndUpdate({_id:requestedBranchId,status:'active'},{$inc:{revision:1}},{session,new:true});
      if(!branch)throw bad('Assigned branch is inactive or unavailable',409);
      if(branch.currency!==values.currency)throw bad('Operation currency does not match the branch currency',409);
      await require('../../platform/services/commercial.service').reserveUsage(tenant,'mobile_money_records',session);
      const cashSessionId=await require('./cashDrawer.service').attachRecord(conn,session,operator,branch._id,values.currency,operation,BigInt(values.amountMinor));
      [created] = await Model.create([{ ...values, cashSessionId, branchId:branch._id, amountMinor: String(values.amountMinor), feeMinor: String(values.feeMinor), operatorId: operator.id, status: 'pending_verification' }], { session });
      await Audit.create([{
        action: `mobile_money.${operation}.recorded`, actorId: operator.id, targetId: created._id,
        metadata: { currency: values.currency, amountMinor: values.amountMinor, network: values.network, branchId: String(created.branchId) }
      }], { session });
    });
    return { created, duplicate: false };
  } catch (e) {
    if (e.code === 11000) {
      const existing = await Model.findOne({ idempotencyKey: values.idempotencyKey }).lean();
      if (existing) {
        if (String(existing.operatorId) !== operator.id || existing.operation !== operation ||
          String(existing.branchId)!==requestedBranchId ||
          ['amountMinor','feeMinor','currency','customer','network','networkReference'].some(k => String(existing[k]) !== String(values[k]))) {
          throw bad('This operation reference was already used for different details.', 409);
        }
        return { created: existing, duplicate: true };
      }
      // Unique provider references must never result in a generic server error.
      throw bad('This network transaction reference is already recorded.', 409);
    }
    throw e;
  } finally { await session.endSession(); }
}
// Internal evidence review ONLY: these decisions do not update provider settlement status,
// cash balances or ledger accounts. The reviewer must be a second person.
async function reviewMobileMoney(conn, reviewer, recordId, decision, note) {
  if (!['Tenant Owner','Reconciliation Officer'].includes(reviewer?.role)) throw bad('Not permitted to review operations', 403);
  if (!/^[a-f0-9]{24}$/i.test(String(recordId || ''))) throw bad('Invalid record ID');
  if (!['accepted','disputed'].includes(decision)) throw bad('Invalid review decision');
  if (typeof note !== 'string' || note.trim().length < 12 || note.trim().length > 400) throw bad('Explain the evidence or reason in 12–400 characters');
  await ensureTenantIndexes(conn);
  const Model = mobileTransactionModel(conn);
  const Audit = auditEventModel(conn);
  const session = await conn.startSession();
  let created;
  try {
    await session.withTransaction(async () => {
      // Conditional update is the concurrency guard: only the first reviewer wins.
      created = await Model.findOneAndUpdate({
        _id: recordId, reviewState: { $in: ['awaiting_review', null] }, operatorId: { $ne: reviewer.id },
        status: 'pending_verification', correctionState: {$nin:['requested','voided']},
        ...(reviewer.role==='Tenant Owner' || reviewer.role==='Auditor' ? {} : {branchId:reviewer.branchId || null})
      }, { $set: {
        reviewState: decision, reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: note.trim()
      } }, { new: true, session }).lean();
      if (!created) throw bad('Record unavailable, already reviewed, or created by this reviewer.', 409);
      await require('./cashDrawer.service').fenceRecordChange(conn,session,created);
      await Audit.create([{
        action: `mobile_money.review.${decision}`, actorId: reviewer.id, targetId: created._id,
        metadata: { network: created.network, operation: created.operation, recordId: String(created._id), branchId: String(created.branchId||'') }
      }], { session });
    });
    return created;
  } finally { await session.endSession(); }
}
async function getReviewQueue(conn, reviewerId, max = 25, branchId = null) {
  const take = Number.isSafeInteger(max) && max >= 1 && max <= 100 ? max : 25;
  return mobileTransactionModel(conn).find({ reviewState: { $in: ['awaiting_review',null] },
    status: 'pending_verification', correctionState: {$nin:['requested','voided']}, operatorId: { $ne: reviewerId }, ...(branchId ? {branchId} : {}) })
    .sort({ createdAt: 1 }).limit(take).lean();
}
// Void requests preserve the original network reference, amount, and historical
// review. Nothing here produces a refund, provider settlement or ledger entry.
function validateNote(note,minimum=12){
  if(typeof note!=='string'||note.trim().length<minimum||note.trim().length>400)
    throw bad(`Document the reason in ${minimum}–400 characters`);
  return note.trim();
}
async function requestVoid(conn,actor,recordId,note){
  if(!actor?.id||!['Tenant Owner','Mobile Money Operator'].includes(actor.role))throw bad('Only the originating operator can request a correction',403);
  if(!/^[a-f0-9]{24}$/i.test(String(recordId||'')))throw bad('Invalid record ID');
  const reason=validateNote(note);
  await ensureTenantIndexes(conn);
  const Model=mobileTransactionModel(conn),Audit=auditEventModel(conn),session=await conn.startSession();
  try{
    let record;
    await session.withTransaction(async()=>{
      record=await Model.findOneAndUpdate({_id:recordId,operatorId:actor.id,status:'pending_verification',
        correctionState:{$in:['none','denied',null]},
        $or:[{correctionAttempts:{$lt:5}},{correctionAttempts:{$exists:false}}],...(actor.role==='Tenant Owner'?{}:{branchId:actor.branchId||null})},
        {$set:{correctionState:'requested',correctionReason:reason,correctionRequestedAt:new Date(),correctionRequestedBy:actor.id,
          correctionReviewedBy:null,correctionReviewedAt:null,correctionReviewNote:null},
          $inc:{correctionAttempts:1},
          $push:{correctionHistory:{action:'requested',actorId:actor.id,note:reason,at:new Date()}}}, {new:true,session}).lean();
      if(!record)throw bad('Only an originating operator can request correction of an unsettled record that is not already under review',409);
      await require('./cashDrawer.service').fenceRecordChange(conn,session,record);
      await Audit.create([{action:'mobile_money.void.requested',actorId:actor.id,targetId:record._id,
        metadata:{branchId:String(record.branchId),reasonDigest:require('node:crypto').createHash('sha256').update(reason).digest('hex')}}],{session});
    });
    return record;
  }finally{await session.endSession();}
}
async function decideVoid(conn,reviewer,recordId,decision,note){
  if(!reviewer?.id||!['Tenant Owner','Reconciliation Officer'].includes(reviewer.role))throw bad('Only independent reconciliation staff can decide a correction',403);
  if(!/^[a-f0-9]{24}$/i.test(String(recordId||'')))throw bad('Invalid record ID');
  if(!['approve','deny'].includes(decision))throw bad('Invalid correction decision');
  const reason=validateNote(note);
  await ensureTenantIndexes(conn);
  const Model=mobileTransactionModel(conn),Audit=auditEventModel(conn),session=await conn.startSession();
  try{
    let record;
    await session.withTransaction(async()=>{
      record=await Model.findOneAndUpdate({_id:recordId,status:'pending_verification',correctionState:'requested',
        operatorId:{$ne:reviewer.id},correctionRequestedBy:{$ne:reviewer.id},
        ...(reviewer.role==='Tenant Owner'?{}:{branchId:reviewer.branchId||null})},
        {$set:{correctionState:decision==='approve'?'voided':'denied',
          ...(decision==='approve'?{status:'voided_internal'}:{}),correctionReviewedBy:reviewer.id,
          correctionReviewedAt:new Date(),correctionReviewNote:reason},
          $push:{correctionHistory:{action:decision==='approve'?'approved':'denied',actorId:reviewer.id,note:reason,at:new Date()}}}, {new:true,session}).lean();
      if(!record)throw bad('Correction already decided, outside your branch, or submitted by you',409);
      if(record.cashSessionId){
        const movement=BigInt(String(record.amountMinor))*(record.operation==='cash_in'?1n:-1n);
        await require('./cashDrawer.service').fenceRecordChange(conn,session,record,decision==='approve'?-movement:0n);
      }
      await Audit.create([{action:`mobile_money.void.${decision==='approve'?'approved':'denied'}`,
        actorId:reviewer.id,targetId:record._id,metadata:{branchId:String(record.branchId),decision}}],{session});
    });
    return record;
  }finally{await session.endSession();}
}
async function getVoidQueue(conn,reviewerId,max=25,branchId=null){
  const take=Number.isSafeInteger(max)&&max>=1&&max<=100?max:25;
  return mobileTransactionModel(conn).find({status:'pending_verification',correctionState:'requested',
    operatorId:{$ne:reviewerId},correctionRequestedBy:{$ne:reviewerId},...(branchId?{branchId}:{})})
    .sort({correctionRequestedAt:1}).limit(take).lean();
}
function dateBounds({ from, to } = {}) {
  if (!from && !to) {
    const start = new Date(); start.setUTCHours(0,0,0,0);
    return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw bad('Use valid start and end dates');
  const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T00:00:00Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || a.toISOString().slice(0,10) !== from || b.toISOString().slice(0,10) !== to || b < a || b-a > 90*86400000) throw bad('Report dates must be valid and within 90 days');
  return { $gte: a, $lt: new Date(b.getTime()+86400000) };
}
async function getTransactions(conn, { from, to, limit = 60, operatorId, branchId } = {}) {
  const bounds = dateBounds({ from, to });
  const Model = mobileTransactionModel(conn);
  const scope = { ...(operatorId ? {operatorId} : {}), ...(branchId ? {branchId} : {}) };
  const requested = Number(limit);
  const take = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 5000) : 60;
  // The export must never silently truncate, but ordinary dashboard lists remain usable
  // even when a mature tenant has more than 5,000 historical records.
  if (take === 5000) {
    const total = await Model.countDocuments({ createdAt: bounds, ...scope });
    if (total > 5000) throw bad('Export contains more than 5,000 records. Narrow the date range to avoid truncation.', 422);
  }
  return Model.find({ createdAt: bounds, ...scope }).sort({ createdAt:-1 }).limit(take).lean();
}
// Stable keyset pagination avoids unbounded skip() scans in growing tenants.
// Cursor is deliberately just an ordering position; scope is always reapplied.
function encodeCursor(row){
  return Buffer.from(JSON.stringify([new Date(row.createdAt).toISOString(),String(row._id)])).toString('base64url');
}
function decodeCursor(raw){
  if(raw===undefined||raw===null||raw==='')return null;
  if(typeof raw!=='string'||raw.length>160||!/^[a-zA-Z0-9_-]{20,160}$/.test(raw))throw bad('Invalid history cursor');
  try{
    const values=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    if(!Array.isArray(values)||values.length!==2||typeof values[0]!=='string'||typeof values[1]!=='string'||
      !/^[a-f0-9]{24}$/i.test(values[1])||!Number.isFinite(Date.parse(values[0]))||
      new Date(values[0]).toISOString()!==values[0])throw Error('Invalid cursor');
    return {at:new Date(values[0]),id:values[1]};
  }catch{throw bad('Invalid history cursor');}
}
async function getTransactionPage(conn,{from,to,cursor,operatorId,branchId,limit=40}={}){
  const dateRange=dateBounds({from,to}),position=decodeCursor(cursor);
  const n=Number(limit),take=Number.isSafeInteger(n)&&n>0&&n<=100?n:40;
  const {Types}=require('mongoose');
  const scope={...(operatorId?{operatorId:new Types.ObjectId(operatorId)}:{}),
    ...(branchId?{branchId:new Types.ObjectId(branchId)}:{})};
  const query={...scope,createdAt:dateRange};
  if(position)query.$or=[{createdAt:{$lt:position.at}},
    {createdAt:position.at,_id:{$lt:new Types.ObjectId(position.id)}}];
  const results=await mobileTransactionModel(conn).find(query).sort({createdAt:-1,_id:-1}).limit(take+1).lean();
  const hasMore=results.length>take,items=results.slice(0,take);
  return {items,nextCursor:hasMore?encodeCursor(items.at(-1)):null,from:from||'',to:to||''};
}
function visibleRecordForRole(record,role){
  if(role!=='Viewer')return record;
  return {...record,correctionHistory:(record.correctionHistory||[]).map(entry=>({
    ...entry,note:'Restricted to operational staff'
  }))};
}
async function getRecordDetails(conn,recordId,scope={}){
  if(!/^[a-f0-9]{24}$/i.test(String(recordId||'')))throw bad('Invalid record ID');
  const {Types}=require('mongoose');
  const filter={_id:new Types.ObjectId(recordId),
    ...(scope.branchId?{branchId:new Types.ObjectId(scope.branchId)}:{}),
    ...(scope.operatorId?{operatorId:new Types.ObjectId(scope.operatorId)}:{})};
  const record=await mobileTransactionModel(conn).findOne(filter).lean();
  if(!record)throw bad('Record not found within your access scope',404);
  return record;
}
async function getSummary(conn, { from, to, operatorId, branchId } = {}) {
  const bounds = dateBounds({ from, to });
  const Model = mobileTransactionModel(conn);
  const {Types}=require('mongoose');
  const scope = { ...(operatorId ? {operatorId:new Types.ObjectId(operatorId)} : {}), ...(branchId ? {branchId:new Types.ObjectId(branchId)} : {}) };
  const query = { createdAt:bounds, ...scope };
  const [total, pending, awaitingReview, summaries, recent] = await Promise.all([
    Model.countDocuments(query),
    Model.countDocuments({ ...query, status: 'pending_verification' }),
    Model.countDocuments({ ...query, status:'pending_verification',correctionState:{$nin:['requested','voided']}, reviewState: { $in: ['awaiting_review',null] } }),
    Model.aggregate([{ $match: query }, { $group: {
      _id: { currency:'$currency', operation:'$operation', network:'$network', status:'$status', reviewState: { $ifNull: ['$reviewState','awaiting_review'] }, correctionState:{$ifNull:['$correctionState','none']} },
      count: { $sum:1 }, volumeMinor: { $sum:'$amountMinor' }, feesMinor: { $sum:'$feeMinor' }
    } }, { $sort: { '_id.currency': 1, '_id.network':1 } }]),
    Model.find(query).sort({ createdAt:-1 }).limit(15).lean()
  ]);
  return { total, pending, awaitingReview, summaries: summaries.map(s=>({ ...s, volumeFormatted: formatMoneyMinor(s.volumeMinor,s._id.currency), feesFormatted: formatMoneyMinor(s.feesMinor,s._id.currency) })), recent };
}
// CSV content is escaped so spreadsheet apps cannot evaluate attacker-supplied formulae.
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[\s\u0000-\u001f]*[=+@\-\t\r]/.test(s)) s = "'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
function toCsv(items) {
  const rows = [['Date (UTC)','Operation','Customer','Network','Reference','Currency','Amount','Fee','Operational Record Status','Internal Review','Correction State','Reviewed At (UTC)','Review Note']];
  for (const r of items) rows.push([
    new Date(r.createdAt).toISOString(), r.operation, r.customer, r.network, r.networkReference,
    r.currency, fromMinor(r.amountMinor,r.currency).toFixed(currencies[r.currency]),
    fromMinor(r.feeMinor,r.currency).toFixed(currencies[r.currency]),r.status, r.reviewState || 'awaiting_review',r.correctionState||'none', r.reviewedAt ? new Date(r.reviewedAt).toISOString() : '', r.reviewNote || ''
  ]);
  return rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
module.exports = { currencies, toMinor, fromMinor, formatMoneyMinor, validate, dateBounds, recordMobileMoney, reviewMobileMoney, getReviewQueue, requestVoid, decideVoid, getVoidQueue, getTransactions, getTransactionPage, getRecordDetails, visibleRecordForRole, encodeCursor, decodeCursor, getSummary, toCsv, csvCell };
