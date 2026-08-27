#!/usr/bin/env bash
# Smoke tests for GET /api/v1/clients/leads
#
#   BASE=http://localhost:3000 KEY=xxx ./scripts/test-leads-api.sh
#   BASE=https://www.trysplitlab.com KEY=xxx ./scripts/test-leads-api.sh
#
# Needs `jq` for the readable output (brew/apt install jq).

BASE="${BASE:-http://localhost:3000}"
KEY="${KEY:?set KEY=<INTERNAL_API_KEY>}"
URL="$BASE/api/v1/clients/leads"
AUTH=(-H "Authorization: Bearer $KEY")

hr() { printf '\n\033[1;34m── %s\033[0m\n' "$1"; }

hr "1. No key → expect 401"
curl -s -o /dev/null -w '%{http_code}\n' "$URL"

hr "2. Wrong key → expect 401"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer wrong-key-value-1234567890" "$URL"

hr "3. Default call — totals + client tree + latest 1000 rows"
curl -s "${AUTH[@]}" "$URL" | jq '{totals, clients: (.clients|length), rows: (.rows|length), next_cursor}'

hr "4. Summary only (no rows)"
curl -s "${AUTH[@]}" "$URL?summary=1" | jq '{totals, has_rows: (has("rows"))}'

hr "5. Per-client totals table"
curl -s "${AUTH[@]}" "$URL?summary=1" \
  | jq -r '["CLIENT","LEADS","BOTS","CONV","VIEWS","LAST LEAD"], (.clients[] | [.name, .leads, .bot_leads_excluded, .conversions, .views, (.last_lead_at // "-")]) | @tsv' \
  | column -t -s $'\t'

hr "6. Date range"
curl -s "${AUTH[@]}" "$URL?from=2026-08-01&to=2026-08-31&summary=1" | jq '{range, totals}'

hr "7. Full tree for the first client (workspace → test → variant)"
CID=$(curl -s "${AUTH[@]}" "$URL?summary=1" | jq -r '.clients[0].id')
echo "client_id=$CID"
curl -s "${AUTH[@]}" "$URL?summary=1&client_id=$CID" \
  | jq '.clients[0] | {name, leads, conversions,
        workspaces: [.workspaces[] | {name, leads,
          tests: [.tests[] | {name, url_path, leads, conversions,
            variants: [.variants[] | {name, traffic_weight, unique_visitors, conversions, cvr, leads, confidence, is_winner}]}]}]}'

hr "8. One raw lead row (check form_fields / utm / extra_params)"
curl -s "${AUTH[@]}" "$URL?client_id=$CID" | jq '.rows[0]'

hr "9. Bots included vs excluded"
echo -n "excluded: "; curl -s "${AUTH[@]}" "$URL?client_id=$CID&summary=1" | jq -c '.totals.leads'
echo -n "included: "; curl -s "${AUTH[@]}" "$URL?client_id=$CID&summary=1&include_bots=1" | jq -c '.totals.leads'

hr "10. Cursor walk — follow next_cursor to the end"
cursor=null; page=0; total=0
while :; do
  if [ "$cursor" = "null" ]; then u="$URL?client_id=$CID"; else u="$URL?client_id=$CID&cursor=$cursor"; fi
  resp=$(curl -s "${AUTH[@]}" "$u")
  n=$(echo "$resp" | jq '.rows | length')
  cursor=$(echo "$resp" | jq -r '.next_cursor')
  page=$((page+1)); total=$((total+n))
  echo "page $page: $n rows (next_cursor: ${cursor:0:24}…)"
  [ "$cursor" = "null" ] && break
  [ "$page" -ge 20 ] && echo "!! stopped at 20 pages — cursor may not be terminating" && break
done
echo "total rows fetched: $total"

hr "11. Bad inputs → expect 400"
for q in "from=not-a-date" "client_id=nope" "cursor=%%%garbage%%%" "from=2026-09-01&to=2026-08-01"; do
  printf '%-40s → ' "$q"
  curl -s -o /dev/null -w '%{http_code}\n' "${AUTH[@]}" "$URL?$q"
done

hr "12. Unknown client_id → expect 200 with empty clients"
curl -s "${AUTH[@]}" "$URL?client_id=00000000-0000-0000-0000-000000000000&summary=1" | jq '{clients: (.clients|length), totals}'

hr "13. Response size of a full rows page (watch the 4.5MB ceiling)"
curl -s "${AUTH[@]}" "$URL" -o /tmp/sl-leads.json
echo "$(wc -c < /tmp/sl-leads.json) bytes | $(jq '.rows|length' /tmp/sl-leads.json) rows"

hr "14. CORS is intentionally absent (browser calls must fail)"
curl -s -D - -o /dev/null "${AUTH[@]}" -H "Origin: https://example.com" "$URL?summary=1" | grep -i 'access-control' || echo "no CORS headers — correct"

hr "15. Rate limit — 65 rapid calls, expect some 429"
for i in $(seq 1 65); do curl -s -o /dev/null -w '%{http_code} ' "${AUTH[@]}" "$URL?summary=1"; done; echo
