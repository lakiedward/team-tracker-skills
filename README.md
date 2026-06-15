# team-tracker — skill-uri Claude Code pentru echipă

Plugin Claude Code care împachetează skill-urile de **team-tracker** ca să le aibă toată
echipa, **global (per-Claude), în orice proiect** — nu doar într-un repo.

Skill-uri incluse (apar ca slash-commands după instalare):

| Skill | Ce face |
|-------|---------|
| `pontaj` | Pontează orele tale de lucru din sesiunea curentă în `tt_work_logs` (pagina „Pontaj"). |
| `writing-tester-test-plans` | Scrie un plan de test pentru un tester uman (tt_test_plans / tt_test_items). |
| `writing-ai-test-plans` | Scrie un plan de test rulat automat de AI. |
| `auto-running-test-plans` | Rulează automat planurile neatinse pe preview-ul local. |
| `resolving-failed-test-plans` | Rezolvă pașii failed din planuri și le arhivează. |
| `resolving-tt-bugs` | Rezolvă bug-urile Open/In Progress din `tt_bugs`. |
| `resolving-tt-features` | Triază și implementează features din `tt_features`. |

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

### 2. (doar pentru `pontaj`) numele tău, în variabila `TT_MEMBER`

`pontaj` scrie orele pe numele din `TT_MEMBER`. Setează-l o dată cu numele tău **exact**
așa cum apare pe pagina Pontaj:

```powershell
setx TT_MEMBER "Popa"          # Windows (redeschide terminalul după)
```
```bash
export TT_MEMBER="Popa"        # Mac/Linux (pune-l în ~/.zshrc / ~/.bashrc)
```

Dacă `TT_MEMBER` nu e setat, `pontaj` te întreabă o dată pe ce nume să te ponteze
(nu pontează pe nimeni „by default").

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
  skills/<nume>/SKILL.md                 # cele 7 skill-uri (+ scripts/ unde e cazul)
```
