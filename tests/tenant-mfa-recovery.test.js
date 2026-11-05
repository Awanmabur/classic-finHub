'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { checkedEnvironment, readProtectedPassword }=require('../scripts/tenant-mfa-recover');
const cfg={MFA_TENANT_RECOVERY_ADMIN_EMAIL:'super@example.com',MFA_TENANT_RECOVERY_TARGET_EMAIL:'owner@example.com',
  MFA_TENANT_RECOVERY_CASE:'CFH-SEC-20261103',MFA_TENANT_RECOVERY_CONFIRM:'RESET TENANT MFA FOR owner@example.com'};
test('tenant MFA break-glass refuses missing approval, circular identities or undocumented cases',()=>{
  assert.deepEqual(checkedEnvironment(cfg),{adminEmail:'super@example.com',targetEmail:'owner@example.com',caseId:'CFH-SEC-20261103'});
  assert.throws(()=>checkedEnvironment({...cfg,MFA_TENANT_RECOVERY_CONFIRM:'YES'}));
  assert.throws(()=>checkedEnvironment({...cfg,MFA_TENANT_RECOVERY_ADMIN_EMAIL:'owner@example.com'}));
  assert.throws(()=>checkedEnvironment({...cfg,MFA_TENANT_RECOVERY_CASE:'bad'}));
});
test('tenant MFA recovery requires a protected regular secret file',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cfh-recover-'));
  const secret=path.join(dir,'private');
  try{
    fs.writeFileSync(secret,'testing-only\n',{mode:0o600});
    assert.equal(readProtectedPassword(secret),'testing-only');
    if(process.platform!=='win32'){
      fs.chmodSync(secret,0o644);
      assert.throws(()=>readProtectedPassword(secret),/owner-only/);
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
