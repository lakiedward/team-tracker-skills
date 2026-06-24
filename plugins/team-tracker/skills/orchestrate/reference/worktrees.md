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

- Worktree-ul are propriul working tree → muncitorii paraleli nu se calcă pe fișiere.
- `BETRO` (repo-ul sursă) **rămâne pe branch-ul lui** — `worktree add` nu schimbă HEAD-ul repo-ului principal.
- Muncitorul lucrează **exclusiv** în `<...>/<slug>-<itemId>` și committuiește acolo:
  ```bash
  git -C C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId> add -A
  git -C C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId> commit -m "orch: <item>"
  ```

---

## MERGE-IF-GREEN (firul principal, secvențial)

**Numai după** ce muncitorul a committuit în worktree ȘI rezultatul lui este verde (`outcome` verificat,
nu `blocked`). Conductorul face merge **un singur item odată** (secvențial — niciodată două merge-uri în paralel),
în `<repo_path>`:

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

## CLEANUP (după merge reușit SAU abandon explicit)

```bash
git -C <repo_path> worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/<runId>/<slug>-<itemId>
git -C <repo_path> branch -D orch/<itemId>
```

- `worktree remove --force` șterge directorul worktree-ului (chiar dacă are fișiere netracked / build artefacts).
- `branch -D orch/<itemId>` șterge branch-ul de lucru — sigur **doar** după ce a fost merge-uit (sau abandonat).

---

## Regula PARK vs. CLEANUP (memoreaz-o)

| Situație | Worktree + branch |
|---|---|
| **Merge reușit** | **CLEANUP** — șterge worktree-ul și branch-ul `orch/<itemId>` |
| **Abandon explicit** (item picat fără valoare de păstrat) | **CLEANUP** |
| **PARK** — `outcome=blocked` SAU conflict de merge | **PĂSTREAZĂ** worktree-ul + branch-ul; userul / o relansare îl reia |

La **PARK** munca muncitorului trăiește în branch-ul `orch/<itemId>` și în worktree-ul lui; nu o arunca.
Raportul final listează căile worktree-urilor parcate ca să le poată găsi userul.

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
git -C C:/Users/lakie/Desktop/BETRO worktree list
git -C C:/Users/lakie/Desktop/BETRO worktree remove --force C:/Users/lakie/Desktop/.orch-worktrees/t/betro-0
git -C C:/Users/lakie/Desktop/BETRO branch -D orch/test-0
```

Așteptat: `worktree list` arată worktree-ul `betro-0`; după `remove` dispare; `BETRO` rămâne pe branch-ul
lui original, neatins.
