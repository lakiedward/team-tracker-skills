# Worktrees — Dispecerul (firul principal / conductor)

Comenzile exacte de `git worktree` pe care **conductorul** (firul principal, SKILL.md) le rulează
într-o rundă completă (Milestone C). Worktree-ul în sine îl **creează muncitorul** ca primă acțiune
(scriptul de Workflow n-are acces la git); conductorul face **merge / cleanup** după ce Workflow-ul
întoarce rezultatele.

## Convenții de nume (identice peste workflow + conductor)

| Element | Valoare |
|---|---|
| Worktrees root | `C:/Users/lakie/Desktop/.orch-worktrees` |
| Calea worktree-ului (per item) | `C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>` |
| Branch-ul de lucru | `orch/<itemId>` |
| `<runId>` | timestamp generat de **conductor** (vezi mai jos) — NU de Workflow |
| `<slug>` | slug-ul proiectului din `projects.json` (ex. `betro`) |
| `<itemId>` | `id`-ul itemului (bug/feature/test plan) |
| `<repo_path>` | `repo_path` al proiectului din `projects.json` |

> **`<runId>` se generează în firul principal**, nu în Workflow. Scriptul de Workflow rulează în
> sandbox-ul harness-ului unde `Date.now()`, `Math.random()` și `new Date()` fără argumente **aruncă** —
> deci nu poate fabrica un id unic. Conductorul îl produce o singură dată per comandă, înainte de prima
> rundă, dintr-un timestamp Unix și îl pasează în `args.run_id` la fiecare lansare de Workflow:
> ```bash
> date +%s
> ```
> (ex. `run_id = "1750762800"`). Toate rundele aceleiași comenzi `/orchestrate` folosesc **același** `run_id`,
> deci worktree-urile rundelor stau grupate sub `.orch-worktrees/<runId>/`.

---

## CREATE (per item) — branch nou din HEAD-ul curent al repo-ului

Rulat de **muncitor** ca primă acțiune (sau, în acceptance manual, de conductor). Branch nou `orch/<itemId>`
pornit din `HEAD`-ul repo-ului sursă, materializat într-un worktree izolat:

```bash
git -C <repo_path> worktree add -b orch/<itemId> C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId> HEAD
```

Imediat după `worktree add`, muncitorul **junctionează `node_modules`** și **copiază `.env`** din repo. Un
worktree proaspăt NU are `node_modules` (gitignored) și nici `.env`/`.env.local` (gitignored) → fără ele
muncitorul nu poate rula vite preview / tsc / lint, deci nu poate **VERIFICA** fix-urile UI (totul ar ajunge
parcat). Junction-ul e partajat și folosit doar la **citire** de vite/tsc/lint (sigur și în paralel; fără admin):

```bash
cmd //c mklink //J "C:\Users\lakie\Desktop\.orch-worktrees\<runId>\<slug>-<itemId>\node_modules" "<repo_path-backslash>\node_modules"
cp "<repo_path>/.env" "C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>/.env" 2>/dev/null || true
cp "<repo_path>/.env.local" "C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>/.env.local" 2>/dev/null || true
```

- `mklink //J` (junction) merge **DOAR** fiindcă `<wt>/node_modules` încă **nu există** într-un worktree
  proaspăt; folosește căi Windows cu backslash în argumentele `mklink` (`cmd //c` e felul în care Git Bash
  invocă cmd).
- Muncitori paraleli care junctionează **același** `node_modules` e sigur — vite/tsc/lint doar **CITESC** ținta.
- **Port preview worktree:** la verificarea-pe-preview, muncitorul folosește un port **DEDICAT** orchestratorului — `39000 + (item_id % 1000)` — **NU** portul implicit al proiectului (poate fi ocupat de dev server-ul userului sau de alt worktree). Îl scrie în `<wt>/.claude/launch.json` (câmpul `port` + orice `--port <n>` din runtimeArgs) **înainte** de `preview_start`; bump `+1`/`+2` la EADDRINUSE (max 3). Worktree-ul e disposable → editarea launch.json-ului lui e sigură și izolată. (Test-runnerele `auto-running-test-plans` rulează în repo_path, nu în worktree: dacă portul implicit e ocupat, e chiar dev server-ul live — îl folosesc, fără să editeze launch.json-ul real.)

- Worktree-ul are propriul working tree → muncitorii paraleli nu se calcă pe fișiere.
- `BETRO` (repo-ul sursă) **rămâne pe branch-ul lui** — `worktree add` nu schimbă HEAD-ul repo-ului principal.
- Muncitorul lucrează **exclusiv** în `<...>/<slug>-<itemId>` și committuiește acolo:
  ```bash
  git -C C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId> add -A
  git -C C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId> commit -m "orch: <item>"
  ```

---

## MERGE-IF-GREEN (firul principal, secvențial)

**Numai după** ce muncitorul a committuit în worktree ȘI rezultatul a trecut poarta de verificare: `outcome ∈
{fixed,done}` **ȘI `verified === true`** (vezi SKILL.md Pas C5.1 — un verde cu `verified:false` provine de la un
verificator mort și NU se merge-uiește). Conductorul face merge **un singur item odată** (secvențial — niciodată
două merge-uri în paralel), în `<repo_path>`:

```bash
git -C <repo_path> merge --no-ff --no-edit orch/<itemId>
```

Interpretează **codul de ieșire**:

- **Cod zero** → merge reușit. Continuă la **CLEANUP** + write-back DONE.
- **Cod non-zero** → conflict de merge. Abortează imediat și **NU** lăsa repo-ul pe jumătate-merge-uit:
  ```bash
  git -C <repo_path> merge --abort
  ```
  Apoi **PARK** itemul (write-back notă + card blocat, vezi `board-queries.md`) cu
  `question="conflict de merge pe <fișiere>; rezolvă manual"`. **Păstrează** worktree-ul + branch-ul
  (vezi regula de mai jos).

> Merge-ul secvențial e deliberat: chiar dacă gruparea anti-conflict a separat zonele de cod, două branch-uri
> pot atinge același fișier. Merge-uind pe rând, un conflict afectează doar al doilea branch — primul a
> aterizat deja curat.

---

## CLEANUP (după merge reușit SAU abandon explicit) — **JUNCTION-FIRST (SAFETY-CRITICAL)**

**Ordine obligatorie:** scoate ÎNTÂI junction-ul `node_modules`, ABIA APOI worktree-ul. Aceasta e **sursa unică
de adevăr** pentru ordinea de cleanup — toți pașii conductorului (SKILL.md Pas C5.0 / C5.2 / C6) o referențiază.

```bash
cmd //c rmdir "C:\Users\lakie\Desktop\.orch-worktrees\<runId>\<slug>-<itemId>\node_modules"   # scoate DOAR reparse point-ul junction-ului, NU ținta. NICIODATĂ 'rmdir /s' aici.
git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>
git -C <repo_path> branch -D orch/<itemId>
```

> ## ⚠️ PERICOL — de ce junction-first
> NICIODATĂ nu rula `git worktree remove --force <wt>` cât timp junction-ul `node_modules` **mai există**.
> `worktree remove --force` face un delete **recursiv** al directorului worktree-ului; dacă junction-ul e încă
> acolo, ștergerea ar putea **traversa junction-ul** și **distruge `node_modules`-ul REAL al proiectului** (ținta
> junction-ului din `<repo_path>`). `rmdir` simplu (plain, **FĂRĂ** `/s`) pe un junction scoate **doar** reparse
> point-ul — ținta rămâne neatinsă. De aceea: `rmdir` junction-ul ÎNTÂI, `worktree remove` ABIA APOI.
>
> **Verificare de siguranță (după cleanup):** confirmă că `<repo_path>/node_modules` **încă există**. Dacă a
> dispărut, ceva a traversat junction-ul — OPREȘTE runda și raportează; nu mai curăța alte worktree-uri.

- `rmdir` (plain) pe junction = scoate doar reparse point-ul; ținta (`<repo_path>/node_modules`) rămâne intactă.
- `worktree remove --force` șterge directorul worktree-ului (chiar dacă are fișiere netracked / build artefacts) —
  **numai după** ce junction-ul a fost scos.
- `branch -D orch/<itemId>` șterge branch-ul de lucru — sigur **doar** după ce a fost merge-uit (sau abandonat).

---

## Regula PARK vs. CLEANUP (memoreaz-o)

| Situație | Worktree + branch |
|---|---|
| **Merge reușit** | **CLEANUP** — șterge worktree-ul și branch-ul `orch/<itemId>` |
| **Abandon explicit** (item picat fără valoare de păstrat) | **CLEANUP** |
| **Muncitor mort** (id trimis dar neîntors de Workflow) | **CLEANUP** worktree-ul orfan la calea deterministă (reconciliere — vezi mai jos) |
| **PARK cu muncă reală** — `blocked`/verde-neverificat/conflict **și** branch-ul are commit-uri | **PĂSTREAZĂ** worktree-ul + branch-ul; userul / o relansare îl reia |
| **PARK gol** — `blocked` la Stage 1, branch **fără commit-uri** | **CLEANUP** — nimic de reluat |

> **Atenție — „munca trăiește în branch" e adevărat DOAR dacă branch-ul are commit-uri.** Un muncitor blocat la
> **Stage 1** (implement) își poate crea worktree-ul dar **nu committuiește nimic** → branch-ul `orch/<itemId>` e
> identic cu HEAD, iar worktree-ul e gol. Un astfel de worktree nu are ce relua și trebuie curățat, nu parcat.
> Înainte de a decide PARK vs CLEANUP, numără commit-urile peste HEAD:
>
> ```bash
> git -C <repo_path> rev-list --count HEAD..orch/<itemId>
> ```
>
> - **`0`** → branch gol → **CLEANUP** (worktree remove + branch -D). Tipic pentru un block la Stage 1.
> - **`>0`** → branch cu muncă reală (verde neverificat, block după implementare, sau conflict de merge) →
>   **PĂSTREAZĂ**. La PARK munca trăiește în branch-ul `orch/<itemId>` și în worktree-ul lui; nu o arunca.
>
> Raportul final listează căile worktree-urilor parcate (cele păstrate) ca să le poată găsi userul.

---

## Reconciliere trimis-vs-întors (worktree-uri orfane de la muncitori morți)

Un muncitor de implementare care **moare** nu apare în lista întoarsă de Workflow — dar și-a putut crea
worktree-ul (prima lui acțiune) înainte să cadă, lăsându-l **orfan**. Conductorul reconciliază ID-urile trimise
(`args.items`) cu cele întoarse; pentru fiecare `id` trimis dar neîntors, curăță worktree-ul orfan la **calea
deterministă** (nu depinde de vreun rezultat — calea e funcție doar de `run_id`, `slug`, `id`), tot **junction-first**
(vezi secțiunea CLEANUP de mai sus — muncitorul putea muri **după** ce a creat junction-ul):

```bash
cmd //c rmdir "C:\Users\lakie\Desktop\.orch-worktrees\<runId>\<slug>-<itemId>\node_modules"   # scoate DOAR reparse point-ul junction-ului, NU ținta. NICIODATĂ 'rmdir /s' aici.
git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>
git -C <repo_path> branch -D orch/<itemId>
```

Ignoră erorile tuturor comenzilor — muncitorul putea muri **înainte** de `worktree add` (atunci nici junction-ul,
nici worktree-ul nu există) sau **între** `worktree add` și `mklink` (atunci junction-ul lipsește, dar worktree-ul
există). `rmdir`-ul junction-ului eșuează inofensiv dacă nu există. **Același PERICOL** ca la CLEANUP: niciodată
`worktree remove --force` înaintea `rmdir`-ului junction-ului. Vezi SKILL.md Pas C5.0.

---

## Cleanup-ul dir-ului părinte al rundei (la sfârșitul rundei)

După ce toate worktree-urile rundei au fost curățate sau parcate, dir-ul părinte
`C:/Users/lakie/Desktop/.orch-worktrees/<runId>` poate rămâne gol. Curăță referințele git stale și încearcă
să-l ștergi — dar **numai dacă e gol** (worktree-uri parcate încă vii ⇒ dir-ul NU e gol ⇒ păstrează-l):

```bash
git -C <repo_path> worktree prune
rmdir C:/Users/lakie/Desktop/.orch-worktrees/<runId>
```

`rmdir` fără `-r` eșuează inofensiv dacă dir-ul nu e gol — deci e sigur să-l rulezi necondiționat. NU forța
ștergerea (`rm -rf`) — ai distruge worktree-uri parcate. Vezi SKILL.md Pas C7.0.

---

## Per-proiect: `git = false`

Dacă `projects.json` are `git=false` pentru proiect (ex. `popicu_tips`), **nu există worktree-uri**:
- Itemele rulează **in-place în `repo_path`**, **serializat** (un singur muncitor odată — nu poți edita în
  paralel același working tree fără izolare).
- Nu se rulează niciun `worktree add` / `merge` / `branch -D`; muncitorul committuiește (dacă repo-ul are
  totuși git fără a fi marcat) sau lasă schimbările pe disc, iar conductorul nu face merge.
- Vezi SKILL.md („Handling `git = false`") pentru flow-ul serializat.

---

## Acceptance — un ciclu manual de worktree (păzit, pe BetRO)

Disposable; **nu** atinge branch-ul real al BetRO:

```bash
git -C C:/Users/lakie/Desktop/BETRO worktree add -b orch/test-0 C:/Users/lakie/Desktop/.orch-worktrees/t/betro-0 HEAD
cmd //c mklink //J "C:\Users\lakie\Desktop\.orch-worktrees\t\betro-0\node_modules" "C:\Users\lakie\Desktop\BETRO\node_modules"   # junction
git -C C:/Users/lakie/Desktop/BETRO worktree list
# CLEANUP — junction-first (vezi secțiunea CLEANUP de mai sus):
cmd //c rmdir "C:\Users\lakie\Desktop\.orch-worktrees\t\betro-0\node_modules"   # scoate DOAR junction-ul, NU ținta. NICIODATĂ 'rmdir /s'.
git -C C:/Users/lakie/Desktop/BETRO worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/t/betro-0
git -C C:/Users/lakie/Desktop/BETRO branch -D orch/test-0
ls C:/Users/lakie/Desktop/BETRO/node_modules >/dev/null && echo "node_modules REAL intact"   # verificare de siguranță
```

Așteptat: `worktree list` arată worktree-ul `betro-0` (cu `node_modules` junction-at); după `rmdir`-ul
junction-ului + `remove` worktree-ul dispare, dar `BETRO/node_modules` REAL **rămâne intact**; `BETRO` rămâne pe
branch-ul lui original, neatins. **PERICOL:** nu inversa ordinea — `worktree remove` înainte de `rmdir`-ul
junction-ului ar putea distruge `BETRO/node_modules`.
