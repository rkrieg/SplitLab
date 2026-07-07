export interface PersonalizationRuleRow {
  match_param: string;
  match_value: string | null;
  is_fallback: boolean;
  overrides_json: Record<string, unknown>;
  conditions_json?: { match_param: string; match_value: string }[] | null;
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
  if(!active||!active.overrides_json)return;
  var o=active.overrides_json;
  function getInfo(field){var fm=fs[field];if(!fm)return{selector:null,type:'text'};if(typeof fm==='string')return{selector:fm,type:'text'};return{selector:fm.selector||null,type:fm.type||'text'};}
  function run(){
    Object.keys(o).forEach(function(field){
      var val=o[field];if(!val)return;
      var info=getInfo(field);if(!info.selector)return;
      var el=document.querySelector(info.selector);if(!el)return;
      if(info.type==='image'||el.tagName==='IMG'){el.src=val;}
      else{el.textContent=val;}
    });
  }
  if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',run);}else{run();}
})();
</script>`;
}
