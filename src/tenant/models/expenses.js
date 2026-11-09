'use strict';
const {ensureModelIndexes}=require('../../config/ensureModelIndexes');
const schema=require('./Expense');
function expenseModel(conn){return conn.models.ExpenseV1||conn.model('ExpenseV1',schema);}
const pending=new WeakMap();
async function ensureExpenseIndexes(conn){
 if(!pending.has(conn))pending.set(conn,ensureModelIndexes(expenseModel(conn)).catch(error=>{pending.delete(conn);throw error;}));
 return pending.get(conn);
}
module.exports={expenseModel,ensureExpenseIndexes};
