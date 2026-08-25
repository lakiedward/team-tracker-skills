# Cursor Cloud Agents — protocolul de dispatch al orchestratorului

Referință pentru `/proiect`: cum lansează, urmărește și închide chatul-orchestrator un task
trimis unui Cursor cloud agent. Agenții rulează fiecare pe VM-ul lui Ubuntu (repo,
dependențe, desktop + browser + înregistrare video — „Computer Use", feb 2026) și atașează
video/screenshots/loguri pe PR. Ei implementează; **verificarea și merge-ul rămân locale**.

## Precondiții (o dată per mașină)

- `CURSOR_API_KEY` — generată de om în Cursor Dashboard → API Keys.

  **CAPCANĂ (Windows):** `setx` scrie în registru, dar procesele moștenesc blocul de mediu
  al PĂRINTELUI, nu registrul. Dacă Claude Code a pornit înainte de `setx`, nici el nici
  vreun proces-copil al lui nu vede variabila — oricât de nou ar fi shell-ul. Simptom:
  „nu am API key" într-o sesiune, deși cheia e salvată.

  **Înainte de a declara flota indisponibilă, citește registrul:**
  ```powershell
  [Environment]::GetEnvironmentVariable('CURSOR_API_KEY','User')
  ```
  Dacă întoarce o valoare, folosește-o (pas-o ca `$env:CURSOR_API_KEY` în invocările
  scriptate) și menționează o dată că o repornire de Claude Code ar curăța situația.
  Doar dacă și registrul e gol e cazul de fallback local.
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

## Lecții din prima rulare reală (BetRO #678, 2026-08-25)

- **`latestRunId` de pe obiectul agent este sursa de adevăr, NU `runId` returnat la
  creare.** Un al doilea run poate apărea singur. Monitorul a interogat 3½ ore run-ul
  inițial (rămas `RUNNING`) în timp ce agentul terminase demult și deschisese PR-ul.
  Verifică ÎNTOTDEAUNA `GET /v1/agents/{id}` → `latestRunId` înainte de a raporta progres,
  și confirmă cu realitatea de pe GitHub (`gh pr list`), nu doar cu API-ul.
- **Un run se poate bloca în `CREATING` la nesfârșit** (aici: 5 ore). `DELETE /v1/agents/{id}`
  curăță agentul cu tot cu runul mort.
- **`/stream` e conexiune SSE lungă**, nu un dump interogabil — atârnă dacă o apelezi
  sincron. Pentru vizibilitate live folosește cursor.com/agents, nu polling pe stream.
- **On-demand billing NU a fost necesar.** Lansarea a mers direct din abonamentul Ultra.
  Afirmația contrară venea de pe forum, nu din docs. Nu cere omului să activeze facturare
  suplimentară „preventiv" — lansează și citește eroarea dacă apare; o cerere respinsă e gratis.
- **Agentul respectă contractul, dar NU verifică.** A livrat PR draft, a bifat onest doar
  ce a făcut, a lăsat nebifate testele și browserul, și a scris singur „do not merge".
  Planifică de la început ca ÎNTREAGA verificare (teste, tsc, lint, browser, Bugbot) să
  cadă pe orchestrator. Nu e un defect al agentului; e diviziunea corectă.
- **Verdictul Bugbot se citește din `conclusion`** (`success` = curat), prin
  `gh api repos/{owner}/{repo}/commits/{sha}/check-runs` — nu din eticheta „pass" a lui
  `gh pr checks`, și nu din numărul de comentarii.
- **Worktree de verificare:** leagă `node_modules` cu junction de checkout-ul principal
  (`New-Item -ItemType Junction`) în loc de `npm install`. La curățare, scoate junction-ul
  cu `cmd /c rmdir` (FĂRĂ `/s`) înainte de `Remove-Item -Recurse`, altfel riști să ștergi
  `node_modules`-ul real prin legătură. Verifică numărul de intrări înainte și după.
## CLI-ul `cursor-agent` — ce e și ce nu e

Instalat 2026-08-25 (`%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd`, v2026.08.11). Testat,
nu presupus. Două afirmații anterioare din acest document erau GREȘITE și au fost corectate:
CLI-ul *poate* trimite în cloud (prefixul `&`) și *poate* fixa parametrii modelului.

**Numele de modele în CLI sunt PLATE, nu params.** Nu folosi forma din API și nici sintaxa
cu paranteze din `--help`; pentru modelele Cursor, efortul și `fast` sunt în nume:

```
cursor-grok-4.6-xhigh        <- configul decis de Edy (xhigh, FĂRĂ fast)
cursor-grok-4.6-xhigh-fast   <- varianta dublă la preț; a NU se folosi
```
`cursor-agent models` listează tot (208 pe contul lui Edy). Rulează-l dacă un nume e respins.

**Autentificarea scriptată e canal separat de login.** `cursor-agent status` poate raporta
„Logged in" în timp ce `models` eșuează cu „Authentication required". Orice invocare
neinteractivă are nevoie de `CURSOR_API_KEY` pasat explicit în mediu (vezi capcana de la
Precondiții).

**Ce merită folosit din el:**
- `-w, --worktree [name]` + `--worktree-base <branch>` — worktree izolat în
  `~/.cursor/worktrees/<repo>/<name>`, cu scripturi de setup din `.cursor/worktrees.json`.
  **Metoda standard pentru worktree-ul de verificare a unui PR de la flotă** — înlocuiește
  `git worktree add` + junction manual pe `node_modules` + curățarea lui riscantă.
- `-p --print` cu `--output-format json|stream-json`, plus `create-chat` (întoarce un ID) —
  pentru execuție locală scriptabilă, când chiar e nevoie.

**Ce NU înlocuiește:** lansarea structurată în cloud. Prefixul `&` e predare în sesiune, nu
launch cu contract. Pentru agenți care lucrează cu mașina omului stinsă și atașează video pe
PR, **API-ul rămâne calea**. CLI și API sunt complementare, nu concurente.

**`cursor-agent worker`** („private cloud worker that connects to Cursor to run agents in
your environment") activează `env: machine` — agenți lansați din cloud care rulează pe
hardware-ul omului, cu dev server-ul și datele lui reale. Promițător, dar NEPROBAT, și
reintroduce dependența de PC pornit. De păstrat pentru ziua în care un agent din cloud pică
*fiindcă* nu are datele reale — nu înainte.
