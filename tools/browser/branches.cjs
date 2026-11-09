// Real branch-directory regression against disposable loopback MongoDB only.
'use strict';
const path=require('node:path'),req=require('node:module').createRequire(path.resolve(process.cwd(),'package.json'));
const crypto=require('node:crypto'),assert=require('node:assert/strict'),fs=require('node:fs');
const nonce=crypto.randomBytes(7).toString('hex'),scratch='cfh_branches_browser_'+nonce,slug='branches-browser-'+nonce;
Object.assign(process.env,{NODE_ENV:'test',MFA_ENABLED:'false',MFA_ENCRYPTION_KEY:'',APP_URL:'http://localhost:3000',RESEND_API_KEY:'',MAIL_FROM:'',TRANSFER_SMS_PROVIDER:'none',TENANT_BACKUPS_ENABLED:'false',
  MONGO_PLATFORM_URI:'mongodb://127.0.0.1:27018/'+scratch+'?replicaSet=rs0&directConnection=true'});
delete process.env.PLATFORM_DB_URI;delete process.env.MONGO_URI_BASE;
const mongoose=req('mongoose'),bcrypt=req('bcryptjs'),{chromium}=req('playwright'),mongo=req('./src/config/mongo');
const core=req('./src/tenant/models'),Tenant=req('./src/platform/models/Tenant'),Identity=req('./src/platform/models/AccountIdentity'),commerce=req('./src/platform/services/commercial.service');
const out=path.resolve(process.env.BROWSER_REVIEW_DIR||'/tmp/classicfin-branches-browser');fs.mkdirSync(out,{recursive:true});
const result={browserErrors:[],resourceErrors:[],layouts:[],operations:{}};let browser,server,conn,page;
async function navigate(base){const response=await page.goto(base+'/tenant/branches');assert.equal(response.status(),200);await page.evaluate(()=>document.fonts.ready);}
async function capture(name){
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});
    // The approved mobile drawer animates when the media query changes. Capture
    // its settled closed position rather than an intermediate resize frame.
    await page.waitForFunction(()=>innerWidth>1120||document.querySelector('#sidePanel')?.getBoundingClientRect().right<=0);
    const data=await page.evaluate(()=>{
      const ids=[...document.querySelectorAll('[id]')].map(e=>e.id),rows=[...document.querySelectorAll('.branchRow')];
      const dialog=document.querySelector('.branchDialog[open]'),bounds=dialog?.getBoundingClientRect();
      return {overflow:document.documentElement.scrollWidth>innerWidth,duplicateIds:ids.filter((id,i)=>ids.indexOf(id)!==i),
        mobileDrawerClosed:innerWidth>1120||(!document.querySelector('#sidePanel').classList.contains('show')&&document.querySelector('#sidePanel').getBoundingClientRect().right<=0),
        rowHeights:rows.map(row=>Math.round(row.getBoundingClientRect().height)),
        dialogInside:!bounds||(bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight),
        formOverflow:!!dialog&&dialog.scrollWidth>dialog.clientWidth,
        approvedDialogFrame:!dialog||getComputedStyle(dialog).borderTopWidth==='0px'};
    });
    assert.equal(data.overflow,false,name+' viewport overflow '+width);assert.deepEqual(data.duplicateIds,[],name+' duplicate IDs');
    assert.equal(data.mobileDrawerClosed,true,name+' mobile drawer remains in viewport '+width);
    assert.equal(data.dialogInside,true,name+' dialog outside viewport '+width);assert.equal(data.formOverflow,false,name+' dialog overflow '+width);
    assert.equal(data.approvedDialogFrame,true,name+' unstyled native dialog frame '+width);
    if(name==='branch-directory')assert(data.rowHeights.every(height=>height<=65),'Branch rows should stay on a single compact line');
    result.layouts.push({name,width,...data});await page.screenshot({path:path.join(out,name+'-'+width+'.png'),fullPage:false});
  }
  await page.setViewportSize({width:1440,height:1000});
}
async function login(base,email,password){await page.goto(base+'/signin');await page.locator('[name=email]').fill(email);await page.locator('[name=password]').fill(password);await Promise.all([page.waitForURL('**/tenant/dashboard'),page.locator('form[action="/signin"] button[type=submit]').click()]);}
async function main(){
  await mongo.connectPlatformMongo();await Promise.all([Tenant.createIndexes(),Identity.createIndexes()]);
  const modules=['mobile_money','money_transfer','reports'];
  const version={...commerce.asPlanVersion({...req('./src/data/store').plans.find(p=>p.code==='enterprise'),code:'branches_browser',modules}),status:'published'},terms=commerce.planSnapshot(version);
  const tenant=await Tenant.create({name:'Branch Directory Review',slug,dbName:mongo.tenantDbNameFromSlug(slug),owner:'Owner',email:'owner-'+nonce+'@example.invalid',plan:'branches_browser',status:'active',setupStatus:'complete',enabledModules:modules,seatsReserved:2,branchCount:5,
    subscription:{...terms,status:'granted',source:'manual_admin_grant',generation:1,periodStart:new Date(Date.now()-10000),periodEnd:new Date(Date.now()+86400000)}});
  conn=mongo.getTenantConnection(slug);await core.ensureTenantIndexes(conn);
  const ownerId=new mongoose.Types.ObjectId(),managerId=new mongoose.Types.ObjectId(),Branch=core.branchModel(conn);
  const branchNames=['Main Branch','Juba Market Road Financial Services Centre with a long name','Kampala Central','Wau Office','Nimule Border','Archived Office'];
  const branches=[];for(const [index,name] of branchNames.entries())branches.push(await Branch.create({name,code:'office-'+index,currency:'UGX',currencies:['UGX','USD','SSP','KES'],address:'Business address '+index+' with additional details kept available in the branch dialog',status:index===5?'archived':'active',createdBy:ownerId,updatedBy:ownerId}));
  const password='Branch-Review-'+nonce+'#9a',passwordHash=await bcrypt.hash(password,10),users=[];
  for(const [id,role,name,email] of [[ownerId,'Tenant Owner','Workspace Owner',tenant.email],[managerId,'Branch Manager','Branch Manager','manager-'+nonce+'@example.invalid']]){
    const user=await core.tenantUserModel(conn).create({_id:id,name,email,passwordHash,role,branchId:String(branches[0]._id),allowedModules:modules,status:'active',authVersion:0});
    await Identity.create({email,kind:'tenant',tenantId:tenant._id,accountId:id});users.push(user);
  }
  server=await new Promise(resolve=>{const s=req('./src/app')().listen(0,()=>resolve(s));});const base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();
  page.on('pageerror',e=>result.browserErrors.push(e.message));page.on('response',r=>{if(r.status()>=400&&/\.(?:css|js|woff2?|png)(?:\?|$)/.test(r.url()))result.resourceErrors.push({path:new URL(r.url()).pathname,status:r.status()});});
  await login(base,users[0].email,password);await navigate(base);assert.equal(await page.locator('[data-branch-row]').count(),6);
  assert.equal(await page.locator('.branchRow input:not([type=hidden]),.branchRow select').count(),0);await capture('branch-directory');
  // The shared edit dialog is populated with the exact row, including values truncated in the list.
  let row=page.locator('[data-branch-id="'+branches[1]._id+'"]');await row.locator('[data-branch-edit]').click();
  let dialog=page.locator('#branchEditDialog'),form=dialog.locator('form');
  assert.equal(await form.getAttribute('action'),'/tenant/branches/'+branches[1]._id+'/update');assert.equal(await form.locator('[name=name]').inputValue(),branchNames[1]);
  assert.equal(await page.evaluate(()=>document.activeElement.name),'name');await capture('edit-branch');
  await form.locator('[name=name]').fill('Juba Market Branch');await form.locator('[name=address]').fill('Juba Main Market');
  await form.locator('[name=currencies][value=UGX]').uncheck();await dialog.getByRole('button',{name:'Save changes',exact:true}).click();
  await form.locator('[data-branch-form-status]').filter({hasText:'Keep the immutable default currency enabled'}).waitFor();
  assert.equal(await form.locator('[name=name]').inputValue(),'Juba Market Branch');assert.equal(await dialog.getByRole('button',{name:'Save changes',exact:true}).isEnabled(),true);
  assert.equal((await Branch.findById(branches[1]._id).lean()).name,branchNames[1]);result.operations.currencyGuardRetainsDraft=true;
  await form.locator('[name=currencies][value=UGX]').check();
  await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Save changes',exact:true}).click()]);
  assert.equal((await Branch.findById(branches[1]._id).lean()).name,'Juba Market Branch');result.operations.edit=true;
  // An interrupted write keeps the entered values and restores the submit button.
  row=page.locator('[data-branch-id="'+branches[1]._id+'"]');await row.locator('[data-branch-edit]').click();dialog=page.locator('#branchEditDialog');form=dialog.locator('form');
  await form.locator('[name=address]').fill('Unsaved connection draft');
  await context.route('**/tenant/branches/'+branches[1]._id+'/update',route=>route.abort());await dialog.getByRole('button',{name:'Save changes',exact:true}).click();
  await form.locator('[data-branch-form-status]').filter({hasText:'Connection interrupted'}).waitFor();assert.equal(await form.locator('[name=address]').inputValue(),'Unsaved connection draft');
  assert.equal(await dialog.getByRole('button',{name:'Save changes',exact:true}).isEnabled(),true);await context.unroute('**/tenant/branches/'+branches[1]._id+'/update');
  await page.keyboard.press('Escape');assert.equal(await row.locator('[data-branch-edit]').evaluate(el=>document.activeElement===el),true);result.operations.interruptedWriteRetainsDraft=true;
  // Archive restrictions remain server-side and appear within the affected row.
  row=page.locator('[data-branch-id="'+branches[0]._id+'"]');await row.getByRole('button',{name:'Archive Main Branch',exact:true}).click();
  await row.locator('[data-branch-row-status]').filter({hasText:'Reassign staff'}).waitFor();assert.equal((await Branch.findById(branches[0]._id).lean()).status,'active');result.operations.assignedStaffArchiveGuard=true;
  await navigate(base);row=page.locator('[data-branch-id="'+branches[3]._id+'"]');await Promise.all([page.waitForNavigation(),row.locator('form[action$="/archive"] button').click()]);
  assert.equal((await Branch.findById(branches[3]._id).lean()).status,'archived');row=page.locator('[data-branch-id="'+branches[3]._id+'"]');
  await Promise.all([page.waitForNavigation(),row.locator('form[action$="/restore"] button').click()]);assert.equal((await Branch.findById(branches[3]._id).lean()).status,'active');result.operations.archiveRestore=true;
  // New branches and operating location changes use the original CSRF-protected routes.
  await page.locator('[data-branch-open=branchCreateDialog]').click();dialog=page.locator('#branchCreateDialog');form=dialog.locator('form');
  assert.equal(await page.evaluate(()=>document.activeElement.name),'name');await capture('create-branch');
  await form.locator('[name=name]').fill('New Operations Office');await form.locator('[name=code]').fill('new-office');await form.locator('[name=address]').fill('New business location');
  await Promise.all([page.waitForNavigation(),dialog.getByRole('button',{name:'Create branch',exact:true}).click()]);
  const created=await Branch.findOne({code:'new-office'}).lean();assert(created);assert.deepEqual(created.currencies,['UGX','USD','SSP','KES']);assert.equal((await Tenant.findById(tenant._id).lean()).branchCount,6);result.operations.create=true;
  await page.locator('form[action="/tenant/branches/operating"] select').selectOption(String(created._id));await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save account location'}).click()]);
  assert.equal((await core.tenantUserModel(conn).findById(ownerId).lean()).branchId,String(created._id));result.operations.operatingBranch=true;
  row=page.locator('[data-branch-id="'+branches[5]._id+'"]');await row.locator('[data-branch-details]').click();assert.equal(await page.locator('[data-branch-detail=address]').innerText(),branches[5].address);await capture('branch-details');
  await page.keyboard.press('Escape');await context.clearCookies();await login(base,users[1].email,password);await navigate(base);
  assert.equal(await page.locator('[data-branch-row]').count(),1);assert.equal(await page.locator('[data-branch-open],[data-branch-edit],.branchRow form').count(),0);
  await page.locator('[data-branch-details]').click();assert.equal(await page.locator('[data-branch-detail=name]').innerText(),'Main Branch');result.operations.branchManagerReadOnly=true;
  assert.deepEqual(result.browserErrors,[]);assert.deepEqual(result.resourceErrors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log('PASS '+JSON.stringify(result));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  if(conn&&mongoose.connection.name===scratch&&/^cfh_branches_browser_[a-f0-9]{14}$/.test(scratch)&&conn.name===mongo.tenantDbNameFromSlug(slug)){
    await conn.db.dropDatabase();await mongoose.connection.db.dropDatabase();
  }
  await mongoose.disconnect();
});
