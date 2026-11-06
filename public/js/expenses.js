'use strict';
document.addEventListener('DOMContentLoaded',()=>{
 const dialog=document.getElementById('expenseDialog');if(!dialog)return;
 let opener=null;
 const open=()=>{
  if(typeof dialog.showModal!=='function')return;
  opener=document.activeElement;if(dialog.open)dialog.close();dialog.showModal();dialog.querySelector('[name="expenseType"]')?.focus();
 };
 document.querySelectorAll('[data-expense-open]').forEach(trigger=>trigger.addEventListener('click',event=>{
  if(typeof dialog.showModal!=='function')return;event.preventDefault();open();
 }));
 dialog.querySelectorAll('[data-expense-close]').forEach(trigger=>trigger.addEventListener('click',()=>dialog.close()));
 dialog.addEventListener('close',()=>{opener?.focus();});
 dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const bounds=dialog.getBoundingClientRect();
  if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)dialog.close();});
 if(dialog.open&&typeof dialog.showModal==='function')open();
});
