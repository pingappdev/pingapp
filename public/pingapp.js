(() => {
  const dialog = document.createElement('dialog');
  dialog.className = 'ping-modal'; dialog.setAttribute('aria-labelledby', 'ping-modal-title'); document.body.append(dialog);
  let lastFocus;
  function openModal(film = false) {
    lastFocus = document.activeElement;
    dialog.classList.toggle('ping-film',film);
    dialog.innerHTML = film ? '<div class="ping-film-bar"><h2 id="ping-modal-title">PingApp film</h2><button type="button" aria-label="Close film">Close ×</button></div><video controls playsinline preload="metadata" src="https://5w090lau1k.ufs.sh/f/EnqL4PVXaNs73WnwW3LfLABhrcbq0ulk6f7V8NmGE2YsUzRx" aria-label="PingApp film"></video>' : '<img src="/assets/pingapp-mark-v3.svg" width="64" height="70" alt="PingApp logo"><h2 id="ping-modal-title">Coming soon</h2><p>Connect with PingApp.<br>Our community channels are on their way.</p><button type="button">Close</button>';
    dialog.querySelector('button').addEventListener('click', closeModal); dialog.showModal(); dialog.querySelector('button').focus();
    if(film){document.querySelectorAll('section[data-framer-name="Showreel"] video').forEach(v=>v.pause());dialog.querySelector('video').play().catch(()=>{});}
  }
  function closeModal() { dialog.querySelector('video')?.pause(); dialog.close(); lastFocus?.focus();document.querySelectorAll('section[data-framer-name="Showreel"] video').forEach(v=>{const r=v.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight)v.play().catch(()=>{});}); }
  dialog.addEventListener('click', e => { const r = dialog.getBoundingClientRect(); if (e.target === dialog && (e.clientX < r.x || e.clientX > r.right || e.clientY < r.y || e.clientY > r.bottom)) closeModal(); });
  dialog.addEventListener('cancel', () => {dialog.querySelector('video')?.pause();lastFocus?.focus();});
  dialog.addEventListener('close',()=>{dialog.querySelector('video')?.pause();lastFocus?.focus();document.querySelectorAll('section[data-framer-name="Showreel"] video').forEach(v=>{const r=v.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&!matchMedia('(prefers-reduced-motion: reduce)').matches)v.play().catch(()=>{});});});
  document.addEventListener('click', e => {
    if (e.target.closest('a[href*="coming-soon"]')) { e.preventDefault(); e.stopImmediatePropagation(); openModal(); }
    else if (e.target.closest('section[data-framer-name="Showreel"]')) { e.preventDefault(); e.stopImmediatePropagation(); openModal(true); }
    else if (e.target.closest('form.ping-protocol button')) { e.preventDefault(); e.stopImmediatePropagation(); document.querySelector('nav a[href="/features"]')?.click(); }
    else if(location.pathname==='/protocol'&&e.target.closest('a[href="/protocol"]')?.querySelector('img[alt="Wallet control"]')){e.preventDefault();e.stopImmediatePropagation();document.querySelector('nav a[href="/features"]')?.click();}
  }, true);
  document.addEventListener('submit', e => { if(e.target.matches('form.ping-protocol')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  const reelObserver=new IntersectionObserver(entries=>entries.forEach(({target,isIntersecting})=>{if(isIntersecting&&!dialog.open&&!matchMedia('(prefers-reduced-motion: reduce)').matches)target.play().catch(()=>{});else target.pause();}),{threshold:.01});
  const reels=new Set();
  const textMeasurements=new Map();
  const textResize=new ResizeObserver(entries=>{
    const wrappers=new Set(entries.map(({target})=>textMeasurements.get(target)).filter(Boolean));
    for(const wrapper of wrappers){
      if(!wrapper.isConnected)continue;
      const height=Math.ceil(Math.max(...[...wrapper.querySelectorAll(':scope > [data-framer-component-type="RichTextContainer"]')].map(e=>e.getBoundingClientRect().height),0));
      const value=height+'px';
      if(height&&wrapper.style.getPropertyValue('--ping-description-height')!==value)wrapper.style.setProperty('--ping-description-height',value);
    }
  });
  function photoRole(img) {
    const named=n=>img.closest('[data-framer-name="'+n+'"]');
    if(named('Showreel'))return 'film';
    if(named('Hero'))return 'hero';
    if(named('About')){for(let e=img;e;e=e.parentElement){const match=e.dataset.framerName?.match(/^Image ([123])$/);if(match)return 'about-'+match[1];}}
    if(named('Testimonial Card'))return 'testimonial';
    const list=named('Services List'),sub=named('Sub-Services');
    if(list){let group=sub||img;while(group.parentElement&&group.parentElement!==list)group=group.parentElement;const gi=Array.from(list.children).indexOf(group);if(sub){let leaf=img;while(leaf.parentElement&&leaf.parentElement!==sub)leaf=leaf.parentElement;return 'capability-'+gi+'-'+Array.from(sub.children).indexOf(leaf);}return 'feature-'+gi;}
    if(named('Content')){const gallery=named('Gallery');if(!gallery)return 'content-cover';const wrap=named('Image Wrapper');let image=img;while(image.parentElement&&image.parentElement!==wrap)image=image.parentElement;return 'gallery-'+Array.from(gallery.children).indexOf(wrap)+'-'+Array.from(wrap.children).indexOf(image);}
    const labels={'Private payments':'case-private-payments','Receive your way':'case-receive-your-way','Card, in control':'case-card-in-control','Private payroll':'case-private-payroll','Shielded balances, keys, and statements':'guide-wallet-ownership','Private payroll and bounded agent payments':'guide-evm-balances','Phone payments without a permanent address':'guide-phone-to-wallet','A small public edge for everyday spending':'guide-phone-identity'};
    for(let e=img.parentElement;e&&e.id!=='main';e=e.parentElement){const text=e.textContent;if(text.length<300){const label=Object.keys(labels).sort((a,b)=>b.length-a.length).find(label=>text.includes(label));if(label)return labels[label];}}
    return '';
  }
  function cleanup() {
    // Native links leave the standalone marketing runtime and load the existing app.
    document.querySelectorAll('nav [data-framer-name="Menu Wrapper"]').forEach(wrapper => {
      if (wrapper.querySelector('.ping-open-app')) return;
      const link = document.createElement('a');
      link.className = 'ping-open-app';
      link.href = '/dashboard';
      link.textContent = 'Open app';
      link.dataset.nativeNavigation = 'true';
      wrapper.prepend(link);
    });
    for(const [text] of textMeasurements)if(!text.isConnected){textResize.unobserve(text);textMeasurements.delete(text);}
    document.querySelectorAll('.framer-1xt7p1o,.framer-1wn17cx,.framer-jleosx').forEach(wrapper=>{
      wrapper.querySelectorAll(':scope > [data-framer-component-type="RichTextContainer"]').forEach(text=>{if(!textMeasurements.has(text)){textMeasurements.set(text,wrapper);textResize.observe(text);}});
    });
    document.querySelectorAll('a[href*="lemonsqueezy"],#__framer-badge-container').forEach(e => { e.style.display = 'none'; });
    document.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (/^mailto:|^tel:/.test(href)) a.setAttribute('href', '/protocol');
      else if(href.startsWith('../')){const target=new URL(href,location.href);a.setAttribute('href',target.pathname+target.search+target.hash);}
      else if (href.startsWith('./')) { let target = href.slice(2); if (/^(private-payments|receive-your-way|card-in-control|private-payroll)$/.test(target)) target = 'use-cases/' + target; if (/^(phone-to-wallet|wallet-ownership|phone-identity|evm-balances)$/.test(target)) target = 'guides/' + target; a.setAttribute('href', '/' + target); }
      const match = href.match(/coming-soon-(telegram|x|github)/);
      if (match && !a.dataset.pingSocial) {
        const platform = match[1]; a.dataset.pingSocial = platform; a.removeAttribute('target'); a.classList.add('ping-social'); a.setAttribute('aria-label', ({telegram:'Telegram',x:'X',github:'GitHub'})[platform]);
        const svg = '<img class="ping-social-icon" src="/assets/icons/'+platform+'.svg" alt="" aria-hidden="true">', icon = a.querySelector('.framer-1not2r4');
        if (icon) { icon.className = 'framer-1not2r4 ping-native-social-icon'; icon.innerHTML = svg; } else a.insertAdjacentHTML('afterbegin', svg);
      }
    });
    document.querySelectorAll('a.framer-7n4Jj').forEach(a => { a.classList.add('ping-wordmark'); a.dataset.pingLogo = 'true'; if (!a.querySelector(':scope > .ping-logo')) a.insertAdjacentHTML('afterbegin', '<span class="ping-logo" aria-hidden="true"></span>'); });
    document.querySelectorAll('[data-framer-name="Trademark"]').forEach(mark=>{const h=mark.parentElement.querySelector('h1');if(innerWidth<810&&h){const a=h.getBoundingClientRect(),b=mark.parentElement.getBoundingClientRect();mark.dataset.pingTrademark='true';mark.style.left=(a.right-b.left+8)+'px';mark.style.top=(a.top-b.top+4)+'px';mark.style.transform='none';}else if(mark.dataset.pingTrademark){mark.style.removeProperty('left');mark.style.removeProperty('top');mark.style.transform='translateY(-50%)';delete mark.dataset.pingTrademark;}});
    const interactive=[...document.querySelectorAll('[data-framer-name="FAQs"] h5')].map(h=>h.closest('[tabindex]')).filter(Boolean);const menu=document.querySelector('[data-framer-name="Line 1"]')?.parentElement;if(menu){menu.setAttribute('aria-label','Toggle menu');interactive.push(menu);}interactive.forEach(el=>{el.setAttribute('role','button');el.setAttribute('aria-expanded',el.dataset.framerName==='Default'||el.dataset.framerName==='Closed'?'false':'true');});
    document.querySelectorAll('img[alt="Wallet control"]').forEach(img => { if(img.getAttribute('src') !== '/assets/pingapp-mark-v3.svg') { img.src = '/assets/pingapp-mark-v3.svg'; img.removeAttribute('srcset'); img.style.padding='16%';img.style.objectFit='contain'; } });
    const symbols={'Hexagon Icon':'pool','Funnel Pattern Icon':'wallet','Spiral Pattern Icon':'receive','Echo Pattern Icon':'card','Avatar 1':'phone','Avatar 2':'pool','Avatar 3':'card','Avatar 4':'statement','Your keys stay yours':'shield','Your wallet signs':'wallet','Control stays with you':'shield','Resolve, then review':'receive','Your number is a pointer':'phone'};
    document.querySelectorAll('img').forEach(img=>{let symbol=symbols[img.alt];if(img.alt==='Spiral Pattern Icon'&&img.closest('[data-framer-name]')?.parentElement?.textContent.includes('Statements'))symbol='statement';if(symbol){const src='/assets/icons/'+symbol+'.svg?v=16';if(img.getAttribute('src')!==src)img.src=src;img.removeAttribute('srcset');img.classList.add('ping-product-icon');}});
    const capabilitySymbols={'Shielded balances':'pool','Your own keys':'shield','Stealth destinations':'receive','Capped card funding':'card','Statements you control':'statement'};
    document.querySelectorAll('[data-framer-name="Icon"] img').forEach(img=>{const text=img.closest('[data-framer-name="Icon"]').parentElement.textContent;const label=Object.keys(capabilitySymbols).find(label=>text.startsWith(label));if(label){const src='/assets/icons/'+capabilitySymbols[label]+'.svg?v=16';if(img.getAttribute('src')!==src)img.src=src;img.removeAttribute('srcset');img.alt=label;img.classList.add('ping-product-icon');img.closest('[data-framer-name="Icon"]').classList.add('ping-icon-frame');}});
    document.querySelectorAll('[data-framer-name="Team Member Card"]').forEach(card=>{
      const match=card.textContent.match(/^0([1-5])/),img=card.querySelector('img');if(!match||!img)return;
      const plan=window.PING_ROADMAP?.[+match[1]-1];if(!plan)return;
      card.classList.add('ping-roadmap-card');
      const src='/assets/icons/'+plan.icon+'.svg?v=16';if(img.getAttribute('src')!==src){img.src=src;img.removeAttribute('srcset');}img.alt=plan.window;img.classList.add('ping-product-icon');
      const wrapper=card.querySelector('[data-framer-name="Text Wrapper"]');
      if(wrapper&&!wrapper.querySelector('.ping-roadmap-details')){
        const details=document.createElement('div');details.className='ping-roadmap-details';
        const windowLabel=document.createElement('p');windowLabel.className='ping-roadmap-window';windowLabel.textContent=plan.window;
        const summary=document.createElement('p');summary.className='ping-roadmap-summary';summary.textContent=plan.summary;
        const list=document.createElement('ul');for(const text of plan.milestones){const item=document.createElement('li');item.textContent=text;list.append(item);}
        details.append(windowLabel,summary,list);wrapper.append(details);
      }
    });
    const roadmap=document.querySelector('.ping-roadmap-card')?.parentElement?.parentElement;
    if(roadmap&&!roadmap.querySelector('.ping-release-gates')){
      const note=document.createElement('div');note.className='ping-release-gates';
      const title=document.createElement('h3');title.textContent='Release follows security review';
      const text=document.createElement('p');text.textContent='Each stage advances through verified security gates: protected phone records, tested relink cooldowns, user-controlled pool exits, delayed cap increases, immediate revocation, authenticated partner webhooks, and stateless statement exports. Privacy-set sizes and solvency proofs remain visible. Network deployments, treasury assets, and partner services determine availability.';
      note.append(title,text);roadmap.append(note);
    }
    document.querySelectorAll('[data-framer-name="Toggle Wrap"]').forEach(w=>{if(!w.dataset.pingAccount){w.dataset.pingAccount='true';w.replaceChildren();const p=document.createElement('p');p.className='ping-account-caption';p.textContent='Two layers. One owner.';w.append(p);}});
    document.querySelectorAll('section[data-framer-name="Showreel"]').forEach(s=>{s.setAttribute('role','button');s.setAttribute('aria-label','Play PingApp film');s.tabIndex=0;if(!s.dataset.pingFilm){s.dataset.pingFilm='true';s.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openModal(true);}});}});
    for(const v of reels)if(!v.isConnected){reelObserver.unobserve(v);v.pause();reels.delete(v);}
    document.querySelectorAll('section[data-framer-name="Showreel"] video').forEach(v=>{if(!v.dataset.pingReel){v.dataset.pingReel='true';v.src='https://5w090lau1k.ufs.sh/f/EnqL4PVXaNs73WnwW3LfLABhrcbq0ulk6f7V8NmGE2YsUzRx';v.muted=true;v.loop=true;v.playsInline=true;v.preload='metadata';reelObserver.observe(v);reels.add(v);}});
    document.querySelectorAll('form:not(.ping-protocol)').forEach(form => {
      form.classList.add('ping-protocol');
      const fields = Array.from(form.querySelectorAll('.framer-form-input-wrapper')), steps = ['01 · Verify a protected phone identity', '02 · Publish a stealth meta-address', '03 · Shield funds with keys you control', '04 · Review, prove, and send. Each payment derives a fresh destination. Relayers broadcast proofs; your spending key stays yours. Requests, payroll, receive preferences, and a capped card lane build on the same private account.'];
      fields.forEach((wrapper, i) => { wrapper.replaceChildren(); const step=document.createElement('div'); step.className='ping-protocol-step' + (i===3?' ping-protocol-note':''); step.textContent=steps[i]; wrapper.append(step); });
      form.querySelectorAll('input,textarea').forEach(e=>e.remove());
    });
    const route = location.pathname.replace(/\/+$/, '') || '/';
    const pool=window.PING_PHOTO_SLOTS?.[route]||{};document.querySelectorAll('img[loading=lazy]').forEach(i=>{i.loading='eager';i.fetchPriority='high';});
    const heading={'/':'PingApp','/about':'About','/features':'Features','/use-cases':'Use cases','/guides':'Guides','/use-cases/private-payments':'Private payments','/use-cases/receive-your-way':'Receive your way','/use-cases/card-in-control':'Card, in control','/use-cases/private-payroll':'Private payroll','/guides/phone-to-wallet':'Phone payments without a permanent address','/guides/wallet-ownership':'Shielded balances, keys, and statements','/guides/phone-identity':'A small public edge for everyday spending','/guides/evm-balances':'Private payroll and bounded agent payments'}[route];
    document.querySelectorAll('img[src^="/assets/stock/"],img[data-ping-photo]').forEach(img=>{
      const main=img.closest('[data-framer-name="Main"]');
      if(heading&&main&&!main.querySelector('h1')?.textContent.startsWith(heading))return;
      const role=photoRole(img);img.dataset.pingSlot=role;
      if(role==='film'||role==='hero'&&route==='/'){img.src='/assets/icons/play.svg';img.removeAttribute('srcset');delete img.dataset.pingPhoto;return;}
      const photo=pool[role];if(!photo)return;
      if(img.getAttribute('src')!==photo.src)img.setAttribute('src',photo.src);
      img.removeAttribute('srcset');img.dataset.pingPhoto=photo.src;img.alt=photo.alt;img.style.objectPosition=photo.position;
    });
    document.documentElement.classList.add('ping-ready');
  }
  let scheduled = false;
  const updateNav=()=>document.documentElement.classList.toggle('ping-scrolled',scrollY>32);window.addEventListener('scroll',updateNav,{passive:true});updateNav();
  new MutationObserver(() => { if (!scheduled) { scheduled = true; queueMicrotask(() => { scheduled = false; cleanup(); }); } }).observe(document.getElementById('main'), { childList:true, subtree:true });
  window.addEventListener('resize', cleanup, {passive:true}); document.addEventListener('framer:pageview', cleanup); cleanup();
})();
