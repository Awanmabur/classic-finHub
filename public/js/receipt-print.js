'use strict';
(()=>{
 const receipt=document.querySelector('.receipt');
 if(!receipt)return;
 const width=document.getElementById('receiptPaperWidth');
 const automatic=document.getElementById('receiptAutoPrintToggle');
 const notice=document.getElementById('receiptPrintStatus');
 const read=key=>{try{return localStorage.getItem(key);}catch{return null;}};
 const write=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
 const paperKey='classicfin.receipt.paper.v1',autoKey='classicfin.receipt.auto.v1';
 const initialWidth=read(paperKey);
 const paper=initialWidth==='58'||initialWidth==='80'?initialWidth:'80';
 document.body.dataset.receiptPaper=paper;
 if(width){width.value=paper;width.addEventListener('change',()=>{
  const v=width.value==='58'?'58':'80';
  document.body.dataset.receiptPaper=v;write(paperKey,v);
 });}
 const enabled=read(autoKey)!=='off';
 if(automatic){automatic.checked=enabled;automatic.addEventListener('change',()=>write(autoKey,automatic.checked?'on':'off'));}
 for(const id of ['printAcknowledgement','printRequest']){
  document.getElementById(id)?.addEventListener('click',()=>window.print());
 }
 // A receipt is automatically offered only following a confirmed, posted POST.
 // The server chooses autoPrint; manually opened pages never trigger it.
 if(document.body.dataset.receiptAuto!=='true'||!enabled)return;
 const once='classicfin.receipt.printed-once.v1:'+location.pathname;
 try{
  if(sessionStorage.getItem(once)==='1')return;
  sessionStorage.setItem(once,'1');
 }catch{}
 try{
  const url=new URL(location.href);
  if(url.searchParams.get('autoPrint')==='1'){
   url.searchParams.delete('autoPrint');
   history.replaceState(null,'',url.pathname+url.search+url.hash);
  }
 }catch{}
 if(notice)notice.textContent='Opening the print sheet. Select your connected receipt printer. If the sheet does not open, use Print receipt.';
 const start=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>window.print()));
 if(document.readyState==='complete')start();
 else addEventListener('load',start,{once:true});
})();