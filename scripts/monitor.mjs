import { chromium } from 'playwright';

const BASE = 'https://www.kupujemprodajem.com';
const worker = process.env.WORKER_URL?.replace(/\/$/, '');
const token = process.env.INGEST_TOKEN;
const diagnostic = process.env.DIAGNOSTIC_ONLY === 'true';
if (!diagnostic && (!worker || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(worker) || !token)) {
  throw Error('Set repository secrets WORKER_URL (https://...workers.dev) and INGEST_TOKEN');
}
// Exact saved search supplied by the user. The site may canonicalize the URL;
// keep reporting the actual post-navigation URL and sorting verification separately.
const listings = [
  // 1. Laptopovi za delove — sortirano po novijim
  `${BASE}/pretraga?groupId=1238&categoryId=1221&order=posted%20desc&saved=true`,
  // 2. Oštećeni laptopovi: ključna reč u opisu
  `${BASE}/pretraga?condition=damaged&keywords=laptop&keywordsScope=description&order=posted%20desc&prev_keywords=laptop&saved=true`,
  // 3. Laptop 2.000–5.000 RSD: tačan korisnikov sačuvani filter
  `${BASE}/pretraga?categoryId=1221&keywordsScope=description&priceTo=5000&order=posted%20desc&priceFrom=2000&keywords=laptop&groupId=101&currency=rsd&prev_keywords=laptop&saved=true`
];
const clock = /M8\s*15\.5C11\.866|M7\.5\s*7\.5V5\.5/;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const maxAds = Math.min(25, Math.max(1, Number(process.env.MAX_ADS || '12')));
const scans = Math.min(5, Math.max(1, Number(process.env.SCANS_PER_RUN || '3')));
const pagesPerSearch = Math.min(3, Math.max(1, Number(process.env.PAGES_PER_SEARCH || '2')));
const page = await chromium.launch({headless:true});
const sentInRun = new Set();
const failures = [];
const warnings=[];
const navRetry=async(tab,url)=>{for(let i=0;i<2;i++){try{return await tab.goto(url,{waitUntil:'commit',timeout:18000});}catch(e){if(i===1)throw e;await sleep(900*(i+1));}}};


async function fetchListing(browserPage,url) {
 const response = await navRetry(browserPage,url);
 await browserPage.waitForTimeout(2200);
 const status = response?.status();
 if(status !== 200) throw Error(`KP listing HTTP ${status} ${url}`);
 // KP sometimes drops order=posted desc and falls back to its default "Sortiraj".
 // Actively select Novije. Log the actual control state rather than assuming the URL works.
 let sorting = 'unverified';
 const sortDiagnostic = {initial:null, clicked:false, selected:false, visibleText:null, urlAfterSort:null};
 const sortLabel = browserPage.getByText(/^Novije$/i).first();
 try {
   const current = await browserPage.locator('button,[role="button"]').allTextContents();
   sortDiagnostic.initial = current.filter(s=>/sortiraj|novije/i.test(s)).slice(0,8);
   if (!await sortLabel.isVisible().catch(()=>false)) {
     const sortButton = browserPage.getByRole('button',{name:/^Sortiraj$/i}).first();
     const fallback = browserPage.getByText(/^Sortiraj$/i).first();
     const trigger = await sortButton.count() ? sortButton : fallback;
     await trigger.waitFor({state:'visible',timeout:9000});
     await trigger.click();
     sortDiagnostic.clicked=true;
     // Options may be divs, list items or menu items; choose a VISIBLE Novije option.
     await browserPage.waitForTimeout(350);
     const choices=browserPage.getByText(/^Novije$/i);
     const count=await choices.count();
     for(let i=0;i<count;i++) {
       const choice=choices.nth(i);
       if(await choice.isVisible()) {
         await choice.click();sortDiagnostic.selected=true;break;
       }
     }
     if(!sortDiagnostic.selected)throw Error('Novije option did not appear after opening Sortiraj');
     await browserPage.waitForLoadState('domcontentloaded',{timeout:12000}).catch(()=>{});
     await browserPage.waitForTimeout(1600);
   }
   // Confirm selected sort from the closed control, not from an open dropdown item.
   const displayed=browserPage.getByText(/^Novije$/i);
   for(let i=0;i<await displayed.count();i++){
     const e=displayed.nth(i);
     if(!await e.isVisible())continue;
     const details=await e.evaluate(n=>({text:n.textContent?.trim(),parent:n.parentElement?.innerText?.slice(0,100),isOption:!!n.closest('[role="menu"],[role="listbox"],[role="option"],[role="menuitem"]')}));
     if(details.isOption)continue;
     sortDiagnostic.visibleText=details.text;
     sortDiagnostic.controlText=details.parent;
     sorting='ui-label:Novije';break;
   }
   if(sorting==='unverified' && sortDiagnostic.selected){
     // We selected the option but cannot independently confirm the persisted UI state.
     sortDiagnostic.reason='Clicked Novije but closed control could not be verified';
   }
 }catch(e){
   sortDiagnostic.reason=String(e).slice(0,250);
   sortDiagnostic.nearby=await browserPage.locator('button,[role="button"]').allTextContents().then(x=>x.filter(v=>/novije|sortiraj/i.test(v)).slice(0,8)).catch(()=>[]);
 }
 sortDiagnostic.urlAfterSort=browserPage.url();
 // Clicking Novije resets KP pagination to page=1. Only accept a second page after
 // navigating to page=2 again and confirming its URL, otherwise fail closed.
 const wantedPage=Number(new URL(url).searchParams.get('page')||1);
 if(wantedPage>1){
   const settled=new URL(browserPage.url());
   if(Number(settled.searchParams.get('page')||1)!==wantedPage){
     settled.searchParams.set('page',String(wantedPage));
     await navRetry(browserPage,settled.toString());
     await browserPage.waitForTimeout(1100);
   }
   const actual=Number(new URL(browserPage.url()).searchParams.get('page')||1);
   if(actual!==wantedPage)throw new Error('PAGINATION_UNVERIFIED: expected page '+wantedPage+' got '+actual);
 }
 const result = await browserPage.evaluate(() => {
  const clockPath = svg => [...svg.querySelectorAll('path')].some(p => /M8\s*15\.5C11\.866|M7\.5\s*7\.5V5\.5/.test(p.getAttribute('d')||''));
  const ids = new Map();
  const debug = {duplicateLinks:0, invalidCards:0, missingPrice:0, rejectedIcons:0};
  const allAdLinks=[...document.querySelectorAll('a[href*="/oglas/"]')];
  for(const link of allAdLinks){
   const href=link.getAttribute('href')||''; const m=href.match(/\/oglas\/(\d+)/); if(!m)continue;
   const id=m[1];
   if(ids.has(id)){debug.duplicateLinks++;continue;}
   let card=null;
   // Select the smallest ancestor containing this link, its posting status AND
   // only this advert's ID. Prevents using a shared wrapper that includes several ads.
   let ancestor=link;
   for(let n=0;n<12 && ancestor;n++,ancestor=ancestor.parentElement){
    const posted=ancestor.querySelector('[class*="postedStatus"], [class*="PostedStatus"]');
    if(!posted)continue;
    const unique=new Set([...ancestor.querySelectorAll('a[href*="/oglas/"]')].map(x=>(x.getAttribute('href')||'').match(/\/oglas\/(\d+)/)?.[1]).filter(Boolean));
    if(unique.size===1 && unique.has(id)){card=ancestor;break;}
   }
   if(!card){debug.invalidCards++;continue;}
   const posted=card.querySelector('[class*="postedStatus"], [class*="PostedStatus"]');
   if(![...posted.querySelectorAll('svg')].some(clockPath)){debug.rejectedIcons++;continue;}
   const url=new URL(href,location.origin);
   const a=[...card.querySelectorAll('a[href*="/oglas/"]')].find(x=>x.innerText.trim().length>4) || link;
   const title=(a.innerText||a.getAttribute('title')||'').trim().slice(0,230);
   const cardText=(card.innerText||'').trim().slice(0,3000);
   const price=(cardText.match(/\d[\d.,\s]*\s*(?:€|EUR|din|RSD)/i)||[])[0]||'';
   if(!price)debug.missingPrice++;
   if(title&&price&&url.hostname==='www.kupujemprodajem.com')ids.set(id,{id,url:url.origin+url.pathname,title,price,isNew:true,newEvidence:'clock'});
  }
  return {countLinks:document.querySelectorAll('a[href*="/oglas/"]').length,clockAds:[...ids.values()], sortLabel:(document.body?.innerText||'').match(/Novije|Najnovije|Nedavno postavljeni/i)?.[0]||null,debug};
 });
 if(result.countLinks<5)throw Error(`Listing missing results (${result.countLinks} links): ${url}`);
 return {status,finalUrl:browserPage.url(),sorting,sortDiagnostic,...result};
}

async function details(browserPage,ad) {
 const response=await navRetry(browserPage,ad.url);
 await browserPage.waitForTimeout(1200);
 if(response?.status()!==200)throw Error(`KP advert HTTP ${response?.status()} id=${ad.id}`);
 const data=await browserPage.evaluate(()=>{
  const candidates=[];
  for(const el of document.querySelectorAll('[class*="description"], [class*="Description"], [itemprop="description"]')){
   const s=(el.innerText||el.textContent||'').trim(); if(s.length>=30&&s.length<15000)candidates.push(s);
  }
  const raw=(document.body?.innerText||'');
  const start=raw.search(/Opis oglasa|Opis proizvoda/i);
  if(start>=0){const after=raw.slice(start).replace(/^.{0,35}(?:Opis oglasa|Opis proizvoda)\s*/i,'');const end=after.search(/\n(?:O prodavcu|Oglas postavljen|Postavi pitanje|Prijavi oglas|Slični oglasi|Dostava|Lokacija prodavca)\b/i);const cut=(end>=50?after.slice(0,end):after.slice(0,8000)).trim();if(cut.length>=30)candidates.push(cut);}
  for(const script of document.querySelectorAll('script[type="application/ld+json"], script#__NEXT_DATA__')){
   try{const obj=JSON.parse(script.textContent);const walk=(v,d=0)=>{if(d>12||!v)return;if(Array.isArray(v)){for(const x of v.slice(0,100))walk(x,d+1);return;}if(typeof v==='object'){for(const [k,x] of Object.entries(v)){if(/^(description|opis|adDescription)$/i.test(k)&&typeof x==='string'&&x.length>=30&&x.length<15000)candidates.push(x);else if(typeof x==='object')walk(x,d+1);}}};walk(obj);}catch{}
  }
  const description=candidates.sort((a,b)=>b.length-a.length)[0]||'';
  return {description:description.slice(0,12000),hasDescriptionHeading:/Opis oglasa|Opis proizvoda/i.test(raw),candidateCount:candidates.length,title:document.title};
 });
 // Fail closed if content could not be verified. Do not substitute SEO preview for full description.
 const verified=data.description.length>=30 && (data.hasDescriptionHeading || data.candidateCount>0);
 return {...ad,description:data.description,descriptionVerified:verified};
}

async function ingest(ads){
 const response=await fetch(`${worker}/ingest`,{method:'POST',headers:{'authorization':`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({ads}),signal:AbortSignal.timeout(55000)});
 const text=await response.text();if(!response.ok)throw Error(`Worker HTTP ${response.status}: ${text.slice(0,400)}`);
 return JSON.parse(text);
}

try{
 for(let round=1;round<=scans;round++){
  for(const baseUrl of listings){
   for(let pageNumber=1;pageNumber<=pagesPerSearch;pageNumber++){
   const searchUrl = new URL(baseUrl);
   searchUrl.searchParams.set('page',String(pageNumber));
   const url = searchUrl.toString();
   const tab=await page.newPage({locale:'sr-RS',viewport:{width:1365,height:900}});
   let found=[];
   try{
    const result=await fetchListing(tab,url);
    console.log(JSON.stringify({event:'listing',round,pageNumber,url,status:result.status,links:result.countLinks,clockCards:result.clockAds.length,sorting:result.sorting,sortDiagnostic:result.sortDiagnostic,sortLabel:result.sortLabel,firstIds:result.clockAds.slice(0,6).map(a=>a.id),debug:result.debug,finalUrl:result.finalUrl}));
    found=result.clockAds.filter(a=>!sentInRun.has(a.id)).slice(0,maxAds);
    if (result.sorting === 'unverified') console.warn('SORT_UNVERIFIED: list may not show newest adverts; review sortDiagnostic.');
   }catch(e){warnings.push(String(e));console.warn('LISTING_WARNING',String(e));await tab.close();continue;}
   await tab.close();
   const ads=[];
   for(const ad of found){
    const dtab=await page.newPage({locale:'sr-RS'});
    try{const full=await details(dtab,ad);if(full.descriptionVerified){ads.push(full);}else console.log(JSON.stringify({event:'no_verified_description',id:ad.id}));}
    catch(e){warnings.push(`${ad.id}: ${String(e)}`);console.warn('DETAIL_WARNING',ad.id,String(e));}
    finally{await dtab.close();}
   }
   console.log(JSON.stringify({event:'batch',round,pageNumber,source:url,verified:ads.length,diagnostic}));
   if(ads.length && !diagnostic){
    for(let i=0;i<ads.length;i+=15){
     const chunk=ads.slice(i,i+15);
     const result=await ingest(chunk);
     for(const ad of chunk)sentInRun.add(ad.id);
     if(result.errors?.length)warnings.push(...result.errors);
     console.log(JSON.stringify({event:'worker_response',...result}));
     if(result.errors?.length)console.warn('WORKER_ERRORS',JSON.stringify(result.errors));
    }
   }
   }
  }
  if(round<scans)await sleep(60000);
 }
} finally {await page.close();}
console.log(JSON.stringify({event:'summary',detailsSent:sentInRun.size,warnings:warnings.slice(0,10),errors:failures.slice(0,10),pagesPerSearch,rounds:scans,sortNote:'Novije checked by UI; each page must be confirmed, not exhaustive.'}));
if(failures.length)process.exitCode=1;
