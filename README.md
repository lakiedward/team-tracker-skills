# team-tracker — skill-uri Claude Code pentru echipă

Plugin Claude Code care împachetează skill-urile de **team-tracker** ca să le aibă toată
echipa, **global (per-Claude), în orice proiect** — nu doar într-un repo.

Skill-uri incluse (apar ca slash-commands după instalare):

| Skill | Ce face |
|-------|---------|
| `orchestrate` | Mătură board-ul Focus al unui proiect și coordonează lucrul pe itemele active. |
| `pontaj` | Pontează orele tale de lucru din sesiunea curentă în `tt_work_logs` (pagina „Pontaj"). |
| `plan-deadlines` | Recitește repo-urile și tot backlog-ul, apoi propune pentru azi câte taskuri încap în orele disponibile și ritmul din Pontaj; scrie numai după confirmare. |
| `amana` | Amână un task din planul zilei — dar întâi te întreabă **de ce**, verifică motivul în tracker/Pontaj/estimări și amână doar dacă rezistă; altfel îl feliază, îl rescrie sau îl reordonează și îl ține azi. Amânarea primește dată de retur, motiv scris și un înlocuitor în locul lui. |
| `writing-tester-test-plans` | Scrie un plan de test pentru un tester uman (tt_test_plans / tt_test_items). |
| `writing-ai-test-plans` | Scrie un plan de test rulat automat de AI. |
| `auto-running-test-plans` | Rulează automat planurile neatinse pe preview-ul local. |
| `resolving-failed-test-plans` | Rezolvă pașii **failed și blocați** din planuri: pentru cei blocați vede de ce s-a blocat testerul, termină testul și repară dacă reiese un defect; apoi arhivează planul când totul e verde. |
| `resolving-tt-bugs` | Rezolvă bug-urile Open/In Progress din `tt_bugs`. |
| `resolving-tt-features` | Triază și implementează features din `tt_features`. |
| `triage` | Pune ordine în tot ce e de făcut, pe **toate** proiectele: rankează backlog-ul (bug+feature+test), semnalează duplicate/stale/done-nearhivat și aplică curățenia sigură la confirmare. Mod `--digest` pentru rezumatul zilnic. |
| `supabase-cota` | Rulează cota lunară Supabase: parsează factura org (PDF), citește Realtime Messages pe proiect din Dashboard Usage (Chrome logat), împarte restul **ponderat** (nu egal), scrie `tt_supabase_invoices` + shares și scoate mesajele de plată. |

---

## Cerințe (o dată per coleg)

Toate skill-urile lucrează cu Supabase-ul team-tracker (project ref **`ntjzghsbrzkvpkniotaj`**).
Înainte să funcționeze, fiecare coleg are nevoie de:

### 1. Un MCP Supabase conectat la proiectul team-tracker

Skill-urile rulează SQL prin MCP-ul Supabase. Adaugă-l o dată (înlocuiește `<TOKEN>` cu
un Supabase access token cu acces la proiect — vezi cu Edy ce token/scope folosiți):

```bash
claude mcp add supabase --scope user -- npx -y @supabase/mcp-server-supabase@latest --project-ref=ntjzghsbrzkvpkniotaj --access-token=<TOKEN>
```

Fără MCP-ul Supabase conectat, skill-urile se opresc cu „Supabase MCP nu e conectat".

### 2. (doar pentru `pontaj`) cine ești — te întreabă o dată, singur

Nu trebuie să setezi nimic. **Prima dată** când rulezi `/pontaj`, skill-ul îți arată lista
de membri (din `tt_members`) și te întreabă care ești; reține alegerea pe mașina ta în
`~/.claude/team-tracker-member.json` și **nu mai întreabă niciodată**.

Opțional, dacă vrei să-l fixezi din start fără întrebare, setează `TT_MEMBER`:
```powershell
setx TT_MEMBER "Popa"          # Windows (redeschide terminalul)
```
```bash
export TT_MEMBER="Popa"        # Mac/Linux
```

Schimbi identitatea mai târziu: rulezi o dată cu nume explicit („ponteaza pe numele lui X"),
sau `node <plugin>/skills/pontaj/scripts/member.mjs set "AltNume"`, ori ștergi fișierul de mai sus.

### 3. O cheie `service_role` pentru Storage

Bucket-urile de capturi (`ui-review-evidence`, `bug-screenshots`, `feature-screenshots`,
`test-screenshots`) sunt private și acceptă doar admini autentificați. Cheia `anon` — cea care
ajunge în bundle-ul public al aplicației — **nu** mai poate încărca, șterge sau semna nimic
acolo. Skill-urile care ating Storage citesc cheia din mediu:

```powershell
setx SUPABASE_SERVICE_ROLE_KEY "<cheia>"     # Windows (redeschide terminalul)
```
```bash
export SUPABASE_SERVICE_ROLE_KEY="<cheia>"   # Mac/Linux
```

O iei din Supabase Dashboard → Project Settings → API → `service_role`. Ocolește complet RLS,
deci tratează-o ca pe o parolă: nu o pune în repo, nu o scrie într-un rând din tracker, nu o
afișa în output.

Skill-urile care au nevoie de ea:

| Skill | Ce face cu Storage | Fără cheie |
|---|---|---|
| `ui-audit` | încarcă evidența, o șterge la rollback | se oprește |
| `plan-deadlines` | semnează atașamentele candidaților | se oprește |
| `resolving-tt-bugs` | semnează capturile din `image_urls` | continuă fără context vizual |
| `resolving-tt-features` | semnează capturile din `image_urls` | continuă fără context vizual |
| `supabase-cota` | urcă PDF-ul facturii în `invoices` | continuă, scrie în DB fără PDF salvat |

`orchestrate` nu atinge Storage direct — deleagă către `resolving-tt-bugs` / `resolving-tt-features`.

### 4. (doar pentru `supabase-cota`) MCP-ul `claude-in-chrome`

Factura Supabase nu desparte Realtime pe proiecte — singura sursă e pagina Dashboard →
Usage, care cere sesiune logată. Skill-ul o citește prin **`claude-in-chrome`**, adică
Chrome-ul tău normal, unde ești deja autentificat. Browserele izolate (panoul Browser din
app, Playwright) pornesc pe profil gol, pică pe sign-in și **nu** se folosesc aici.

Fără `claude-in-chrome`, `/supabase-cota` îți cere greutățile lipite manual sau confirmarea
explicită pentru `--equal` — nu împarte egal pe tăcute.

---

## Instalare (per coleg)

```text
/plugin marketplace add lakiedward/team-tracker-skills
/plugin install team-tracker@team-tracker
```

(înlocuiește `lakiedward/team-tracker-skills` cu adresa reală a repo-ului, dacă diferă).

După instalare, skill-urile apar ca slash-commands (ex. `/pontaj`) și sunt disponibile în
**orice** folder/proiect, nu doar aici.

### Auto-activare (opțional, ca să nu ruleze nimeni comenzi manual)

Pui în `.claude/settings.json` (în repo-urile partajate sau în settings-ul fiecăruia):

```json
{
  "extraKnownMarketplaces": {
    "team-tracker": { "source": { "source": "github", "repo": "lakiedward/team-tracker-skills" } }
  },
  "enabledPlugins": { "team-tracker@team-tracker": true }
}
```

---

## Update-uri

Modifici un skill aici → `git commit` + `git push`. Colegii primesc versiunea nouă la
următorul start de Claude (sau prin `/plugin marketplace update team-tracker`). Bump la
`version` în `plugins/team-tracker/.claude-plugin/plugin.json` pentru un release controlat.

## Structură

```
.claude-plugin/marketplace.json          # catalogul (un singur plugin)
plugins/team-tracker/
  .claude-plugin/plugin.json             # manifest plugin
  skills/<nume>/SKILL.md                 # cele 12 skill-uri (+ scripts/ / references/ unde e cazul)
```
