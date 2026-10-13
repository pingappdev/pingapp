/* The supplied floral robot replaces the portrait inside the native hero. */
(() => {
  let active;
  function mount(host) {
    const art = document.createElement('div');
    art.className = 'ping-hero-graphic ping-robot-hero';
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML = `<svg class="ping-robot-filters" xmlns="http://www.w3.org/2000/svg" width="0" height="0"><defs><filter id="ping-robot-grade" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="table" tableValues=".05 .10 .16 .23 .36 .52 .84 1 1"/><feFuncG type="table" tableValues=".03 .04 .06 .09 .15 .24 .18 .62 .94"/><feFuncB type="table" tableValues=".08 .14 .25 .39 .68 .96 .635 .77 .98"/></feComponentTransfer></filter></defs></svg><div class="ping-robot-scene"><img class="ping-robot-poster" src="/assets/media/pingapp-floral-robot.jpg" alt="" decoding="async"><video class="ping-robot-video" autoplay muted loop playsinline preload="auto" poster="/assets/media/pingapp-floral-robot.jpg" disablepictureinpicture><source src="https://5w090lau1k.ufs.sh/f/EnqL4PVXaNs70dBGSKJTfsEtHkrpLlUum26dP47nybNxeXBY" type="video/mp4"></video><div class="ping-robot-colour"></div></div><div class="ping-robot-shade"></div>`;
    host.append(art);
    host.classList.add('ping-hero-ready');
    const video = art.querySelector('video');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    video.muted = true;
    function playback() {
      const still = reduced.matches || document.visibilityState !== 'visible';
      art.classList.toggle('is-static', reduced.matches);
      if (visible && !still) video.play().catch(() => art.classList.remove('is-playing'));
      else video.pause();
    }
    function playing() { art.classList.add('is-playing'); }
    function failed() { art.classList.remove('is-playing'); }
    video.addEventListener('playing', playing);
    video.addEventListener('error', failed);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      playback();
    }, {threshold: 0});
    observer.observe(host);
    document.addEventListener('visibilitychange', playback);
    reduced.addEventListener('change', playback);
    playback();
    return () => {
      observer.disconnect();
      video.pause();
      video.removeAttribute('src');
      video.querySelector('source').removeAttribute('src');
      video.load();
      document.removeEventListener('visibilitychange', playback);
      reduced.removeEventListener('change', playback);
      video.removeEventListener('playing', playing);
      video.removeEventListener('error', failed);
      host.classList.remove('ping-hero-ready');
      art.remove();
    };
  }
  function sync() {
    if (active && !active.host.isConnected) { active.dispose(); active = null; }
    const host = location.pathname === '/' ? document.querySelector('[data-framer-name="Hero Image Wrapper"]') : null;
    if (host && !active) active = {host, dispose: mount(host)};
  }
  new MutationObserver(sync).observe(document.getElementById('main'), {subtree: true, childList: true});
  sync();
})();
