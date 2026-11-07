#!/usr/bin/env node
'use strict';
// Optional documentation tooling: install Playwright separately from the app.
const path=require('node:path');
const fs=require('node:fs/promises');
const {chromium}=require('playwright');
async function main(){
 const directory=path.resolve(__dirname,'../../docs/operations');
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 try{
  const page=await browser.newPage();
  await page.setContent(await fs.readFile(path.join(directory,'OPERATIONS_MANUAL.html'),'utf8'),{waitUntil:'load'});
  await page.pdf({path:path.join(directory,'OPERATIONS_MANUAL.pdf'),format:'A4',printBackground:true,tagged:true,outline:true,displayHeaderFooter:true,headerTemplate:'<span></span>',footerTemplate:'<div style="width:100%;text-align:center;font:8px Arial;color:#566170">ClassicFin Hub operations manual · Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',margin:{top:'18mm',bottom:'20mm',left:'17mm',right:'17mm'}});
  console.log('Built docs/operations/OPERATIONS_MANUAL.pdf');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
