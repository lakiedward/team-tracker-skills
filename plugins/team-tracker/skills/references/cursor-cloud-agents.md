# Cursor Cloud Agents — protocolul de dispatch al orchestratorului

Referință pentru `/proiect`: cum lansează, urmărește și închide chatul-orchestrator un task
trimis unui Cursor cloud agent. Agenții rulează fiecare pe VM-ul lui Ubuntu (repo,
dependențe, desktop + browser + înregistrare video — „Computer Use", feb 2026) și atașează
video/screenshots/loguri pe PR. Ei implementează; **verificarea și merge-ul rămân locale**.

## Precondiții (o dată per mașină)

- `CURSOR_API_KEY` în mediu — generată de om în Cursor Dashboard → API Keys. Lipsește →
  fallback local, anunță omul o singură dată pe sesiune.
- On-demand billing activat + spending limit setat de om (API-ul refuză lansarea fără
  ~$2 headroom sub limită). Limita mică e plasă de siguranță, nu cost: agenții consumă
  întâi pool-ul inclus al abonamentului (Ultra ≈ $400/lună echivalent API), abia apoi
  on-demand la preț de API fără markup. Pool-ul e comun cu IDE-ul omului.

## Config model — bătut în cuie de om (2026-08-25)

- **model `grok-4.6`, effort `xhigh`, fast OFF.** Fast e doar viteză la preț dublu
  ($4/$12 vs $2/$6 per M tokeni); la agenți de fundal nu plătim viteza. Grok 4.6 xhigh
  era #1 pe CursorBench 3.2 (70.8%) la data deciziei.
- **Forma confirmată** (din `GET /v1/models`, 2026-08-25 — `fast` e STRING, nu boolean):

  ```json
  "model": {
    "id": "grok-4.6",
    "params": [
      { "id": "effort", "value": "xhigh" },
      { "id": "fast",   "value": "false" }
    ]
  }
  ```

- **ATENȚIE — varianta default a lui grok-4.6 este `effort: high, fast: true`.** Dacă omiți
  `params`, primești automat modul fast, adică preț dublu. Specifică ÎNTOTDEAUNA explicit.
- Efort valid: `low` / `medium` / `high` / `xhigh`. `GET /v1/models` listează toate
  modelele și variantele valide — folosește-l dacă un id pare respins.
- Cost estimat ~$3–8/task (benchmark: $2.81/task xhigh). La primele rulări verifică
  dashboardul de usage și notează aici costul real observat.

## API v1 (public beta — formele se pot schimba)

Bază: `https://api.cursor.com`. Auth: Bearer `CURSOR_API_KEY`.

- `POST /v1/agents` — lansează: `{prompt: {text}, repos: [{url, startingRef}],
  model: {id, params?}, autoCreatePR: true}`. Răspunde cu `agent` (durabil) + primul `run`.
- `GET /v1/agents/{id}/runs/{runId}` — status: `CREATING` / `RUNNING` / `FINISHED` /
  `ERROR` / `CANCELLED` / `EXPIRED`; `result` (text) + `git.branches[]` (branch, `prUrl`).
- `GET /v1/agents/{id}/runs/{runId}/stream` — SSE cu text deltas și tool calls.
- **Un singur run activ per agent**; al doilea request primește `409 agent_busy`.
- **Follow-up = run nou pe ACELAȘI agent** (păstrează conversația și workspace-ul). Nu
  există „waiting for input" — agentul nu poate întreba mid-run.
- Bug cunoscut (iul 2026): follow-up pe un agent terminat de mult poate intra
  `CREATING → RUNNING → ERROR` fără payload de eroare. Retry o dată; dacă persistă,
  agent NOU cu contextul re-injectat în prompt (istoricul e pierdut, spune-o în raport).
- API-ul e sursa de adevăr pentru flotă: un chat redeschis își regăsește agenții cu un
  GET, nu din memoria conversației. Nu ține stare paralelă în fișiere sau tabele.

## Promptul de lansare — obligatoriu în fiecare dispatch

1. **Contextul complet al taskului.** Unde taskul vine din Productivitate, folosește
   promptul generat acolo („Copiază promptul") ca bază — conține deja criteriile,
   pontajul recent, disciplina git și porțile.
2. **Regula loghează-și-continuă:** „Când dai de ambiguitate, NU te opri și NU inventa
   certitudine: alege presupunerea cea mai ușor de inversat, noteaz-o explicit în
   raportul final într-o secțiune «Întrebări & presupuneri», și continuă. Orchestratorul
   le citește la final și revine cu follow-up dacă ai presupus greșit."
3. **Porțile umane:** interzis să scrie `manual_verdict` / `verdict_fingerprint` /
   `spec_approved_at` / `shipped_at` / `launch_stage` (DB-ul le respinge oricum) și
   interzis DDL pe tabelele `tt_`. Refuzul DB-ului pe ele nu e un obstacol de ocolit.
4. **Dovezi pe PR:** video/screenshots din VM pentru orice schimbare vizibilă, pașii
   executați, starea consolei. PR fără dovadă = task neterminat.
5. **Fără merge.** `autoCreatePR: true`, dar merge-ul îl face orchestratorul, local,
   după poarta de verificare. Agentul care face merge singur a încălcat contractul.

## Ciclul orchestratorului per task

```
launch (POST /v1/agents)
  → monitor (poll GET run / stream SSE)
  → FINISHED: citește result + PR + video
  → «Întrebări & presupuneri» din raport:
      - ce poate răspunde orchestratorul singur (contextul sesiunii ghidate e în chat)
        → follow-up run cu răspunsurile
      - doar design/scop → AskUserQuestion la om, GRUPAT, cu recomandare
  → repetă follow-up până taskul e întreg
  → verificare LOCALĂ obligatorie:
      git worktree add ../<proiect>-pr-<n> origin/<branch>
      teste + build + poarta de browser + fiecare criteriu obligatoriu acoperit
      + Bugbot GitHub verde (vezi cursor-bugbot-merge-gate.md)
  → merge local conform porții → write-back în tracker (fără coloanele de poartă)
  → raport în chat: ce s-a livrat, ce presupuneri s-au făcut, cost observat
```

`ERROR`/`EXPIRED`/`CANCELLED`: citește ce există în `result` și pe branch; ce e
recuperabil se recuperează printr-un agent nou cu context re-injectat; ce nu, se
raportează — nu se re-lansează orbește același prompt.
