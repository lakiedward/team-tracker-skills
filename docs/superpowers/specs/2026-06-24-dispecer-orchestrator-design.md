# Dispecerul — Orchestrator de Focus board (Design)

**Data:** 2026-06-24
**Status:** Design aprobat de user, gata de plan de implementare
**Repo țintă:** `team-tracker-skills` (skill nou, lângă restul skill-urilor team-tracker)

---

## 1. Context & scop

Userul lucrează pe mai multe aplicații (BetRO/Betora, team-tracker, PopicuTips, etc.). Munca de rutină
(bug-uri, funcționalități, teste) e urmărită în app-ul **team-tracker** pe pagina **Focus** — un board
Kanban alimentat din Supabase (`tt_bugs`, `tt_features`, `tt_test_plans`/`tt_test_items`, cu overlay
`tt_focus_tasks` și `tt_triage_marks`). Există deja skill-uri care rezolvă fiecare tip de item
(`resolving-tt-bugs`, `resolving-tt-features`, `resolving-failed-test-plans`, `auto-running-test-plans`)
și skill-uri care scriu teste (`writing-ai-test-plans`, `writing-tester-test-plans`).

**Problema:** azi userul deschide manual câte o sesiune per proiect și o supraveghează. Vrea un singur punct
de comandă care, la o comandă scurtă, citește board-ul Focus, își dimensionează singur o flotă de muncitori
paraleli, pune fiecare muncitor să ruleze skill-ul potrivit, ține totul „în check" prin guardrails, și
raportează — ca userul să-și păstreze atenția doar pentru lucruri creative.

**Soluția (acest design):** un skill nou — **„Dispecerul"** — invocat ca `/orchestrate <proiect>`
(ex. `/orchestrate betro`). Rulează **în clientul Claude Code interactiv, pe abonamentul MAX** (nu app
separat), refolosind skill-urile existente ca „muncitori".

### De ce „aici, pe MAX" și nu un app desktop separat
Orchestrarea programatică dintr-un app separat (SDK / sesiuni headless pornite de un daemon) tinde să
consume **API plătit la token**, nu abonamentul. Abonamentul MAX se folosește când munca rulează în clientul
interactiv Claude Code. Deci „aici" e și calea care chiar valorifică MAX-ul, și calea cu cel mai mic efort
(refolosim skill-urile, nu rescriem nimic). Un app/daemon separat rămâne o opțiune de viitor (vezi §13, v3),
nu pentru v1.

### Câștig de calitate „gratuit"
Pentru fiecare task, **Dispecerul scrie el promptul muncitorului** → calitate de prompt AI by design,
userul nu mai scrie prompturi.

---

## 2. Ce NU este (non-goals pentru v1)

- **Nu** e un app desktop / daemon separat. E un skill care rulează în Claude Code.
- **Nu** rulează nesupravegheat pe cron în v1 (doar la comandă). Cron-ul vine în v3.
- **Nu** atinge mai multe proiecte într-o comandă în v1 (doar BetRO). Multi-proiect în v2.
- **Nu** atinge itemele „creative" — userul le rezolvă manual, în chat separat. Itemele creative se
  marchează pe board ca scoase din scope (vezi §9).
- **Nu** rescrie logica skill-urilor existente. Le orchestrează și le adaptează minimal (§8).

---

## 3. Decizii cheie (toate confirmate cu userul)

| # | Decizie | Valoare |
|---|---------|---------|
| 1 | Formă | Skill în Claude Code, pe MAX (nu app separat) |
| 2 | Comandă | `/orchestrate <proiect>` (v1: `/orchestrate betro`) |
| 3 | Sursa de muncă | Pagina Focus = `tt_bugs` + `tt_features` + `tt_test_plans` din Supabase |
| 4 | Scope v1 | BetRO (`project_id = 1`), **toate trei** tipurile: bug-uri + features + teste |
| 5 | Muncitori | Skill-urile existente, câte unul per item, în paralel |
| 6 | „Gata" = include teste | Fiecare implementare se termină cu **scrierea testelor** (execută recomandarea Step 5) |
| 7 | Autonomie | **Full auto + escaladează când nu e sigur** |
| 8 | Întrebări | Parcate (ne-blocante), strânse în lot, afișate în **chat-ul principal** |
| 9 | Aterizare cod | **Model C**: worktree izolat → auto-merge DOAR dacă verificarea trece; altfel parcat |
| 10 | Paralelism | **Model A**: paralel la implementat, **coadă** la verificat-în-preview (SQL-verify rămâne paralel) |
| 11 | Câți muncitori | Câți „vrea el" (dimensionat după muncă), sub un **plafon de siguranță** auto-calculat |
| 12 | Adâncime rulare | **(ii) Buclă până se golește** board-ul (runde), nu o singură rundă |
| 13 | Cost | Inclus în MAX |

---

## 4. Arhitectură de ansamblu

```
/orchestrate betro
        │
        ▼
┌─────────────────────────────────────────────────────────────┐
│  DISPECERUL (skill, în chat-ul principal)                    │
│  - rezolvă proiect → project_id + repo path                  │
│  - citește Focus (Supabase) = lista de muncă                 │
│  - triază: tip, claritate, risc, zonă de cod                 │
│  - scrie promptul fiecărui muncitor                          │
│  - lansează Workflow-ul (flota) + conduce bucla              │
│  - strânge întrebările parcate → le pune userului în lot     │
│  - raportează                                                │
└───────────────┬─────────────────────────────────────────────┘
                │  fan-out (paralel, plafonat)
   ┌────────────┼────────────┬───────────────┐
   ▼            ▼            ▼               ▼
 worker(bug)  worker(feat) worker(test)   worker(test-failed)
 worktree A   worktree B   (no edit)      worktree C
   │            │            │               │
   │ rulează skill-ul potrivit + scrie teste la final            │
   │            │            │               │
   └─── verify: preview prin COADĂ (lease) · SQL paralel ────────┘
                │
        verde → auto-merge + status „gata" pe Focus
       altfel → PARCAT (worktree păstrat, status „blocat — te așteaptă")
```

Logica grea (fan-out, coadă, runde) trăiește într-un **Workflow** pe care skill-ul îl lansează
(`Workflow` tool — pipeline/parallel, plafon de concurență, buget). Skill-ul `/orchestrate` e „creierul"
care pregătește datele și interpretează rezultatele.

---

## 5. Ciclul de viață

### Faza 0 — Rezolvă & citește
- Mapează argumentul (`betro`) → `project_id` + **calea repo-ului pe disc**. team-tracker-skills au deja
  maparea slug→id în `tt_projects` (1=betro, 2=team_tracker, 7=culcush, …). Dispecerul are nevoie în plus
  de **calea pe disc** a fiecărui proiect (registru, §7.2), fiindcă pornește din chat-ul principal, nu din
  cwd-ul proiectului.
- Citește Focus pentru acel proiect din Supabase (oglindește logica din `FocusView.tsx`):
  - bug-uri `status ∈ {Open, In Progress}`
  - features `status ∈ {Propus, Planificat}` (+ În lucru)
  - test plans `failed` / `pending` / `blocked` (ne-arhivate)
- Rezultă **lista de muncă** brută.

### Faza 1 — Triază & gândește (creierul)
Pentru fiecare item, Dispecerul decide:
- **Tip → skill:** bug → `resolving-tt-bugs`; feature → `resolving-tt-features`; test failed/blocked →
  `resolving-failed-test-plans`; test pending (AI) → `auto-running-test-plans`.
- **Claritate:** e destul de specificat ca să meargă singur? Dacă e **clar ambiguu** → strânge o întrebare
  țintită (nu ghicește).
- **Risc:** atinge ceva ireversibil (migrare DB, ștergeri, push, native-only)? Native-only → amânat cu notă
  (skill-urile fac deja asta). Ireversibil → poartă (cere OK).
- **Zonă de cod:** ce fișiere/arie atinge probabil (din titlu/descriere) → pentru gruparea anti-conflict (§6).
- **Prioritate/efort** (din board) → ordine și dimensionarea flotei.

Output: `{ taskuri auto-rulabile }` + `{ întrebări de pus la început }`.

**Lot de întrebări la început:** dacă există taskuri clar ambigue, Dispecerul **le pune pe toate odată în
chat-ul principal ÎNAINTE de a porni flota**. Userul răspunde → răspunsurile se țes în prompturi. În full
auto, dacă **nu** sunt ambiguități, pornește direct (planul se afișează ca FYI, nu ca poartă de aprobare).

### Faza 2 — Fan-out (flota)
Pentru fiecare task auto-rulabil, un muncitor (subagent prin Workflow), fiecare:
- în **propriul git worktree** al proiectului (editare izolată, fără coliziuni),
- rulând **skill-ul potrivit scopat pe UN singur item** (§8), cu promptul scris de Dispecer,
- cu regulile de incertitudine injectate (**parchează, nu ghici**).

Concurența: vezi §6 (model A + plafon + grupare pe zone).

### Faza 3 — Verifică & aterizează (pe măsură ce termină fiecare — pipeline, nu barieră)
- Muncitorul auto-verifică prin mecanismul skill-ului: **Vite preview** (UI) sau **SQL impersonation**
  (RLS/DB). Preview-ul trece prin **coadă** (un singur lease, §6); SQL e paralel.
- **Pasul de teste (definiția de gata):** după verificare, muncitorul **execută recomandarea Step 5** a
  skill-ului — rulează `/writing-ai-test-plans` și/sau `/writing-tester-test-plans` după arborele de decizie
  (§ tabelul de mai jos). Asta e diferența față de azi: Step 5 doar *recomandă*; Dispecerul *execută*.
- **Verde (verificat + sigur)** → **auto-merge** worktree → branch, commit cu mesaj clar, status item → „gata"
  pe Focus (+ arhivare dacă e cazul).
- **Pică / nesigur / ireversibil / conflict la merge** → **PARCAT**: worktree-ul rămâne intact, nu se
  merge-uiește, item-ul → „blocat — te așteaptă" cu motivul + întrebarea.

**Arborele de teste** (există deja ca Step 5 în `resolving-tt-bugs`; îl executăm):

| Cum s-a încheiat itemul | Scrie | De ce |
|---|---|---|
| Verificat prin **Vite preview** (UI/copy/navigare) sau **SQL** (RLS/backend) | **`/writing-ai-test-plans`** | AI runner-ul re-rulează singur canalul care tocmai a dovedit fix-ul |
| Native-only / telefon real / judecată vizuală-UX / credențiale | **`/writing-tester-test-plans`** | Iese din DOM/SQL — doar un om pe device confirmă |
| Ambele tipuri în același item | **Ambele** (plan AI pt web/DB + plan uman doar pt native/subiectiv) | Nu pui omul să re-testeze ce poate AI-ul |
| Doar refactor intern / nimic vizibil / deja acoperit de un plan | **Niciun test nou** (spune explicit) | Un plan duplicat e doar zgomot în coada QA |

### Faza 4 — Raport & întrebări
În chat-ul principal, un raport consolidat:
- ✅ **Făcute & merge-uite:** N (o linie fiecare + commit)
- ⏸️ **Parcate pentru tine:** M (fiecare cu întrebarea/blocajul concret)
- ❌ **Picate:** câte au fost, cu motivul
- runde rulate, plafon/timp consumat

Întrebările parcate se pun în lot. Userul răspunde → **o rulare de reluare** reia DOAR acele iteme (cu
răspunsurile / după deblocare), prin același pipeline.

---

## 6. Modelul de paralelism (A) — detaliu

Muncitorii **implementează în paralel** (fiecare în worktree-ul lui — editarea de cod e independentă), dar
**verificarea-în-preview e serializată** printr-o coadă, pentru că preview-ul Vite e **single-tenant** (un
server, port 3000). Asta e și motivul pentru care `resolving-tt-bugs` rulează bug-urile secvențial — noi
păstrăm paralelismul unde contează (gândit + scris cod, ~90% din timp) și serializăm doar checkul de preview.

- **Lease pe preview:** un singur muncitor „deține" preview-ul la un moment dat. Ceilalți care au nevoie de
  preview așteaptă lease-ul. Verificarea **SQL impersonation** nu are resursă comună → rulează paralel.
- **Plafon de concurență:** „câți vrea el" dimensionat după muncă, dar sub un plafon de siguranță auto-calculat:
  - motorul Workflow plafonează oricum concurența la `min(16, nuclee-2)` și pune restul la coadă;
  - **fiecare muncitor e o mini-echipă** (skill-ul lui pornește proprii subagenți) → 10 muncitori pot însemna
    40+ agenți reali; plafonul ține cont de asta;
  - **MAX are limite de rată** → prea multe sesiuni = throttling. Plafonul rămâne prietenos cu MAX.
- **Grupare anti-conflict (pe zone de cod):** Dispecerul **nu lansează doi muncitori în aceleași fișiere
  deodată** (le secvențiază pe baza zonei estimate în Faza 1); paralelizează pe zone independente. Dacă totuși
  două merge-uri ating aceleași fișiere, al doilea dă **conflict → parcat** (model C, niciodată force).

**Model B (un preview per worktree, paralelism total)** — fiecare worktree pornește propriul Vite pe portul
lui → și verificarea-i paralelă. Debit maxim, dar N procese Node/Vite pe PC + management de porturi + trebuie
confirmat că preview MCP poate conduce mai multe servere. **Amânat la v2.**

---

## 7. Componente de construit

Puțin cod nou — majoritatea e refolosire + orchestrare.

### 7.1 Skill-ul `/orchestrate` (artefactul principal)
`team-tracker-skills/plugins/team-tracker/skills/orchestrate/SKILL.md` — creierul: citește board, triază,
scrie prompturi, lansează & conduce Workflow-ul (flota + bucla), strânge întrebări, raportează. Logica de
fan-out/coadă/runde stă în scriptul de Workflow pe care îl lansează.

### 7.2 Registru de proiecte
Fișier mic (JSON) cu maparea **nume → `project_id` → cale repo pe disc** (+ numele de preview din
`.claude/launch.json`). Necesar fiindcă Dispecerul pornește din chat-ul principal, nu din cwd-ul proiectului.
v1: o singură intrare (BetRO → id 1 → `C:/Users/lakie/Desktop/BETRO` → preview `vite-dev:3000`).

### 7.3 Adaptor de muncitor (scop pe un singur item)
Skill-urile existente azi **mătură toate** itemele unui proiect. Muncitorul vrea „fă FIX item-ul ăsta, în
worktree-ul ăsta". Necesită o **adaptare mică** a skill-urilor: să accepte un **target explicit**
(`project_id`, `source_root`, `item_id`) și să **sară peste auto-detecția din cwd + clasificarea în masă**,
procesând un singur rând. (Detaliul exact — vezi §8 și §14.)

### 7.4 Scriere status înapoi (write-back)
Helper care pune pe board `In Progress` / `gata` / `blocat de AI` + notă (ref worktree/commit), folosind
exact tabelele și convențiile pe care skill-urile le scriu deja (`tt_bugs`/`tt_features`/`tt_focus_tasks`…).
team-tracker se reîmprospătează live (`useRealtime`) → **board-ul devine dashboard, gratis**.

### 7.5 Pâlnia de întrebări
Convenția structurată prin care un muncitor parcat își codifică întrebarea (item, motiv, întrebarea
concretă, ce-i trebuie ca să continue), ca Dispecerul s-o strângă în lot și rularea de reluare s-o consume.

---

## 8. Integrarea cu skill-urile existente (preocuparea-cheie de inginerie)

Trei lucruri de reconciliat între „skill care mătură din cwd" și „muncitor pe un item, în worktree":

1. **Proiect din cwd → proiect explicit.** Skill-urile fac Step 0 = `basename "$(pwd)"` → slug → id.
   Muncitorul rulează într-un worktree cu nume arbitrar. Două căi:
   - **(recomandat) Override explicit:** Dispecerul pasează `project_id` + `source_root` (calea worktree-ului);
     skill-ul, dacă le primește, **sare peste Step 0**. Curat, dar atinge skill-urile.
   - **(fallback zero-touch) Trucul de denumire:** worktree creat ca `<tmp>/<runId>/betro` → `basename` =
     `betro` → Step 0 rezolvă corect, fără modificări de skill. Fragil dacă slug-ul ≠ numele de folder dorit.
   Alegerea finală — în planul de implementare.

2. **Sweep → un singur item.** Skill-ul să accepte un `item_id` țintă și să proceseze doar acel rând (sare
   peste clasificarea în masă din Step 2). Adaptare mică, retro-compatibilă (fără target → comportament vechi).

3. **Secvențial-pe-bug → un muncitor per item.** Skill-ul e secvențial *în interiorul* unui sweep din cauza
   preview-ului single-tenant. Noi nu rulăm sweep-ul în paralel; rulăm **N muncitori cu câte un item**, iar
   coliziunea pe preview e rezolvată de coada cu lease (§6). Consistent.

`auto-running-test-plans` și `resolving-failed-test-plans` se integrează la fel (scop pe un plan/item).

---

## 9. Guvernare / plase de siguranță

Peste guardrails-urile pe care skill-urile le au deja (native → amânat; verifică-înainte-de-`Fixed`;
max 3 cicluri de retry; nu atinge alt proiect), Dispecerul adaugă:

- **Cele 5 reguli de incertitudine → parchează** (nu ghici):
  1. task prea vag ca să știi ce înseamnă „gata";
  2. mai multe interpretări valide / decizie de design cu miză;
  3. acțiune ireversibilă (ștergere, migrare DB, push, trimis în afară);
  4. skill-ul și-a epuizat retry-urile și tot pică (anti-chin);
  5. încredere mică că fix-ul chiar e corect.
- **Verificarea = poarta spre merge** (model C). Nimic neverificat nu aterizează.
- **Poartă pe ireversibile:** migrare DB / ștergere / push / trimis în afară → cer OK explicit, chiar în full auto.
- **Plafon de rundă/timp** (§10) + oprire la rate-limit: nu mai porni muncitori noi, termină ce-i în aer, raportează.
- **Itemele creative sunt intangibile:** convenție de marcare pe board (ex. prioritate/etichetă „mâna mea"
  sau un `tt_triage_marks` dedicat) → Dispecerul le sare. (Mecanismul exact — în plan.)

---

## 10. Bucla până se golește (rularea (ii)) + terminare

O comandă `/orchestrate betro` rulează **în runde**:

1. Citește lista de muncă actuală (bug-uri + features + teste).
2. Fan-out + verify + teste + aterizare (Fazele 2–3).
3. Pasul de teste produce **planuri AI noi** → runda următoare le ia cu `auto-running-test-plans` → ce pică
   intră la `resolving-failed-test-plans` → posibil fix nou → iar teste… (bucla de calitate se închide singură).

**Terminare** (oricare):
- o rundă completă nu produce **niciun item nou acționabil** (tot ce rămâne e parcat / blocat / „te așteaptă");
- s-a atins **plafonul de rundă/timp**;
- rate-limit MAX.

**Anti-buclă-infinită:** un set „văzute/încercate" pe `runId` — același item nu se reia la nesfârșit în
aceeași comandă; ce-a parcat o dată rămâne parcat până la rularea de reluare (după răspunsul userului).

---

## 11. Erori & cazuri limită

- Muncitor mort / eroare API → doar acel task se parchează; ceilalți merg (pipeline-ul izolează).
- Conflict la merge → parcat, niciodată force.
- Preview / Supabase indisponibil → verificarea nu poate trece → parcat (fail-safe; nimic neverificat nu intră).
- Două taskuri pe aceleași fișiere → worktree-urile izolează editarea; merge-urile sunt secvențiale; al doilea
  re-check/rebase, conflict → parcat (§6).
- Rularea de reluare e idempotentă (re-citește board-ul; itemele deja „gata" se sar).
- Supabase MCP deconectat / `source_root` lipsă / proiect nerezolvabil → self-abort cu o linie (ca skill-urile).

---

## 12. Testarea Dispecerului însuși

- **Mod dry-run:** triază + plan + **prompturile pe care LE-AR trimite**, fără execuție. Userul verifică
  înainte de prima rulare reală.
- Prima rulare reală: pe 2–3 bug-uri BetRO cu risc mic, urmărind un ciclu complet.
- Verificarea refolosește mecanismele preview/SQL ale skill-urilor (deja dovedite).

---

## 13. Faze

- **v1 (construim acum):** BetRO, la comandă, **toate trei** tipurile, model A (paralel + coadă preview),
  model C (aterizare), buclă-până-se-golește (ii), pas de teste obligatoriu, raport + write-back în chat.
- **v2:** **multi-proiect** („dă-i la tot" peste proiecte) + opțional **model B** (preview per worktree).
- **v3:** **cron / always-on** (pornește singur când apar iteme pe Focus) + Focus board șlefuit ca dashboard
  live (statusul deja se scrie acolo). Eventual un strat subțire de UI/daemon — abia aici, dacă se dovedește.

---

## 14. Riscuri & întrebări deschise (pentru planul de implementare)

1. **Mecanismul de override pe skill-uri** (explicit vs trucul de denumire worktree) — §8.1. De ales în plan.
2. **`resolving-tt-features` are un Step 5 simetric cu `resolving-tt-bugs`?** De confirmat la planificare;
   dacă nu, adăugăm pasul de teste și acolo.
3. **Marcarea itemelor „creative" / intangibile** — ce câmp/etichetă pe board folosim (§9). De stabilit.
4. **Preview MCP poate conduce mai multe servere?** Blochează model B (v2), nu v1.
5. **Plafonul concret de concurență** — formula exactă (nuclee, mini-echipe, rate-limit MAX). De calibrat la rulare.
6. **Worktrees pe Windows** — `git worktree` + curățare; confirmă că BetRO e repo git curat și că worktree-urile
   se șterg după merge/abandon.
