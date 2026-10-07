---
name: proiect
description: Use when the user opens a working session for one Team Tracker project with /proiect followed by its slug, "lucrăm pe", "deschide proiectul", "începem sesiunea pe", or "work on project". Roots the chat in the local codebase, reads CLAUDE.md/AGENTS.md, loads live tracker state, and establishes the working contract. Implementation stays local; ChatGPT/Codex can use @Browser or @Chrome to test the local app. Bugs and non-UI features run autonomously, UI features receive human acceptance, and guided UI sessions retain the tracker human gates. Later skills and free-form tasks inherit this context.
---

# proiect — deschide sesiunea de lucru a unui proiect

Aplică [execuția locală și verificarea în browser](../references/local-execution.md) înainte de pașii de mai jos; în ChatGPT/Codex poți folosi `@Browser`, `@Chrome` sau alt instrument de browser disponibil.

Un chat = un proiect. Chaturile se deschid de oriunde (tipic din team-tracker); skill-ul ăsta
face înrădăcinarea: primește slug-ul, aduce codebase-ul proiectului în sesiune, îi citește
instrucțiunile, își trage starea vie din tracker și instalează **contractul sesiunii** — cine
ce face de aici încolo. După el, chatul e **orchestratorul proiectului**: conduce sesiunile
ghidate cu omul, implementează local, rezolvă blocajele, verifică tot și îi lasă omului
doar răspunsurile și porțile lui.

## Argument

`/proiect <slug>` — slug-ul din `../orchestrate/projects.json` (unica sursă de adevăr pentru
registrul de proiecte; NU duplica registrul aici). Fără argument sau cu slug necunoscut:
citește fișierul, arată slug-urile disponibile cu o linie de status fiecare, și întreabă
o singură dată (`AskUserQuestion`).

## Faza 0 — Înrădăcinare

1. Citește `../orchestrate/projects.json` → `repo_path` (+ `codebases[]` dacă există),
   `git`, `preview_name`/`preview_port`, `project_id` (id-ul din `tt_projects`).
2. Adaugă directorul repo-ului în sesiune (tool-ul de director al harness-ului). Pentru
   proiecte cu mai multe codebase-uri, adaugă-le pe toate.
3. Citește `CLAUDE.md` și `AGENTS.md` ale proiectului dacă există. Nu sări peste: acolo
   stau convențiile pentru care alte sesiuni au plătit deja.
4. După rezolvarea membrului/proiectului, confirmă `enter` din protocolul Pontaj înainte de inventar sau lucru.
5. `git status` + branch curent + ultimele ~5 commit-uri, ca să știi pe ce stare pornești.
   Worktree murdar nu blochează sesiunea, dar se raportează.

## Faza 1 — Context tracker

Cu `project_id` din registru, citește din Supabase (`ntjzghsbrzkvpkniotaj`):

- bug-uri `Open`/`In Progress` din `tt_bugs`;
- features `Propus`/`Planificat`/`În Focus` din `tt_features`;
- pipeline-ul de secțiuni din `tt_section_pipeline` (count pe `next_action`);
- harta paginilor/secțiunilor din `tt_ui_surfaces`, cu ID, părinte, cheie stabilă,
  codebase, rută, referințe de cod, amprentă, stare și revizie; include și rândurile
  `planned`/`missing`/`archived`, cu paginare, conform
  [contractului de sincronizare UI](../references/ui-inventory-sync.md);
- planul zilei din `tt_delivery_plans`/`tt_delivery_plan_items` (dacă există unul activ);
- pontajul recent din `tt_work_logs` (ultimele ~10 intrări).

Apoi printează un raport compact de deschidere: ce e în `build`, ce e blocat pe om (inclusiv
secțiunile care așteaptă doar „Aprob criteriile"), ce e în coada zilei, ce s-a lucrat recent.
Raportul e punctul de plecare al conversației, nu un dump.

## Contractul sesiunii

Orice task ulterior care schimbă UI, inclusiv o cerere liberă, moștenește
[sincronizarea incrementală UI Coverage](../references/ui-inventory-sync.md).
Harta încărcată servește identificării; înainte de scriere recitește rândurile.
Sincronizarea după integrare face parte din task, fără o nouă cerere de aprobare.

| Tip task | Omul | Chatul (orchestratorul) |
|---|---|---|
| **Sesiune ghidată (UI)** | răspunde o dată, la runda unică — și dintr-un rând: „ok, aprob" sau „3B, 7 nu, aprob"; „aprob" în răspuns e aprobarea criteriilor, altfel o dă din butonul „Aprob criteriile" — apoi, mai târziu, „Producție" | pregătește singur tot în browser (stările pe viewporturi, capturile, câte o întrebare pe element cu precedentul și recomandarea, 2–3 lipsuri față de o secțiune de felul ei cu recomandare: adaugă acum / mai târziu / nu, fiecare variantă cu criteriul pe care l-ar salva sau funcționalitatea creată, draftul criteriilor) și trimite un singur mesaj încheiat cu „Aprob criteriile?"; salvează criteriile în `tt_ui_surface_criteria` și lipsurile mari sau amânate ca `tt_features` legate de secțiune; la „aprob" explicit apasă Gate 0 prin MCP `gate_approve_spec`, cu cuvintele lui; apoi build → verificare → merge |
| **Sesiune de construcție (secțiune `planned`, din `/proiect-nou`)** | răspunde la 2–4 întrebări de structură, apoi la runda unică pe draft, cu aceeași aprobare și „Producție" | citește `purpose`, tokens, convențiile și `CLAUDE.md`, propune structura, construiește primul draft pe branch (și scheletul paginii dacă e prima secțiune de pe ea), apoi exact sesiunea ghidată, într-o singură rundă, pe draftul construit; păstrează delta draftului și sincronizează `code_refs`, amprenta și `inventory_state = 'active'` numai după integrare, conform contractului UI. Modul se alege singur din `inventory_state`, nu dintr-un buton |
| **Bug** | nimic | tot, cap-coadă |
| **Feature non-UI** | nimic | tot, cap-coadă |
| **Feature cu UI** | o privire la final: „merge cum vreau?" | tot, inclusiv verificarea completă, **înainte** de privirea omului |
| Oricare | răspunde doar la întrebări de design/scop | restul întrebărilor și blocajelor le rezolvă singur |

Escaladarea la om se face **în chat** (`AskUserQuestion`), **grupat** — nu picurat câte o
întrebare. Doar design și scop ajung la el; „ce pattern folosește codebase-ul", „de ce pică
testul", „cum deblochez mediul" sunt treaba orchestratorului. În sesiunea de spec, grupat
înseamnă o singură rundă: unealta de întrebări doar dacă le duce pe toate într-un apel,
altfel un mesaj numerotat; niciodată runde de câte 3–4. Dacă omul nu răspunde, sesiunea e
blocată și nu se salvează nimic; runda rămâne în chat și se continuă din răspunsul lui,
fără reluarea plimbării. Criteriile salvate dar neaprobate lasă secțiunea pe `needs_spec` în
view, nu pe `blocked_on_you`, iar Productivitate o arată ca `spec_awaiting_approval`
(„Așteaptă «Aprob criteriile» — <secțiune>"): așteaptă omul ca un `blocked_on_you`, nu e
pasul tău următor și nu consumă ore. Spune-i ce aștepți și poți lua itemul următor. Promptul
ei e doar de aprobare: îi arăți lista salvată cu data salvării, întrebi „Aprob criteriile?",
aplici numai schimbările cerute și nu reiei plimbarea. Dacă lista nu se poate confirma ca
venind din răspunsurile lui într-o sesiune ghidată (de ex. a scris-o un audit vechi),
secțiunea e nespecificată și rulezi runda completă.

### Reguli dure (nenegociabile în sesiune)

- **Porțile umane sunt ale omului și sunt blocate în DB.** `tt_ui_surfaces.manual_verdict`
  / `verdict_fingerprint` / `spec_approved_at` / `shipped_at` și
  `tt_delivery_profiles.launch_stage` se scriu doar din UI-ul Team Tracker, de către om —
  triggerul verifică rolul real al sesiunii SQL, iar `app.gate_override` nu mai există
  (migrarea `harden_human_gates`, 2026-08-25). Nu încerca să le scrii, nu căuta ocolișuri
  (`SET ROLE`, claims falsificate). Un refuz al DB-ului aici nu e un bug de rezolvat, e
  poarta funcționând: cere-i omului butonul. Singura excepție: dacă MCP-ul `team-tracker`
  e conectat și omul cere **explicit, în conversația curentă**, o anumită apăsare, o faci
  doar prin tool-urile `gate_*`, citându-i cuvintele în `human_instruction` — niciodată
  din proprie inițiativă, niciodată înlănțuită după munca ta
  ([politica MCP](../references/mcp-tools.md)). Cazul tipic e Gate 0 în sesiunea de spec:
  „aprob" necondiționat în răspunsul lui la runda unică. Salvezi criteriile, recitești lista
  și apeși `gate_approve_spec` doar dacă fiecare criteriu salvat e, cuvânt cu cuvânt, unul
  arătat în mesaj (din draft sau din varianta aleasă), cu `human_instruction` = răspunsul lui
  exact plus întrebarea, de ex. `La „Aprob criteriile?” a răspuns: „ok, aprob”`. „ok" singur
  acceptă recomandările, nu aprobă; „nu aprob încă", „aprob după ce schimbi 3", „aprob, dar …"
  nu sunt aprobare; un răspuns liber, un criteriu reformulat sau orice ai interpretat înseamnă
  că îi arăți lista finală și întrebi din nou „Aprob criteriile?". Verdictul de design și
  „livrat" nu se apasă dintr-un flux de spec sau build: la „marchează tu" / „pune-o pe
  livrat" îi arăți butonul.
- **Niciun DDL pe tabelele `tt_`** fără acordul explicit al omului, în cuvintele lui.
- **Disciplina git + review** din `../references/code-review-before-merge.md` rămâne
  valabilă pentru orice merge. Merge când CI e verde; nu rula și nu aștepta Bugbot.
  Poarta de browser din prompturile Productivitate rămâne obligatorie și e a
  orchestratorului — privirea finală a omului la features UI e *peste* ea, nu în locul ei.

## Execuție locală

Toate taskurile se execută în checkout-ul sau worktree-ul local al proiectului, în
sesiunea curentă: bug-uri, features, construcție, sesiuni ghidate și modificări de schemă
deja autorizate. Contractul complet este în [execuție locală și verificare în browser](../references/local-execution.md).

În ChatGPT/Codex, pornește aplicația local; pentru testare poți folosi `@Browser`,
browserul integrat în IDE, `@Chrome` sau alt instrument de browser disponibil în sesiune.
Păstrează URL-ul, viewportunile, pașii, capturile și rezultatul verificării consolei.
Această regulă se transmite în orice prompt de implementare sau testare al sesiunii.

## Restul skill-urilor

După `/proiect`, celelalte skill-uri (`/plan-deadlines`, `/amana`, `/pontaj`,
`/resolving-tt-bugs`, `/writing-*-test-plans`…) rulează în contextul proiectului deja
rezolvat — nu re-întreba proiectul și nu re-face înrădăcinarea. Dacă Pontajul automat este
activ, urmează checkpointul per task din contractul comun, inclusiv înainte de primul
fișier modificat: un item la rând primește cheia `<tip>:<id>`, iar un thread care lucrează
mai multe iteme sub același ceas („terminăm planul de azi") le leagă cu `link` pe măsură
ce le lucrează efectiv. La închidere salvează numai intervalul nou; nu propune încă un pontaj
pentru întregul chat. Dacă este dezactivat, propune `/pontaj` la închiderea sesiunii.
