/**
 * The client script injected into the generated homepage.
 *
 * The page already ships with real cards, so this only has to take over: it reads
 * a fresh snapshot, re-renders the grid with the same card markup the generator
 * writes, and keeps the status line honest. A crawler never runs any of it, which
 * is exactly why the markup is baked in rather than injected here.
 *
 * The filter rules are injected as literals (MIN_PRICE, MAX_DEALS, AMAZON_SHARE,
 * the store-mix function and the spotlight config) from scripts/lib/publish.mjs,
 * so the runtime cannot drift away from the pages the crawler reads.
 */

import {
  AMAZON_SHARE, AMAZON_TAG, MAX_DEALS, MAX_PLAUSIBLE_PRICE_RATIO, MIN_DEAL_PRICE,
  REFRESH_MINUTES, escapeHtml, spotlightConfig
} from './publish.mjs';

/** Escapes a value for safe embedding inside a <script> block. */
function forScript(json) {
  return JSON.stringify(json).replace(/</g, '\\u003c');
}

/**
 * The spotlight picker, mirroring pickSpotlight() in publish.mjs but reading the
 * serialised regex config rather than the module — the browser cannot import.
 */
function spotlightScript() {
  const config = spotlightConfig();
  return `function pickSpotlight(list){
  const accessory=new RegExp(${forScript(config.accessory)},'i');
  const families=${forScript(config.families)}.map(f=>({...f,test:new RegExp(f.test,'i'),prefer:f.prefer?new RegExp(f.prefer,'i'):null}));
  const pool=list.filter(d=>d.title&&d.url&&dealPrice(d)>${config.minPrice}&&!accessory.test(d.title));
  const used=new Set(),picks=[];
  for(const family of families){
    const candidates=pool.filter(d=>!used.has(d.id)&&family.test.test(d.title));
    if(!candidates.length)continue;
    candidates.sort((a,b)=>{
      if(family.prefer){const pa=family.prefer.test(a.title)?1:0,pb=family.prefer.test(b.title)?1:0;if(pb!==pa)return pb-pa}
      return b.discount-a.discount;
    });
    const best=candidates[0];used.add(best.id);
    picks.push({tag:(family.flagshipTag&&family.prefer&&family.prefer.test(best.title))?family.flagshipTag:family.tag,deal:best});
  }
  if(picks.length<3){
    pool.filter(d=>!used.has(d.id)).sort((a,b)=>b.discount-a.discount).slice(0,3-picks.length)
      .forEach(d=>{used.add(d.id);picks.push({tag:d.category||'Electronics',deal:d})});
  }
  return picks;
}`;
}

/** Markup for one deal, kept in step with renderDealCard() in lib/render.mjs. */
const CARD_FN = `function productCard(deal){
  const article=document.createElement('article');article.className='deal';
  const media=document.createElement('figure');media.className='deal-media';
  if(deal.image){const img=document.createElement('img');img.src=deal.image;img.alt=deal.title;img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';img.onerror=()=>{img.remove();const fb=document.createElement('figcaption');fb.textContent='Image unavailable';media.prepend(fb)};media.append(img)}
  else{const fb=document.createElement('figcaption');fb.textContent='Image unavailable';media.append(fb)}
  const badges=document.createElement('div');badges.className='deal-badges';
  const store=document.createElement('span');store.className='pill pill-store';store.textContent=deal.store;badges.append(store);
  if(deal.discount){const off=document.createElement('span');off.className='pill pill-off';off.textContent=Math.round(deal.discount)+'% off';badges.append(off)}
  if(deal.isNew){const isNew=document.createElement('span');isNew.className='pill pill-new';isNew.textContent='New';badges.append(isNew)}
  media.append(badges);
  const body=document.createElement('div');body.className='deal-body';
  const title=document.createElement('h3');title.textContent=deal.title;
  const row=document.createElement('div');row.className='price-row';
  if(deal.originalPrice&&deal.originalPrice!==deal.price){const was=document.createElement('span');was.className='was';was.textContent=deal.originalPrice;row.append(was)}
  const price=document.createElement('span');price.className='price';price.textContent=deal.price;row.append(price);
  const cta=document.createElement('a');cta.className='deal-cta';cta.href=affiliateUrl(deal.url);cta.target='_blank';cta.rel='sponsored noopener noreferrer';
  const label=document.createElement('span');label.textContent='View on '+deal.store;
  const arrow=document.createElement('span');arrow.setAttribute('aria-hidden','true');arrow.textContent='↗';cta.append(label,arrow);
  body.append(title,row,cta);article.append(media,body);return article;
}`;

/** Google Product rich-result eligibility needs stock + price on every offer. */
const SCHEMA_FN = `function injectDealSchema(deals){
  const top=deals.slice().sort((a,b)=>b.discount-a.discount).slice(0,30);
  const schema={'@context':'https://schema.org','@type':'ItemList',name:'Live Amazon and Flipkart tech deals',numberOfItems:top.length,
    itemListElement:top.map((deal,index)=>({'@type':'ListItem',position:index+1,item:{'@type':'Product',name:deal.title,url:affiliateUrl(deal.url),
    ...(deal.image?{image:deal.image}:{}),
    offers:{'@type':'Offer',price:String(deal.price||'').replace(/[^\\d]/g,''),priceCurrency:'INR',availability:'https://schema.org/InStock',url:affiliateUrl(deal.url)}}}))};
  let host=document.querySelector('#deals-schema');
  if(!host){host=document.createElement('script');host.type='application/ld+json';host.id='deals-schema';document.head.append(host)}
  host.textContent=JSON.stringify(schema);
}`;

export const PAGE_SCRIPTS = `
${CARD_FN}
${SCHEMA_FN}
${spotlightScript()}
`.trim();

/**
 * The full homepage runtime: feed load, filters, search, spotlight and the daily
 * push opt-in. Kept identical in behaviour to the previous hand-written script so
 * the interaction model does not change with the redesign.
 */
export const HOMEPAGE_RUNTIME = `
<script>
(function(){
  // Imported, not hardcoded: if the publish rules change, the browser picks them up
  // on the next build instead of silently keeping yesterday's numbers.
  const AMAZON_SHARE=${forScript(AMAZON_SHARE)}, MIN_PRICE=${forScript(String(MIN_DEAL_PRICE))}, MAX_DEALS=${forScript(String(MAX_DEALS))};
  const MAX_PLAUSIBLE_PRICE_RATIO=${forScript(String(MAX_PLAUSIBLE_PRICE_RATIO))};
  const AMAZON_TAG=${forScript(AMAZON_TAG)};
  const POLL_SECONDS=${REFRESH_MINUTES * 60};

  const grid=document.querySelector('#deal-grid');
  if(!grid)return;

  const statusText=document.querySelector('#status-text');
  const updated=document.querySelector('#updated');
  const dot=document.querySelector('#dot');
  const refreshButton=document.querySelector('#refresh');
  const pauseButton=document.querySelector('#pause');
  const queryInput=document.querySelector('#query');

  let deals=[],amazonDeals=[],flipkartDeals=[],mixedDeals=[];
  let selectedStore='All',selectedCategory='All';
  let paused=false,countdown=POLL_SECONDS,refreshing=false;

  function affiliateUrl(url){
    if(!url)return url;
    try{const p=new URL(url,location.origin);if(/(^|\\.)amazon\\./i.test(p.hostname))p.searchParams.set('tag',AMAZON_TAG);return p.href}catch{return url}
  }
  function dealPrice(deal){const v=Number(String(deal&&deal.price||'').replace(/[^\\d]/g,''));return Number.isFinite(v)?v:0}
  function categoryFor(deal){
    if(deal.category)return deal.category;
    const t=String(deal.title||'').toLowerCase();
    if(/mobile|smartphone|phone|iphone|galaxy|pixel|redmi|realme|oneplus/i.test(t))return'Mobiles';
    if(/laptop|notebook|computer|macbook/i.test(t))return'Laptops';
    return'Electronics';
  }
  // A row at 100x its own price has a mismatched variant MRP, not a real markdown.
  // Keep the price but drop the discount claim, so the card and the JSON-LD never
  // advertise a saving that was never there. Mirrors sanitiseDeal() in publish.mjs.
  function plausibleRatio(deal){
    const price=dealPrice(deal);
    const was=Number(String(deal&&deal.originalPrice||'').replace(/[^\\d]/g,''));
    if(!price||!was||was<=price)return true;
    return was/price<=MAX_PLAUSIBLE_PRICE_RATIO;
  }
  function sanitise(deal){
    if(plausibleRatio(deal))return deal;
    const copy=Object.assign({},deal);
    delete copy.originalPrice;
    copy.discount=0;
    copy.discountUnverified=true;
    return copy;
  }
  function publishable(list){return (list||[]).filter(d=>d&&!d.stale&&d.available!==false&&dealPrice(d)>=MIN_PRICE&&plausibleRatio(d)).map(sanitise)}
  function shuffle(list){for(let i=list.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));const s=list[i];list[i]=list[j];list[j]=s}return list}
  function mixStores(amazon,flipkart){
    if(!amazon.length)return shuffle(flipkart.slice());
    if(!flipkart.length)return shuffle(amazon.slice());
    const maxFlipkart=Math.floor(amazon.length*(1-AMAZON_SHARE)/AMAZON_SHARE);
    const a=shuffle(amazon.slice()),f=shuffle(flipkart.slice()).slice(0,maxFlipkart);
    const out=[];let ai=0,fi=0;
    while(ai<a.length||fi<f.length){
      const takeAmazon=fi>=f.length?true:ai>=a.length?false:((out.length+1)*7-ai*10)>=5;
      out.push(takeAmazon?a[ai++]:f[fi++]);
    }
    return out;
  }
  function setStatus(text,state){if(statusText)statusText.textContent=text;if(dot)dot.className='dot '+(state||'')}

  function storeCount(name){
    return name==='All'?mixedDeals.length:mixedDeals.filter(d=>d.store===name).length;
  }

  function renderChipbar(){
    const stores=['All','Amazon','Flipkart'];
    let host=document.querySelector('#store-filters');
    if(!host){
      host=document.createElement('div');
      host.id='store-filters';
      host.className='filters';
      const summary=document.querySelector('#summary');
      (summary&&summary.parentNode?summary.parentNode:grid.parentNode).insertBefore(host,summary);
    }
    host.replaceChildren();
    stores.forEach(name=>{
      const b=document.createElement('button');
      b.type='button';b.className='chip';b.textContent=name==='All'?'All stores':name+' ('+storeCount(name)+')';
      b.setAttribute('aria-pressed',String(name===selectedStore));
      b.onclick=()=>{selectedStore=name;render()};
      host.append(b);
    });
  }

  function render(){
    const query=(queryInput&&queryInput.value||'').trim().toLowerCase();
    const pool=selectedStore==='All'?mixedDeals:mixedDeals.filter(d=>d.store===selectedStore);
    const visible=pool.filter(d=>(selectedCategory==='All'||categoryFor(d)===selectedCategory)&&(!query||String(d.title).toLowerCase().includes(query)||String(d.store).toLowerCase().includes(query)));
    grid.replaceChildren();
    if(visible.length)visible.forEach(d=>grid.append(productCard(d)));
    else{
      const state=document.createElement('div');state.className='state';
      const h=document.createElement('h3'),p=document.createElement('p');
      h.textContent=deals.length?'No matching deals':'Live deals unavailable';
      p.textContent=deals.length?'Try another store, clear your search, or browse the category pages.':'Both stores are currently inaccessible. Try refreshing shortly.';
      state.append(h,p);grid.append(state);
    }
    const amz=visible.filter(d=>d.store==='Amazon').length;
    const summary=document.querySelector('#summary');
    if(summary)summary.innerHTML='<strong>'+visible.length+'</strong> live deal'+(visible.length===1?'':'s')+' shown &middot; Amazon '+amz+' &middot; Flipkart '+(visible.length-amz);
    renderChipbar();
  }

  function renderSpotlight(){
    const host=document.querySelector('#spotlight-grid');
    const section=document.querySelector('#spotlight');
    if(!host||!section)return;
    const picks=pickSpotlight(deals);
    if(!picks.length){section.hidden=true;return}
    section.hidden=false;
    host.replaceChildren();
    picks.forEach(({tag,deal})=>{
      const card=document.createElement('a');
      card.className='spotlight-card';card.href=affiliateUrl(deal.url);card.target='_blank';card.rel='sponsored noopener noreferrer';
      const media=document.createElement('div');media.className='spotlight-media';
      if(deal.image){const img=document.createElement('img');img.src=deal.image;img.alt=deal.title;img.loading='lazy';img.referrerPolicy='no-referrer';media.append(img)}
      else{const fb=document.createElement('span');fb.className='image-fallback';fb.textContent='Image unavailable';media.append(fb)}
      const tagEl=document.createElement('span');tagEl.className='spotlight-tag';tagEl.textContent=tag;media.append(tagEl);
      const info=document.createElement('div');info.className='spotlight-info';
      const t=document.createElement('h3');t.textContent=deal.title;
      const row=document.createElement('div');row.className='spotlight-row';
      const p=document.createElement('span');p.className='spotlight-price';p.textContent=deal.price;row.append(p);
      if(deal.originalPrice){const w=document.createElement('span');w.className='spotlight-was';w.textContent=deal.originalPrice;row.append(w)}
      if(deal.discount){const o=document.createElement('span');o.className='spotlight-off';o.textContent=Math.round(deal.discount)+'% off';row.append(o)}
      const cta=document.createElement('div');cta.className='spotlight-cta';
      const s=document.createElement('span');s.textContent=deal.store;
      const g=document.createElement('span');g.textContent='Grab deal ↗';cta.append(s,g);
      info.append(t,row,cta);card.append(media,info);host.append(card);
    });
  }

  async function loadDeals(force){
    if(refreshing)return;
    refreshing=true;
    if(refreshButton){refreshButton.disabled=true;refreshButton.textContent='Updating…'}
    grid.setAttribute('aria-busy','true');
    setStatus('Reading the latest deals…');
    try{
      const res=await fetch('/api/deals'+(force?'?refresh=1':''),{cache:'no-store'});
      if(!res.ok)throw new Error('feed request failed');
      const data=await res.json();
      amazonDeals=publishable(data.amazon&&data.amazon.deals);
      flipkartDeals=publishable(data.flipkart&&data.flipkart.deals);
      deals=shuffle([...amazonDeals,...flipkartDeals]);
      mixedDeals=mixStores(amazonDeals,flipkartDeals).slice(0,MAX_DEALS);
      const amzOk=amazonDeals.length>0,fkOk=flipkartDeals.length>0;
      if(amzOk&&fkOk)setStatus(mixedDeals.length+' live listings · Amazon + Flipkart','live');
      else if(amzOk)setStatus('Amazon only · '+mixedDeals.length+' listings','partial');
      else if(fkOk)setStatus('Flipkart only · '+mixedDeals.length+' listings','partial');
      else setStatus('Both stores unavailable','error');
      if(updated&&data.updatedAt){
        const t=new Date(data.updatedAt);
        updated.textContent='Updated '+t.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
      }
      countdown=POLL_SECONDS;
      render();renderSpotlight();injectDealSchema(mixedDeals);
    }catch{
      setStatus('Could not reach the deal server — showing the last snapshot','error');
    }finally{
      refreshing=false;
      if(refreshButton){refreshButton.disabled=false;refreshButton.textContent='Refresh now'}
      grid.setAttribute('aria-busy','false');
    }
  }

  if(queryInput)queryInput.addEventListener('input',render);
  if(refreshButton)refreshButton.addEventListener('click',()=>loadDeals(true));
  if(pauseButton)pauseButton.addEventListener('click',()=>{
    paused=!paused;
    pauseButton.textContent=paused?'Resume updates':'Pause updates';
    pauseButton.setAttribute('aria-pressed',String(paused));
  });
  setInterval(()=>{
    if(paused)return;
    countdown-=1;
    if(countdown<=0){loadDeals();countdown=POLL_SECONDS}
  },1000);

  window.addEventListener('deal-alerts-state',render);

  /* ── Daily deal alerts ─────────────────────────────────────────── */
  (function(){
    const section=document.querySelector('#alerts');
    const enable=document.querySelector('#alerts-enable');
    const disable=document.querySelector('#alerts-disable');
    const stateLabel=document.querySelector('#alerts-state');
    if(!section||!enable||!disable||!stateLabel)return;

    const PREF_KEY='dg-alerts';
    const supported='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
    let registration=null;
    const wants=()=>{try{return localStorage.getItem(PREF_KEY)==='on'}catch{return false}};
    const setPref=v=>{try{v?localStorage.setItem(PREF_KEY,'on'):localStorage.removeItem(PREF_KEY)}catch{}};
    const setState=t=>{stateLabel.textContent=t||''};
    const isIos=()=>/iP(hone|ad|od)/.test(navigator.platform||'')||(/Mac/.test(navigator.platform||'')&&navigator.maxTouchPoints>1);

    async function config(){
      try{
        const res=await fetch('/api/push/key',{cache:'no-store'});
        if(!res.ok)return{key:'',ready:false};
        const data=await res.json();
        return{key:(data&&data.key)||'',ready:Boolean(data&&data.ready)};
      }catch{return{key:'',ready:false}}
    }
    function paint(ready){
      const on=supported&&Notification.permission==='granted'&&wants();
      enable.hidden=on;disable.hidden=!on;
      section.hidden=!ready&&!on;
      if(!supported){
        enable.disabled=true;
        setState(isIos()?'On iPhone and iPad, add this site to your Home Screen first — iOS only allows deal alerts for installed web apps.':'This browser cannot show notifications.');
        return;
      }
      if(on){setState('On — two deals land here every morning.');return}
      if(Notification.permission==='denied'){enable.disabled=true;setState('Notifications are blocked for this site — allow them in your browser settings to get the daily deals.')}
      else enable.disabled=false;
    }
    function keyToBytes(base64){
      const padded=(base64+'='.repeat((4-base64.length%4)%4)).replace(/-/g,'+').replace(/_/g,'/');
      const raw=atob(padded);const bytes=new Uint8Array(raw.length);
      for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
      return bytes;
    }
    async function worker(){
      if(registration)return registration;
      try{registration=await navigator.serviceWorker.register('/sw.js')}catch{}
      if(!registration){try{registration=await navigator.serviceWorker.ready}catch{}}
      return registration;
    }
    async function sync(sub){
      try{
        const res=await fetch('/api/push/subscribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(sub.toJSON())});
        return res.ok;
      }catch{return false}
    }

    enable.addEventListener('click',async()=>{
      if(!supported)return;
      enable.disabled=true;
      const label=enable.textContent;enable.textContent='Enabling…';
      try{
        const permission=await Notification.requestPermission();
        if(permission!=='granted'){setState('Notifications were not allowed. You can change this in your browser settings.');return}
        const {key}=await config();
        if(!key){setState('Deal alerts are not set up on this deployment yet.');return}
        const reg=await worker();
        if(!reg){setState('Could not reach the service worker. Reload and try again.');return}
        let sub=await reg.pushManager.getSubscription();
        if(!sub)sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyToBytes(key)});
        if(!await sync(sub)){
          await sub.unsubscribe().catch(()=>{});
          setPref(false);setState('Could not save your deal alerts. Please try again in a moment.');
          return;
        }
        setPref(true);setState('On — two deals land here every morning.');
      }catch{setState('Could not turn on alerts. Please try again.')}
      finally{enable.disabled=false;enable.textContent=label;paint(true)}
    });

    disable.addEventListener('click',async()=>{
      disable.disabled=true;
      try{
        const reg=await worker();
        const sub=reg&&await reg.pushManager.getSubscription();
        if(sub){
          await fetch('/api/push/subscribe?endpoint='+encodeURIComponent(sub.endpoint),{method:'DELETE'}).catch(()=>{});
          await sub.unsubscribe().catch(()=>{});
        }
      }catch{}
      setPref(false);disable.disabled=false;setState('Alerts are off.');paint(true);
    });

    (async()=>{
      const reg=await worker();
      const {ready}=await config();
      if(reg&&wants()&&Notification.permission==='granted'){
        const sub=await reg.pushManager.getSubscription().catch(()=>null);
        if(sub)sync(sub);
      }
      paint(ready);
    })();
  })();

  loadDeals();
})();
</script>
`.trim();
