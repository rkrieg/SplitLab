export interface PersonalizationRuleRow {
  match_param: string;
  match_value: string | null;
  is_fallback: boolean;
  overrides_json: Record<string, unknown>;
  conditions_json?: { match_param: string; match_value: string }[] | null;
  hero_html?: string | null;
}

export type FieldSelectorMap = Record<string, { selector: string; type: 'text' | 'image'; label: string } | string> | null;

/**
 * Builds the client-side UTM personalization swap script, injected before </body>.
 * Single source of truth for match logic so preview/serve/published-page routes can't drift.
 *
 * Match logic: a rule matches only if ALL of its conditions match (AND). Legacy single-
 * condition rows (no conditions_json) fall back to match_param/match_value. Values are
 * compared case-insensitively and trimmed, since ad platforms are inconsistent about
 * casing/whitespace in UTM tags. When multiple rules match, the one with the most
 * conditions wins (most specific); ties fall back to priority/array order.
 */
export function buildUtmSwapScript(rules: PersonalizationRuleRow[], fieldSelectors: FieldSelectorMap): string {
  if (!rules || rules.length === 0) return '';

  return `<script>
(function(){
  var rules=${JSON.stringify(rules)};
  var fs=${JSON.stringify(fieldSelectors || {})};
  var params=new URLSearchParams(window.location.search);
  function norm(v){return (v==null?'':String(v)).trim().toLowerCase();}
  function conditionsOf(r){
    if(r.conditions_json&&r.conditions_json.length>0)return r.conditions_json;
    if(r.match_param&&r.match_value!=null)return [{match_param:r.match_param,match_value:r.match_value}];
    return [];
  }
  function ruleMatches(r){
    var conds=conditionsOf(r);
    if(conds.length===0)return false;
    for(var i=0;i<conds.length;i++){
      if(norm(params.get(conds[i].match_param))!==norm(conds[i].match_value))return false;
    }
    return true;
  }
  var candidates=rules.filter(function(r){return !r.is_fallback&&ruleMatches(r);});
  candidates.sort(function(a,b){return conditionsOf(b).length-conditionsOf(a).length;});
  var active=candidates[0]||rules.find(function(r){return r.is_fallback;});
  console.log('[sl-utm-swap] rules='+rules.length+' matchedCandidates='+candidates.length+' active='+(active?(active.hero_html?'hero_html':'overrides_json'):'none'));
  if(!active){console.log('[sl-utm-swap] no active rule for this URL\\'s params — nothing to swap');return;}
  function getInfo(field){var fm=fs[field];if(!fm)return{selector:null,type:'text'};if(typeof fm==='string')return{selector:fm,type:'text'};return{selector:fm.selector||null,type:fm.type||'text'};}
  function run(){
    console.log('[sl-utm-swap] run() called, readyState='+document.readyState);
    if(active.hero_html){
      // Idempotency guard: once applied, mark the new root with
      // data-sl-hero-applied. Without this, the AI-generated hero_html
      // itself commonly contains <section class="hero">...</section> (the
      // generation prompt requires that root wrapper) — so on raw HTML
      // pages, after the FIRST swap, our own injected replacement now
      // literally matches 'section.hero' too, and the MutationObserver
      // below re-triggers run() on every childList mutation (including the
      // one we just caused), which finds and re-replaces our own output
      // over and over for the whole observer window. Found live
      // (2026-07-31): 15+ redundant outerHTML replacements per page load,
      // pure waste + layout thrashing, with the final content unchanged.
      if(document.querySelector('[data-sl-hero-applied]')){console.log('[sl-utm-swap] hero_html already applied this session — skipping');return;}
      var heroEl=document.querySelector('[data-hero-container]')||document.querySelector('section.hero');
      console.log('[sl-utm-swap] hero_html mode — container found: '+(heroEl?(heroEl.tagName+(heroEl.id?'#'+heroEl.id:'')):'NONE'));
      if(heroEl){
        heroEl.outerHTML=active.hero_html;
        // outerHTML detaches the old node — re-query to tag the new root.
        var newRoot=document.querySelector('[data-hero-container]')||document.querySelector('section.hero');
        if(newRoot){
          newRoot.setAttribute('data-sl-hero-applied','1');
          // Loud visibility check: if the page's own CSS hides this element
          // (e.g. a colliding non-unique id elsewhere on the page also
          // matched by an ID-selector rule with display:none — found live
          // 2026-07-31 on a messy Unbounce export where the injected
          // container's id was reused by unrelated decorative elements
          // further down the page), the swap technically "worked" but is
          // invisible to real visitors. Surface this immediately instead of
          // silent failure.
          var cs=getComputedStyle(newRoot);
          if(cs.display==='none'||cs.visibility==='hidden'||newRoot.offsetParent===null){
            console.warn('[sl-utm-swap] hero_html applied but the container is NOT VISIBLE (display='+cs.display+' visibility='+cs.visibility+' offsetParent='+(newRoot.offsetParent===null?'null':'set')+'). This usually means the page\\'s own CSS hides this element — check for a non-unique id colliding with another element\\'s display:none rule.');
          } else {
            console.log('[sl-utm-swap] hero_html applied and container is visible');
          }
        }
      }
      else{console.log('[sl-utm-swap] FAILED — no [data-hero-container] or section.hero element in DOM');}
      return;
    }
    if(!active.overrides_json){console.log('[sl-utm-swap] no overrides_json on active rule — nothing to do');return;}
    var o=active.overrides_json;
    Object.keys(o).forEach(function(field){
      var val=o[field];if(!val)return;
      var info=getInfo(field);if(!info.selector){console.log('[sl-utm-swap] field "'+field+'" has no selector in fieldSelectors map — skipped');return;}
      // querySelectorAll, not querySelector: raw/uploaded page-builder exports
      // (e.g. Unbounce) commonly duplicate the same hero element once per
      // responsive breakpoint (mobile/tablet/desktop), toggled via CSS rather
      // than actually removed from the DOM. Detection tags every such
      // duplicate with the same data-field selector (see
      // hero-field-detection-raw.ts), so every match must be updated together
      // or other breakpoints would silently keep stale default content. A
      // no-op for AI-generated pages, where each field is already unique.
      var els=document.querySelectorAll(info.selector);
      console.log('[sl-utm-swap] field "'+field+'" selector="'+info.selector+'" matched '+els.length+' element(s)');
      if(!els.length)return;
      els.forEach(function(el){
        if(info.type==='image'||el.tagName==='IMG'){
          el.src=val;
          el.removeAttribute('srcset');
          // Lazy-load scripts (e.g. Unbounce) re-set src from data-src-* after we run,
          // so point those at our URL too — whatever they install later is still ours.
          for(var ai=el.attributes.length-1;ai>=0;ai--){
            var an=el.attributes[ai].name;
            if(an.indexOf('data-src')===0){el.setAttribute(an,val);}
          }
        }
        else{el.textContent=val;}
      });
    });
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}
  // Safety net: re-apply after full load in case a page script overwrote us in between
  window.addEventListener('load',run);
  // Further safety net (2026-07-31 — found live against an Unbounce-exported
  // page): some page builders load their own runtime via <script async>,
  // which hydrates/re-renders elements from an internal data model *after*
  // window 'load' fires — async script timing isn't tied to the load event,
  // so it can silently stomp our swap seconds later with no error. Same
  // MutationObserver + debounce pattern already used in tracker.js's
  // startStepperObserver() for the same class of "page re-renders itself
  // after we've already acted" problem. The applying flag guards against
  // reacting to our own writes and looping forever; observer disconnects
  // after a bounded window so it doesn't run indefinitely.
  if(window.MutationObserver){
    var applying=false;
    var debounceTimer=null;
    var mo=new MutationObserver(function(){
      if(applying)return;
      clearTimeout(debounceTimer);
      debounceTimer=setTimeout(function(){
        applying=true;
        run();
        applying=false;
      },150);
    });
    mo.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['src','srcset']});
    setTimeout(function(){mo.disconnect();},10000);
  }
})();
</script>`;
}
