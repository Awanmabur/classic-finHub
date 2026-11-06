'use strict';
const {Schema}=require('mongoose');
const {currencyCodes}=require('../../config/currencies');
const O=Schema.Types.ObjectId;
const common={branchId:{type:O,required:true,immutable:true},createdBy:{type:O,required:true,immutable:true},updatedBy:{type:O,required:true},revision:{type:Number,default:0,min:0}};
const customerSchema=new Schema({
 ...common,reference:{type:String,required:true,immutable:true},idempotencyKey:{type:String,required:true,immutable:true},
 name:{type:String,required:true,maxlength:120},normalizedName:{type:String,required:true,maxlength:120},phone:{type:String,required:true,maxlength:16},
 email:{type:String,default:'',maxlength:254},identityNumber:{type:String,default:'',maxlength:60},type:{type:String,enum:['Individual','Business','Agent'],required:true},
 nextOfKinName:{type:String,default:'',maxlength:120},nextOfKinPhone:{type:String,default:'',maxlength:16},relationship:{type:String,default:'',maxlength:60},
 country:{type:String,default:'',maxlength:80},city:{type:String,default:'',maxlength:100},note:{type:String,default:'',maxlength:500},
 status:{type:String,enum:['active','archived'],default:'active'},archivedAt:{type:Date,default:null}
},{timestamps:true,strict:'throw',versionKey:false});
customerSchema.index({reference:1},{unique:true});customerSchema.index({idempotencyKey:1},{unique:true});
customerSchema.index({branchId:1,createdAt:-1,_id:-1});customerSchema.index({branchId:1,status:1,normalizedName:1});customerSchema.index({branchId:1,phone:1});
const accountSchema=new Schema({
 ...common,customerId:{type:O,required:true,immutable:true},accountNumber:{type:String,required:true,immutable:true},idempotencyKey:{type:String,required:true,immutable:true},
 type:{type:String,enum:['Current Account','Savings Account','Agent Account','Business Account'],required:true},
 currency:{type:String,enum:currencyCodes,required:true,immutable:true},ledgerAccountId:{type:O,required:true,immutable:true},
 status:{type:String,enum:['active','pending','suspended','closed'],required:true,default:'active'},
 officer:{type:String,default:'',maxlength:120},purpose:{type:String,default:'',maxlength:240},risk:{type:String,enum:['Low','Medium','High'],required:true,default:'Low'}
},{timestamps:true,strict:'throw',versionKey:false});
accountSchema.index({accountNumber:1},{unique:true});accountSchema.index({idempotencyKey:1},{unique:true});accountSchema.index({ledgerAccountId:1},{unique:true});
accountSchema.index({branchId:1,createdAt:-1,_id:-1});accountSchema.index({branchId:1,customerId:1,status:1});
const model=(conn,name,schema)=>conn.models[name]||conn.model(name,schema);
const customerModel=conn=>model(conn,'CustomerDirectoryV1',customerSchema),accountModel=conn=>model(conn,'CustomerAccountV1',accountSchema);
const ready=new WeakMap();
function ensureIndexes(conn){if(!ready.has(conn))ready.set(conn,Promise.all([customerModel(conn).createIndexes(),accountModel(conn).createIndexes()]).catch(e=>{ready.delete(conn);throw e;}));return ready.get(conn);}
module.exports={customerModel,accountModel,ensureIndexes,customerSchema,accountSchema};
