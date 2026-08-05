# supabase-cota — allocation & message reference

## Money rules

```
attributable[ref]  = sum of invoice lines that name that 20-char project ref
pro_plan_usd       = "Pro Plan" line (org subscription) → owner only
shared_pool        = amount_due − Σ attributable − pro_plan
```

Invoice lines **with** ref: Compute Micro, Egress, Cached Egress, Storage, Branching.

Invoice lines **without** ref (→ residual pool): Realtime Messages (main $), Realtime Peak Connections, Functions, MAU, etc. after free-tier discounts. Pro Plan is **not** in this pool.

## Where Realtime per project comes from

| Source | Use? |
|--------|------|
| Invoice PDF | No — one org line, no ref |
| Supabase MCP | No — no Usage/billing metrics |
| Management API `usage.api-counts` | No — request counts ≠ billable messages |
| **Dashboard Usage via `mcp__claude-in-chrome__*`** | **Yes** — filter project + invoice period → Realtime Messages |

Org Usage (this account):
`https://supabase.com/dashboard/org/llelrogdokexkkejavwb/usage`

The in-app Browser pane (`mcp__Claude_Browser__*`) and Playwright
(`mcp__plugin_playwright_playwright__*`) run on empty profiles and land on the
Supabase sign-in page — they cannot read this.

## Weighted split (default)

Weights = Realtime Messages count per project for the invoice period.

```
allW              = Σ weight[ref]          # refs with weight > 0
billableW         = Σ weight[ref]          # bills_supabase = true
client_pool       = shared_pool * (billableW / allW)
shared[ref]       = client_pool * weight[ref] / billableW   # billable only
own / unmapped    = not charged residual
```

Equal split only with `--equal` or explicit user OK after Chrome failed.

Round to 2 decimals; last billable absorbs drift.

## Payment message template

Weighted:

```
Cotă Supabase — <ProjectName>
<InvoiceNumber> · <period_ro>
Usage: $<attr>
  · <Label>: $<amount>
Realtime (cota ta): $<shared>
De plată: $<total>
```

Equal fallback (label honestly):

```
Cotă comună (Realtime/org, împărțit egal): $<shared>
```

If `payer_name` set, first line: `<PayerName>, cotă Supabase — <ProjectName>`.

Period: `ian feb mar apr mai iun iul aug sep oct nov dec`
Example: `5 iun 2026 – 4 iul 2026`. Facts only — no greetings/emoji.

## DB

`raw_parse` should include allocation JSON plus, when available:

```json
{
  "split_mode": "weighted",
  "realtime_weights": { "<ref>": 1234567 }
}
```

## Sanity

1. Pro Plan ~$25 when present on PDF.
2. `shared_pool + attrSum + pro_plan ≈ amount_due` (±0.05).
3. Own rows: `total_owed_usd = 0`.
4. Billable totals ≥ attributable.
