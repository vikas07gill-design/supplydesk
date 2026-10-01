/* Subtle pointer tilt for link-style cards. Pointer devices only; skipped for reduced motion. */
(function(){
  if(!window.matchMedia||!matchMedia('(hover:hover) and (pointer:fine)').matches||matchMedia('(prefers-reduced-motion:reduce)').matches)return;
  var MAX=3.5; /* degrees */
  var SEL='a.card,.feature,.network-card,.result';
  function bind(el){
    if(el.__depth)return;el.__depth=1;el.setAttribute('data-depth-tilt','');
    el.addEventListener('pointermove',function(e){
      var r=el.getBoundingClientRect();
      var x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
      el.style.transition='transform .06s linear';
      el.style.transform='perspective(900px) rotateX('+(-y*MAX).toFixed(2)+'deg) rotateY('+(x*MAX).toFixed(2)+'deg) translateY(-3px)';
    });
    el.addEventListener('pointerleave',function(){el.style.transition='transform .25s ease';el.style.transform='';});
  }
  function scan(root){(root||document).querySelectorAll(SEL).forEach(bind)}
  scan();
  /* pages render cards after fetching data */
  new MutationObserver(function(m){m.forEach(function(x){x.addedNodes.forEach(function(n){if(n.nodeType===1){if(n.matches&&n.matches(SEL))bind(n);scan(n)}})})}).observe(document.documentElement,{childList:true,subtree:true});
})();
