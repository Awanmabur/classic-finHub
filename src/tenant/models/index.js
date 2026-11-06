const mongoose = require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true },
  authVersion: { type: Number, min: 0, default: 0, required: true },
  mfaSecretEncrypted: { type: String, default: null, select: false },
  mfaEnabledAt: { type: Date, default: null },
  mfaLastCounter: { type: Number, min: -1, default: -1 },
  role: { type: String, required: true, enum: ['Tenant Owner','Branch Manager','Mobile Money Operator','Money Transfer Operator','Banking Operator','Forex Operator','Reconciliation Officer','Auditor','Reports Analyst','Analytics Analyst','Approval Requester','Approval Officer','Viewer'] },
  permissions: { type: [String], default: [] },
  branchId: { type: String, default: null },
  // Null on legacy users means role-derived access; new invites always store explicit entitlements.
  allowedModules: { type: [String], default: undefined },
  status: { type: String, enum: ['active','disabled'], default: 'active' }
}, { timestamps: true, strict: 'throw' });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({branchId:1,status:1});
const correctionEventSchema = new mongoose.Schema({
  action:{type:String,enum:['requested','approved','denied'],required:true},
  actorId:{type:mongoose.Schema.Types.ObjectId,required:true},
  note:{type:String,required:true,maxlength:400},
  at:{type:Date,default:Date.now}
},{_id:false,strict:'throw'});
const moneySchema = new mongoose.Schema({
  entrySource:{type:String,enum:['manual','sms'],default:'manual',immutable:true},
  smsInboxId:{type:mongoose.Schema.Types.ObjectId,default:null,immutable:true},
  idempotencyKey: { type: String, required: true, immutable: true, match: /^[0-9a-f-]{36}$/ },
  operation: { type: String, enum: ['cash_in','cash_out'], required: true, immutable: true },
  customer: { type: String, required: true, maxlength: 120, immutable: true },
  customerPhone:{type:String,default:'',maxlength:16,immutable:true},
  customerNote:{type:String,default:'',maxlength:400,immutable:true},
  paymentMethod:{type:String,enum:['Cash','Wallet Balance','Bank'],default:'Cash',immutable:true},
  network: { type: String, enum: ['MTN','Airtel','Africell','M-Pesa'], required: true, immutable: true },
  networkReference: { type: String, required: true, maxlength: 100, immutable: true },
  amountMinor: { type: mongoose.Schema.Types.Decimal128, required: true, immutable: true },
  feeMinor: { type: mongoose.Schema.Types.Decimal128, required: true, immutable: true },
  currency: { type: String, enum: currencyCodes, required: true, immutable: true },
  status: { type: String, enum: ['pending_verification','verified','rejected','voided_internal'], default: 'pending_verification' },
  reviewState: { type: String, enum: ['awaiting_review','accepted','disputed'], default: 'awaiting_review' },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: null, maxlength: 400 },
  // Never remove or overwrite an incorrect record. A different person must
  // authorize its internal void, and both decisions remain in the audit trail.
  correctionState: {type:String,enum:['none','requested','denied','voided'],default:'none'},
  correctionAttempts:{type:Number,default:0,min:0,max:5},
  correctionReason: {type:String,default:null,maxlength:400},
  correctionRequestedBy: {type:mongoose.Schema.Types.ObjectId,default:null},
  correctionRequestedAt: {type:Date,default:null},
  correctionReviewedBy: {type:mongoose.Schema.Types.ObjectId,default:null},
  correctionReviewedAt: {type:Date,default:null},
  correctionReviewNote: {type:String,default:null,maxlength:400},
  correctionHistory:{type:[correctionEventSchema],default:[]},

  operatorId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  cashSessionId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
  verifiedBy: { type: mongoose.Schema.Types.ObjectId }, verifiedAt: { type: Date },
  verificationNote: { type: String, maxlength: 400 },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { strict: 'throw', versionKey: false });
moneySchema.index({ idempotencyKey: 1 }, { unique: true });
moneySchema.index({cashSessionId:1,reviewState:1,correctionState:1});
moneySchema.index({ network: 1, networkReference: 1 }, { unique: true });
moneySchema.index({ createdAt: -1 });
moneySchema.index({createdAt:-1,_id:-1});
moneySchema.index({operation:1,createdAt:-1,_id:-1});
moneySchema.index({branchId:1,operation:1,createdAt:-1,_id:-1});
moneySchema.index({branchId:1,operatorId:1,operation:1,createdAt:-1,_id:-1});
moneySchema.index({ operatorId: 1, createdAt: -1 });
moneySchema.index({ operatorId:1, createdAt:-1, _id:-1 });
moneySchema.index({ branchId: 1, createdAt: -1 });
moneySchema.index({ branchId:1, createdAt:-1, _id:-1 });
moneySchema.index({ branchId:1,operatorId:1,createdAt:-1,_id:-1 });
moneySchema.index({ status: 1, createdAt: -1 });
moneySchema.index({ network: 1, status: 1, createdAt: -1 });
moneySchema.index({ reviewState: 1, createdAt: -1 });
moneySchema.index({ branchId: 1, reviewState: 1, createdAt: 1 });
moneySchema.index({ branchId: 1, correctionState: 1, createdAt: 1 });
const ledgerSchemas = require('../ledger/schemas');
const financialSchemas = require('../financial/schemas');
const staffInviteSchema = require('./StaffInvite');
const branchSchema = require('./Branch');
const cashSessionSchema = require('./CashSession');
const transferContactSchema=require('../schemas/TransferContact.schema');
const transferOrderSchema=require('../schemas/TransferOrder.schema');
const approvalPolicySchema=require('../schemas/ApprovalPolicy.schema');
const approvalRequestSchema=require('../schemas/ApprovalRequest.schema');
const bankReferenceSchema=require('../schemas/BankReference.schema');
const bankingRequestSchema=require('../schemas/BankingRequest.schema');
const forexRateSchema=require('../schemas/ForexRate.schema');
const forexQuoteSchema=require('../schemas/ForexQuote.schema');
const notificationTemplateSchema=require('../schemas/NotificationTemplate.schema');
const notificationMessageSchema=require('../schemas/NotificationMessage.schema');
const notificationPreferenceSchema=require('../schemas/NotificationPreference.schema');
const smsInboxSchema=require('../schemas/SmsInbox.schema');
const auditSchema = new mongoose.Schema({
  action: { type: String, required: true, immutable: true },
  actorId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  targetId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {}, immutable: true },
  createdAt: { type: Date, default: Date.now, immutable: true }
}, { strict: 'throw', versionKey: false });
auditSchema.index({ createdAt: -1 });
auditSchema.index({ 'metadata.branchId': 1, createdAt: -1 });
const model = (conn, name, schema) => conn.models[name] || conn.model(name, schema);
const initialized = new WeakMap();
function ensureTenantIndexes(conn) {
  if (!initialized.has(conn)) {
    const job = Promise.all([
      model(conn, 'SecureTenantUser',userSchema).createIndexes(),
      model(conn, 'SecureMobileTransaction',moneySchema).createIndexes(),
      model(conn, 'SecureAuditEvent',auditSchema).createIndexes(),
      model(conn, 'SecureStaffInvite', staffInviteSchema).createIndexes(),
      model(conn, 'SecureBranch', branchSchema).createIndexes(),
      model(conn, 'SecureCashSession', cashSessionSchema).createIndexes(),
      model(conn,'TransferContactV1',transferContactSchema).createIndexes(),
      model(conn,'TransferOrderV1',transferOrderSchema).createIndexes(),
      model(conn,'BankReferenceV1',bankReferenceSchema).createIndexes(),
      model(conn,'BankingRequestV1',bankingRequestSchema).createIndexes(),
      model(conn,'ForexRateV1',forexRateSchema).createIndexes(),
      model(conn,'ForexQuoteV1',forexQuoteSchema).createIndexes(),
      model(conn,'ApprovalPolicyV1',approvalPolicySchema).createIndexes(),
      model(conn,'ApprovalRequestV1',approvalRequestSchema).createIndexes(),
      model(conn,'NotificationTemplateV1',notificationTemplateSchema).createIndexes(),
      model(conn,'NotificationMessageV1',notificationMessageSchema).createIndexes(),
      model(conn,'NotificationPreferenceV1',notificationPreferenceSchema).createIndexes(),
      model(conn,'SmsInboxV1',smsInboxSchema).createIndexes(),
      model(conn, 'LedgerAccountV2', ledgerSchemas.account).createIndexes(),
      model(conn, 'LedgerJournalV2', ledgerSchemas.journal).createIndexes(),
      model(conn, 'LedgerPostingV2', ledgerSchemas.posting).createIndexes(),
      model(conn, 'FinancialOperationV1', financialSchemas.operation).createIndexes(),
      model(conn, 'VerifiedFinancialEvidenceV1', financialSchemas.evidence).createIndexes(),
      model(conn, 'FinancialExceptionV1', financialSchemas.exception).createIndexes()
    ]).catch(err => { initialized.delete(conn); throw err; });
    initialized.set(conn, job);
  }
  return initialized.get(conn);
}
module.exports = {
  tenantUserModel: conn => model(conn, 'SecureTenantUser', userSchema),
  mobileTransactionModel: conn => model(conn, 'SecureMobileTransaction', moneySchema),
  auditEventModel: conn => model(conn, 'SecureAuditEvent', auditSchema),
  staffInviteModel: conn => model(conn, 'SecureStaffInvite', staffInviteSchema),
  branchModel: conn => model(conn, 'SecureBranch', branchSchema),
  cashSessionModel: conn => model(conn, 'SecureCashSession', cashSessionSchema),
  transferContactModel: conn=>model(conn,'TransferContactV1',transferContactSchema),
  transferOrderModel: conn=>model(conn,'TransferOrderV1',transferOrderSchema),
  bankReferenceModel: conn=>model(conn,'BankReferenceV1',bankReferenceSchema),
  bankingRequestModel: conn=>model(conn,'BankingRequestV1',bankingRequestSchema),
  forexRateModel: conn=>model(conn,'ForexRateV1',forexRateSchema),
  forexQuoteModel: conn=>model(conn,'ForexQuoteV1',forexQuoteSchema),
  approvalPolicyModel: conn=>model(conn,'ApprovalPolicyV1',approvalPolicySchema),
  approvalRequestModel: conn=>model(conn,'ApprovalRequestV1',approvalRequestSchema),
  notificationTemplateModel: conn=>model(conn,'NotificationTemplateV1',notificationTemplateSchema),
  notificationMessageModel: conn=>model(conn,'NotificationMessageV1',notificationMessageSchema),
  notificationPreferenceModel: conn=>model(conn,'NotificationPreferenceV1',notificationPreferenceSchema),
  smsInboxModel:conn=>model(conn,'SmsInboxV1',smsInboxSchema),
  ledgerAccountModel: conn => model(conn, 'LedgerAccountV2', ledgerSchemas.account),
  ledgerJournalModel: conn => model(conn, 'LedgerJournalV2', ledgerSchemas.journal),
  ledgerPostingModel: conn => model(conn, 'LedgerPostingV2', ledgerSchemas.posting),
  financialOperationModel: conn => model(conn, 'FinancialOperationV1', financialSchemas.operation),
  financialEvidenceModel: conn => model(conn, 'VerifiedFinancialEvidenceV1', financialSchemas.evidence),
  financialExceptionModel: conn => model(conn, 'FinancialExceptionV1', financialSchemas.exception),
  ensureTenantIndexes
};
