/* global indexedDB, crypto */
'use strict';
(() => {
  if (!('indexedDB' in window) || !crypto.subtle) return;
  const bootstrap = document.body.hasAttribute('data-offline-bootstrap');
  const initialHTML = document.documentElement.outerHTML;
  const routes = new Set(['/tenant/mobile-money/cash-in', '/tenant/mobile-money/cash-out', '/tenant/money-transfer/requests', '/tenant/banking/requests', '/tenant/forex/quotes', '/tenant/expenses']);
  const operationPages = Object.freeze({cash_in: '/tenant/mobile-money/cash-in', cash_out: '/tenant/mobile-money/cash-out', transfer: '/tenant/money-transfer/send', payout: '/tenant/funded/payout', banking_deposit: '/tenant/banking/deposit', banking_withdrawal: '/tenant/banking/withdraw', banking_transfer: '/tenant/banking/transfer', forex_buy: '/tenant/forex/buy', forex_sell: '/tenant/forex/sell', expense: '/tenant/expenses/new', customer: '/tenant/customers/new', account: '/tenant/accounts/new', approval: '/tenant/approvals', cash_shift_open: '/tenant/cash/shifts', cash_shift_close: '/tenant/day/close'});
  const scopeKey = 'classicfin.offline.scope', viewKey = 'classicfin.offline.view', authKey = 'classicfin.offline.auth', currencyKey = 'classicfin.offline.currency';
  const scripts = ['/js/offline.js', '/js/dashboard.js', '/js/customer-accounts.js', '/js/expenses.js', '/js/workspace.js'];
  const nativeFetch = window.fetch.bind(window);
  let context, key, scope, db, initializing, locked = false, preparing = false, ready = false, lastMessage = '';
  const submitting = new WeakSet();
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  function status(message) { lastMessage = message; const target = document.getElementById('offlineStatus'); if (target) target.textContent = message; }
  function lock() { locked = true; sessionStorage.removeItem(scopeKey); sessionStorage.removeItem(viewKey); context = null; scope = null; key = null; }
  function announce(value) { try { localStorage.setItem(authKey, JSON.stringify({scope: value, nonce: crypto.randomUUID()})); } catch { /* Private-browser storage can be unavailable. */ } }
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('classicfin-offline-v1', 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('keys'); request.result.createObjectStore('entries', {keyPath: 'id'}); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  function store(name, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode), request = work(tx.objectStore(name));
      tx.oncomplete = () => resolve(request?.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || Error('Local storage aborted'));
    });
  }
  const read = id => store('entries', 'readonly', object => object.get(id));
  const remove = id => store('entries', 'readwrite', object => object.delete(id));
  async function encrypt(value, boundScope = scope, boundKey = key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return {iv, body: await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(boundScope)}, boundKey, new TextEncoder().encode(JSON.stringify(value)))};
  }
  async function decrypt(row) {
    const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: row.iv, additionalData: new TextEncoder().encode(scope)}, key, row.body);
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function save(id, value) { const boundScope = scope, encrypted = await encrypt(value); await store('entries', 'readwrite', object => object.put({id, scope: boundScope, ...encrypted})); }
  async function all(type) {
    const rows = await store('entries', 'readonly', object => object.getAll()), result = [];
    for (const row of rows.filter(item => item.scope === scope && (!type || item.id.startsWith(scope + ':' + type + ':')))) {
      try { result.push({id: row.id, ...await decrypt(row)}); } catch { status('A saved item could not be opened. Contact your administrator before clearing this device.'); }
    }
    return result;
  }
  async function serverContext() {
    const response = await nativeFetch('/tenant/offline/context', {cache: 'no-store', credentials: 'same-origin', headers: {Accept: 'application/json'}, redirect: 'manual'});
    if (response.status === 429 || response.status >= 500) throw Error('The server is temporarily unavailable.');
    if (locked || !response.ok || !response.headers.get('content-type')?.includes('application/json')) throw Object.assign(Error('Sign in again to sync.'), {code: 'AUTH_DENIED'});
    const value = await response.json(); if (!/^[a-f0-9]{64}$/.test(value.scope) || !value.csrfToken) throw Object.assign(Error('Sign in again to sync.'), {code: 'AUTH_DENIED'}); return value;
  }
  async function initialize() {
    if (locked) return false;
    if (context && context.expiresAt < Date.now()) { lock(); status('Reconnect and sign in to unlock this workspace.'); return false; }
    if (initializing) return initializing;
    initializing = (async () => {
      db = await open(); let fresh;
      if (navigator.onLine) {
        try { fresh = await serverContext(); }
        catch (error) { if (error.code === 'AUTH_DENIED') { lock(); announce(null); status('Reconnect and sign in to unlock this workspace.'); if (!bootstrap) location.replace('/signin'); return false; } if (!bootstrap && !document.body.hasAttribute('data-offline-snapshot')) { status(error.message); return false; } }
      }
      if (locked) return false;
      if (fresh && !bootstrap && (document.body.dataset.offlineScope !== fresh.scope || document.body.dataset.offlineBranch !== fresh.branchId)) { lock(); status('Your account changed. Reload this workspace before using offline access.'); return false; }
      scope = fresh?.scope || sessionStorage.getItem(scopeKey); if (!scope) return false;
      key = await store('keys', 'readonly', object => object.get(scope));
      if (locked) return false;
      if (!key && fresh) { key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']); await store('keys', 'readwrite', object => object.put(key, scope)); }
      if (!key) return false;
      sessionStorage.setItem(scopeKey, scope);
      if (fresh) { context = fresh; const saved = {...fresh}; delete saved.csrfToken; await save(scope + ':context', saved); if (locked) return false; sessionStorage.setItem(viewKey, fresh.viewBranchId); const currency = document.getElementById('currencySelect')?.value; if (currency) sessionStorage.setItem(currencyKey, currency); announce(scope); }
      else { const row = await read(scope + ':context'); if (row) context = await decrypt(row); }
      if (!context || context.expiresAt < Date.now()) { status('Reconnect and sign in to unlock this workspace.'); return false; }
      return true;
    })().catch(() => { status('Device storage is unavailable. Reconnect before submitting.'); return false; });
    return initializing;
  }
  function pageURL(value) {
    const url = new URL(value, location.origin);
    if (url.pathname === '/tenant') url.pathname = '/tenant/dashboard';
    if (url.origin !== location.origin || !url.pathname.startsWith('/tenant/') || /\.(?:csv|pdf|css)$|\/(?:google|archives|acknowledgement|reveal-pin|secret|callback|export|last-receipt)(?:\/|$)/i.test(url.pathname) || /(?:token|secret|code|pin|key)/i.test([...url.searchParams.keys()].join(' '))) return null;
    url.hash = ''; url.searchParams.sort(); return url.pathname + url.search;
  }
  const currentView = () => sessionStorage.getItem(viewKey) || context?.viewBranchId || context?.branchId || '';
  async function pageId(url, view = currentView()) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(view + '\n' + url));
    return scope + ':page:' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function cleanPage(html) {
    if (html.length > 1000000) return null;
    const page = new DOMParser().parseFromString(html, 'text/html');
    if (page.body.dataset.workspace !== 'tenant' || page.body.dataset.offlineCacheable !== 'true' || page.body.dataset.offlineScope !== scope || page.body.dataset.offlineBranch !== context.branchId) return null;
    // Never persist transient credentials, CSRF tokens, one-time handoffs or live modal input.
    page.querySelectorAll('[data-session-flash],[data-private-once],[data-offline-runtime],iframe,object,embed').forEach(el => el.remove());
    page.querySelectorAll('input[name="_csrf"],input[name="idempotencyKey"],input[type="password"]').forEach(el => el.setAttribute('value', ''));
    page.querySelectorAll('script').forEach(el => { const path = new URL(el.src || '/', location.origin); if (path.origin !== location.origin || !scripts.includes(path.pathname)) el.remove(); });
    page.querySelectorAll('[onload],[onclick],[onerror]').forEach(el => { for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name); });
    page.querySelector('[data-transaction-form]')?.replaceChildren();
    page.querySelectorAll('dialog[open]').forEach(el => el.removeAttribute('open'));
    page.body.classList.remove('transactionOpen');
    return '<!doctype html>\n' + page.documentElement.outerHTML;
  }
  async function rememberPage(url, html) {
    const path = pageURL(url); if (!path || !context || locked) return;
    const safe = cleanPage(html); if (!safe) return;
    const view = new DOMParser().parseFromString(safe, 'text/html').body.dataset.offlineView;
    await save(await pageId(path, view), {type: 'page', url: path, view, branchId: context.branchId, savedAt: Date.now(), html: safe});
  }
  async function savedPage(value, view = currentView()) {
    const path = pageURL(value); if (!path) return null;
    let row = await read(await pageId(path, view));
    if (!row && !new URL(path, location.origin).searchParams.has('currency')) { const url = new URL(path, location.origin), currency = sessionStorage.getItem(currencyKey); if (currency) { url.searchParams.set('currency', currency); row = await read(await pageId(pageURL(url), view)); } }
    if (!row) return null;
    const page = await decrypt(row);
    return page.branchId === context.branchId && page.savedAt + 7 * 86400000 > Date.now() ? page : null;
  }
  async function freshPageHTML(page) {
    const dom = new DOMParser().parseFromString(page.html, 'text/html');
    dom.body.dataset.offlineSnapshot = String(page.savedAt);
    dom.querySelectorAll('input[name="idempotencyKey"]').forEach(el => el.setAttribute('value', crypto.randomUUID()));
    dom.querySelectorAll('input[name="_csrf"]').forEach(el => el.setAttribute('value', context.csrfToken || ''));
    dom.querySelectorAll('link[href^="/tenant/workspace/theme.css"]').forEach(el => el.remove());
    const theme = await read(scope + ':theme');
    if (theme) { const style = dom.createElement('style'); style.textContent = (await decrypt(theme)).css; dom.head.append(style); }
    return '<!doctype html>\n' + dom.documentElement.outerHTML;
  }
  async function restore() {
    if (!await initialize()) { status('Reconnect and sign in on this device to open your workspace.'); return; }
    // Old bookmarks open the normal dashboard; there is no second offline application.
    const target = location.pathname === '/offline.html' ? '/tenant/dashboard' : location.href;
    const page = await savedPage(target);
    if (!page) {
      status('This page has not been saved on this device. Reconnect to load it.');
      const pages = (await all('page')).filter(row => row.view === currentView());
      const holder = document.querySelector('main');
      for (const saved of pages.slice(0, 12)) { const dom = new DOMParser().parseFromString(saved.html, 'text/html'), link = node('a', dom.querySelector('#pageTitle')?.textContent || 'Open saved page', 'btn'); link.href = saved.url; holder.append(link); }
      return;
    }
    if (location.pathname === '/offline.html') history.replaceState(null, '', page.url);
    document.open(); document.write(await freshPageHTML(page)); document.close();
  }
  async function pageResponse(value, options) {
    if (!await initialize()) return nativeFetch(value, options);
    if (navigator.onLine) {
      try { const response = await nativeFetch(value, options); if (response.ok && response.headers.get('content-type')?.includes('text/html')) { const html = await response.clone().text(), body = new DOMParser().parseFromString(html, 'text/html').body; if (body.dataset.workspace === 'tenant' && (body.dataset.offlineScope !== scope || body.dataset.offlineBranch !== context.branchId)) { lock(); announce(null); throw Object.assign(Error('Your account changed. Reload the workspace.'), {code: 'AUTH_DENIED'}); } await rememberPage(response.url, html); } return response; }
      catch (error) { if (error.name === 'AbortError' || error.code === 'AUTH_DENIED') throw error; }
    }
    const page = await savedPage(value); if (!page) throw Error('This page is not available on this device yet. Reconnect to load it.');
    const response = new Response(await freshPageHTML(page), {headers: {'Content-Type': 'text/html', 'X-ClassicFin-Offline': 'true'}});
    Object.defineProperty(response, 'url', {value: new URL(page.url, location.origin).href}); return response;
  }
  function allowed(form) { const url = new URL(form.action, location.origin); return form.method.toLowerCase() === 'post' && routes.has(url.pathname) && url.origin === location.origin; }
  function operationLabel(action, form) {
    if (action === '/tenant/banking/requests') return ({deposit_request: 'Deposit', withdrawal_request: 'Withdraw', transfer_request: 'Account transfer'})[form.elements.namedItem('kind')?.value] || 'Banking request';
    if (action === '/tenant/forex/quotes') return ({buy: 'Buy forex from customer', sell: 'Sell forex to customer'})[form.elements.namedItem('operation')?.value] || 'Forex quotation';
    return ({'/tenant/mobile-money/cash-in': 'Cash-in', '/tenant/mobile-money/cash-out': 'Cash-out', '/tenant/money-transfer/requests': 'Send money', '/tenant/expenses': 'Expense'})[action] || 'Operation';
  }
  function rotateReference(form) { const identity = form.elements.namedItem('idempotencyKey'); if (identity) identity.value = identity.defaultValue = crypto.randomUUID(); }
  function resetForm(form) { form.reset(); rotateReference(form); queueMicrotask(() => form.dispatchEvent(new Event('change', {bubbles: true}))); }
  async function queue(form, reset = true) {
    if (!await initialize()) throw Error('Reconnect and sign in before using offline entry.');
    const values = {};
    for (const [name, value] of new FormData(form)) { if (typeof value !== 'string' || name === '_csrf') continue; if (Object.hasOwn(values, name)) throw Error('This form needs a connection.'); values[name] = value; }
    if (!values.idempotencyKey) values.idempotencyKey = crypto.randomUUID();
    if (JSON.stringify(values).length > 24000) throw Error('This entry is too large for offline capture.');
    const action = new URL(form.action, location.origin).pathname, id = scope + ':draft:' + values.idempotencyKey;
    const display = Object.entries(values).flatMap(([name, value]) => { const control = form.elements.namedItem(name); if (!value || name !== 'idempotencyKey' && control?.type === 'hidden') return []; return [{label: name === 'idempotencyKey' ? 'Local reference' : control?.closest('label')?.childNodes[0]?.textContent?.trim() || name.replace(/([a-z])([A-Z])/g, '$1 $2'), value: control?.tagName === 'SELECT' ? control.selectedOptions[0]?.textContent || value : value}]; });
    const draft = {type: 'draft', action, values, display, state: 'pending', capturedAt: Date.now(), phoneCountry: context.phoneCountry, branchId: context.branchId, label: operationLabel(action, form)};
    const boundScope = scope, encrypted = await encrypt(draft);
    try { await store('entries', 'readwrite', object => object.add({id, scope: boundScope, ...encrypted})); }
    catch (error) { const prior = await read(id); if (!prior) throw error; const old = await decrypt(prior); if (old.action !== action || JSON.stringify(old.values) !== JSON.stringify(values)) throw Error('This reference already belongs to a saved entry. Reopen the form for a new operation.'); }
    // A subsequent entry is a new instruction; repeating sync retains the original key.
    if (reset) resetForm(form);
    let notice = form.querySelector('[data-offline-saved]');
    if (!notice) { notice = node('p', undefined, 'tiny'); notice.dataset.offlineSaved = ''; notice.setAttribute('role', 'status'); form.prepend(notice); }
    notice.textContent = 'Saved offline — pending sync. Open Pending sync to review.';
    status('Saved on this device. Pending sync; no final receipt has been issued.'); await renderQueue(); await updateBar(); return id;
  }
  async function syncWork() {
    if (!await initialize()) return;
    status('Checking your account and syncing pending entries…');
    let fresh;
    try { fresh = await serverContext(); } catch { status('Reconnect and sign in to sync. Your entries remain on this device.'); return; }
    if (fresh.scope !== scope || fresh.branchId !== context.branchId) { status('Account or operating branch changed. Sign in with the original account and branch to review these entries.'); return; }
    context.csrfToken = fresh.csrfToken;
    for (const draft of (await all('draft')).filter(row => row.state === 'pending').sort((a, b) => a.capturedAt - b.capturedAt)) {
      if (draft.branchId !== fresh.branchId) { draft.state = 'needs_attention'; draft.problem = 'Operating branch changed. Review before entering this operation again.'; await save(draft.id, draft); continue; }
      let response;
      try { response = await nativeFetch(draft.action, {method: 'POST', credentials: 'same-origin', headers: {'Content-Type': 'application/x-www-form-urlencoded', 'x-csrf-token': fresh.csrfToken, 'x-classicfin-phone-country': draft.phoneCountry || context.phoneCountry || 'SS'}, body: new URLSearchParams({...draft.values, _csrf: fresh.csrfToken}), cache: 'no-store'}); }
      catch { status('Connection interrupted. Pending entries will retry with the same reference.'); break; }
      if (!new URL(response.url).pathname.startsWith('/tenant/') || [401, 403].includes(response.status)) { status('Sign in again or ask your administrator to review access. Entries remain pending.'); break; }
      if (response.ok) { await response.body?.cancel(); draft.state = 'synced'; draft.resultUrl = new URL(response.url).pathname; draft.syncedAt = Date.now(); delete draft.values; delete draft.display; }
      else if (response.status === 429 || response.status >= 500) { status('The server is busy. Pending entries will retry later.'); break; }
      else { const detail = response.headers.get('content-type')?.includes('text/plain') ? (await response.text()).slice(0, 400) : ''; draft.state = 'needs_attention'; draft.problem = `Server rejected this entry (HTTP ${response.status}). ${detail || 'Review balances, rates, references and required fields.'}`; }
      await save(draft.id, draft);
    }
    status('Sync checked. Only entries marked Synced were accepted by the server.'); await renderQueue(); await updateBar();
  }
  async function sync() { if (!navigator.onLine) { status('Reconnect to sync. Your entries remain on this device.'); return; } if (navigator.locks) return navigator.locks.request('classicfin-offline-sync', {ifAvailable: true}, lock => lock ? syncWork() : undefined); return syncWork(); }
  async function renderQueue() {
    const list = document.getElementById('offlineQueue'); if (!list || !context) return;
    list.replaceChildren();
    const drafts = (await all('draft')).sort((a, b) => b.capturedAt - a.capturedAt);
    if (!drafts.length) list.append(node('p', 'No pending entries on this device.', 'tiny'));
    for (const draft of drafts) {
      const card = node('article', undefined, 'reportBlock');
      card.append(node('strong', draft.label + ' — ' + ({pending: 'Pending sync', synced: 'Synced', needs_attention: 'Needs attention'}[draft.state])), node('p', new Date(draft.capturedAt).toLocaleString(), 'tiny'));
      if (draft.values) { const details = node('details'), facts = node('dl'); for (const field of draft.display || []) facts.append(node('dt', field.label), node('dd', field.value)); details.append(node('summary', 'Review captured details'), facts); card.append(details); }
      if (draft.problem) card.append(node('p', draft.problem));
      const buttons = node('div', undefined, 'rowBtns');
      if (draft.resultUrl) { const link = node('a', 'Open accepted record', 'btn'); link.href = draft.resultUrl; buttons.append(link); }
      const discard = node('button', draft.state === 'synced' ? 'Clear local status' : 'Discard local entry', 'btn'); discard.type = 'button';
      discard.addEventListener('click', async () => { if (draft.state !== 'synced' && !confirm('Discard this device entry? Check server records first if a submission may already have reached the server.')) return; await remove(draft.id); await renderQueue(); await updateBar(); }); buttons.append(discard); card.append(buttons); list.append(card);
    }
  }
  async function updateBar() {
    const target = document.querySelector('[data-offline-message]'); if (!target || !context) return;
    const pending = (await all('draft')).filter(row => row.state !== 'synced').length;
    target.textContent = (navigator.onLine ? 'Connected' : 'Offline') + (pending ? ' · ' + pending + ' pending' : '') + (preparing ? ' · Preparing pages…' : '');
  }
  async function preparePages() {
    if (!navigator.onLine || locked || preparing || document.body.hasAttribute('data-offline-snapshot')) return;
    preparing = true; await updateBar();
    try {
      const theme = await nativeFetch('/tenant/workspace/theme.css', {credentials: 'same-origin', cache: 'no-store'});
      if (theme.ok && theme.headers.get('content-type')?.includes('text/css')) await save(scope + ':theme', {css: (await theme.text()).slice(0, 4000)});
      const currency = document.getElementById('currencySelect')?.value, links = [...document.querySelectorAll('#nav a[href],a[data-open-operation],a[data-workspace-open],a[data-workspace-edit]')].map(el => el.href);
      const enabled = [...document.querySelectorAll('[data-transaction-kind]')].map(el => el.dataset.transactionKind);
      const operations = [...new Set(enabled.map(kind => operationPages[kind]).filter(Boolean))];
      const candidates = [...links.map(value => { const url = new URL(value, location.origin); if (currency && !url.searchParams.has('currency')) url.searchParams.set('currency', currency); return pageURL(url); })];
      const currencies = [...document.querySelectorAll('#currencySelect option')].map(el => el.value);
      for (const path of operations) for (const code of currencies) candidates.push(pageURL(path + '?currency=' + encodeURIComponent(code)));
      const paths = [...new Set(candidates.filter(Boolean))].slice(0, 100);
      // Load serially to avoid competing with tills for DB connections; fresh snapshots
      // are reused for five minutes. Only already-authorized visible routes are prepared.
      for (const path of paths) {
        if (!navigator.onLine || locked) break;
        const old = await savedPage(path); if (old && Date.now() - old.savedAt < 300000) continue;
        const response = await nativeFetch(path, {credentials: 'same-origin', headers: {Accept: 'text/html', 'X-ClassicFin-Prepare': 'true'}, redirect: 'error'}).catch(() => null);
        if (response?.ok && response.headers.get('content-type')?.includes('text/html')) await rememberPage(path, await response.text());
      }
      const pages = (await all('page')).sort((a, b) => b.savedAt - a.savedAt); let bytes = 0;
      for (let i = 0; i < pages.length; i++) { bytes += pages[i].html.length; if (i >= 120 || bytes > 18000000 || pages[i].savedAt + 7 * 86400000 < Date.now()) await remove(pages[i].id); }
      // Migrate away from the former detached form editor, preserving all drafts.
      for (const old of await all('template')) await remove(old.id);
      status('Workspace pages are saved for offline access.');
    } catch { status('Some pages could not be prepared. Visit them while connected to save them.'); }
    finally { preparing = false; await updateBar(); }
  }
  function showQueue() { const dialog = document.getElementById('offlineQueueDialog'); if (dialog && !dialog.open) { renderQueue().catch(() => status('Saved entries could not open.')); dialog.showModal(); } }
  async function submitOperation(form) {
    if (submitting.has(form)) return;
    submitting.add(form);
    const buttons = [...form.querySelectorAll('button[type="submit"],button:not([type])')], disabled = buttons.map(button => button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    try {
      const id = await queue(form, !navigator.onLine);
      if (!navigator.onLine) return;
      // Persist before attempting the POST. A broken WAN can leave onLine=true;
      // retaining the same UUID also covers a lost response after server commit.
      await sync();
      const row = await read(id), draft = row && await decrypt(row);
      if (draft?.state === 'synced') { location.assign(draft.resultUrl); return; }
      if (draft?.state === 'needs_attention') { rotateReference(form); alert(draft.problem); }
      else { resetForm(form); status('Connection interrupted. Your entry is saved and pending sync.'); }
    } catch (error) { status(error.message); alert(error.message); }
    finally { submitting.delete(form); buttons.forEach((button, index) => { button.disabled = disabled[index]; }); }
  }
  function installUI() {
    const bar = node('div', undefined, 'offline-bar'); bar.dataset.offlineRuntime = '';
    const message = node('span'); message.dataset.offlineMessage = '';
    const button = node('button', 'Pending sync', 'btn'); button.type = 'button'; button.addEventListener('click', showQueue); bar.append(message, button); document.querySelector('#sidePanel .sideFoot')?.append(bar);
    document.querySelectorAll('[data-offline-close]').forEach(el => el.addEventListener('click', () => document.getElementById('offlineQueueDialog').close()));
    document.getElementById('offlineSync')?.addEventListener('click', () => sync().catch(() => status('Sync interrupted. Your entries remain stored.')));
    const savedAt = document.body.dataset.offlineSnapshot;
    if (savedAt) {
      const notice = node('div', undefined, 'reportBlock offlineSnapshot'); notice.dataset.offlineRuntime = ''; notice.setAttribute('role', 'status');
      notice.append(node('strong', 'Offline workspace'), node('p', 'Saved ' + new Date(Number(savedAt)).toLocaleString() + '. Balances and reports reflect that time. New entries stay pending until synced.', 'tiny'));
      const refresh = node('button', 'Refresh when connected', 'btn'); refresh.type = 'button'; refresh.addEventListener('click', () => location.reload()); notice.append(refresh); document.querySelector('.topbar')?.after(notice);
    }
  }
  if (bootstrap) { restore().catch(() => status('The saved workspace could not open. Reconnect and sign in.')); return; }
  window.ClassicFinOffline = Object.freeze({pageResponse, openQueue: showQueue});
  document.addEventListener('submit', event => {
    const form = event.target, url = new URL(form.action, location.origin);
    if (url.pathname === '/logout') { lock(); announce(null); return; }
    if (allowed(form) && (!navigator.onLine || ready)) {
      event.preventDefault(); event.stopImmediatePropagation(); if (form.reportValidity()) submitOperation(form); return;
    }
    if (navigator.onLine) return;
    if (form.hasAttribute('data-branch-view-form')) {
      event.preventDefault(); event.stopImmediatePropagation();
      (async () => { const view = form.elements.namedItem('viewBranchId').value; if (await savedPage(location.href, view)) { sessionStorage.setItem(viewKey, view); location.reload(); } else { alert('This branch view has not been saved on this device. Reconnect to load it.'); form.elements.namedItem('viewBranchId').value = currentView(); } })().catch(() => status('Reconnect to change the viewing branch.')); return;
    }
    if (form.method.toLowerCase() !== 'post') return;
    event.preventDefault(); event.stopImmediatePropagation();
    const message = 'This action needs a connection to verify current balances, permissions or approval. Your page remains available offline.'; status(message); alert(message);
  }, true);
  window.addEventListener('online', () => { sync().catch(() => status('Sync interrupted. Entries remain pending.')); updateBar(); });
  window.addEventListener('offline', () => updateBar());
  window.addEventListener('storage', event => { if (event.key !== authKey) return; const activeScope = scope || document.body.dataset.offlineScope || sessionStorage.getItem(scopeKey); if (!activeScope) return; try { if (JSON.parse(event.newValue).scope !== activeScope) { lock(); if (navigator.onLine) location.replace('/signin'); else location.reload(); } } catch { /* Ignore malformed storage events. */ } });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/offline-runtime.js', {scope: '/'}).catch(() => status('Offline navigation is unavailable in this browser.'));
  (async () => { if (!await initialize()) return; ready = true; installUI(); await renderQueue(); await updateBar(); if (navigator.onLine && !document.body.hasAttribute('data-offline-snapshot')) { await rememberPage(location.href, initialHTML); await sync(); preparePages(); } if (lastMessage) status(lastMessage); })().catch(() => status('Offline storage could not open. Reconnect before submitting.'));
})();
