---
name: proiect
description: Use when the user opens a working session for one team-tracker project — invokes "/proiect <slug>" or says "lucrăm pe <proiect>", "deschide proiectul betro", "începem pe culcush", "sesiune pe motiontimisoara". Roots the chat in that project's codebase (adds the repo directory to the session, reads its CLAUDE.md/AGENTS.md), loads live tracker state from Supabase (bugs, features, section pipeline, today's delivery plan, recent Pontaj) and installs the session's working contract — bugs and non-UI features run fully autonomous, UI features end with one human acceptance look, guided UI sessions leave the human exactly two buttons (approve criteria, mark for production), and well-specified tasks are dispatched to Cursor cloud agents (grok-4.6 xhigh, fast off) while interactive or schema work stays local. All later skills (/plan-deadlines, /amana, /pontaj) and free-form task requests inherit this context. Triggers include "/proiect", "lucram pe", "lucrăm la proiectul", "deschide proiectul", "începem sesiunea pe", "open a project session", "work on project".
---

# proiect — deschide sesiunea de lucru a unui proiect

Un chat = un proiect. Chaturile se deschid de oriunde (tipic din team-tracker); skill-ul ăsta
face înrădăcinarea: primește slug-ul, aduce codebase-ul proiectului în sesiune, îi citește
instrucțiunile, își trage starea vie din tracker și instalează **contractul sesiunii** — cine
ce face de aici încolo. După el, chatul e **orchestratorul proiectului**: conduce sesiunile
ghidate cu omul, trimite implementările către Cursor cloud agents, absoarbe întrebările și
blocajele lor, verifică tot, și îi lasă omului exact două butoane.

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
4. `git status` + branch curent + ultimele ~5 commit-uri, ca să știi pe ce stare pornești.
   Worktree murdar nu blochează sesiunea, dar se raportează.

## Faza 1 — Context tracker

Cu `project_id` din registru, citește din Supabase (`ntjzghsbrzkvpkniotaj`):

- bug-uri `Open`/`In Progress` din `tt_bugs`;
- features `Propus`/`Planificat`/`În Focus` din `tt_features`;
- pipeline-ul de secțiuni din `tt_section_pipeline` (count pe `next_action`);
- planul zilei din `tt_delivery_plans`/`tt_delivery_plan_items` (dacă există unul activ);
- pontajul recent din `tt_work_logs` (ultimele ~10 intrări).

Apoi printează un raport compact de deschidere: ce e în `build`, ce e blocat pe om, ce e în
coada zilei, ce s-a lucrat recent. Raportul e punctul de plecare al conversației, nu un dump.

## Contractul sesiunii

| Tip task | Omul | Chatul (orchestratorul) |
|---|---|---|
| **Sesiune ghidată (UI)** | conduce răspunsurile + 2 apăsări: „Aprob criteriile", „Producție" | conduce sesiunea în browser, întreabă la final și ce lipsește față de o secțiune de felul ei (cu recomandare: adaugă acum / mai târziu / nu), salvează criteriile în `tt_ui_surface_criteria` și lipsurile mari sau amânate ca `tt_features` legate de secțiune, apoi build → verificare → merge |
| **Sesiune de construcție (secțiune `planned`, din `/proiect-nou`)** | răspunde la 2–4 întrebări de structură, apoi conduce verdictele + aceleași 2 apăsări | citește `purpose`, tokens, convențiile și `CLAUDE.md`, propune structura, construiește primul draft pe branch (și scheletul paginii dacă e prima secțiune de pe ea), apoi exact sesiunea ghidată pe draftul construit; la final scrie `code_refs`, amprenta și `inventory_state = 'active'` — nu sunt porți umane. Modul se alege singur din `inventory_state`, nu dintr-un buton |
| **Bug** | nimic | tot, cap-coadă |
| **Feature non-UI** | nimic | tot, cap-coadă |
| **Feature cu UI** | o privire la final: „merge cum vreau?" | tot, inclusiv verificarea completă, **înainte** de privirea omului |
| Oricare | răspunde doar la întrebări de design/scop | restul întrebărilor și blocajelor le rezolvă singur |

Escaladarea la om se face **în chat** (`AskUserQuestion`), **grupat** — nu picurat câte o
întrebare. Doar design și scop ajung la el; „ce pattern folosește codebase-ul", „de ce pică
testul", „cum deblochez mediul" sunt treaba orchestratorului.

### Reguli dure (nenegociabile în sesiune)

- **Porțile umane sunt ale omului și sunt blocate în DB.** `tt_ui_surfaces.manual_verdict`
  / `verdict_fingerprint` / `spec_approved_at` / `shipped_at` și
  `tt_delivery_profiles.launch_stage` se scriu doar din UI-ul Team Tracker, de către om —
  triggerul verifică rolul real al sesiunii SQL, iar `app.gate_override` nu mai există
  (migrarea `harden_human_gates`, 2026-08-25). Nu încerca să le scrii, nu căuta ocolișuri
  (`SET ROLE`, claims falsificate). Un refuz al DB-ului aici nu e un bug de rezolvat, e
  poarta funcționând: cere-i omului butonul.
- **Niciun DDL pe tabelele `tt_`** fără acordul explicit al omului, în cuvintele lui.
- **Disciplina git + Bugbot** din `../references/cursor-bugbot-merge-gate.md` rămâne
  valabilă pentru orice merge. Poarta de browser din prompturile Productivitate rămâne
  obligatorie și e a orchestratorului — privirea finală a omului la features UI e *peste*
  ea, nu în locul ei.

## Dispatch: cloud sau local

Regula de rutare pentru fiecare task care intră în lucru:

- **Cursor cloud agent** (protocolul complet: `../references/cursor-cloud-agents.md`) —
  task bine specificat și izolat: bug cu repro clar, secțiune cu criteriile aprobate,
  feature cu spec limpede. Config fix, decis de om: **grok-4.6, effort xhigh, fast OFF**.
- **Local, chatul însuși** — sesiuni ghidate și orice task interactiv; schemă/migrări;
  taskuri atât de mici încât dispatch-ul costă mai mult decât munca; orice atinge secrete
  locale sau mediul mașinii.
- Fără `CURSOR_API_KEY` în mediu, **verifică întâi registrul** înainte de a declara flota
  indisponibilă: `[Environment]::GetEnvironmentVariable('CURSOR_API_KEY','User')`. Pe Windows
  `setx` scrie în registru, dar procesele moștenesc mediul părintelui — dacă Claude Code a
  pornit înainte de `setx`, variabila lipsește din mediu deși cheia există. Dacă registrul o
  are, folosește-o și spune o dată că o repornire ar curăța situația. Doar dacă lipsește și
  de acolo → totul local, anunțat **o singură dată** pe sesiune.

## Restul skill-urilor

După `/proiect`, celelalte skill-uri (`/plan-deadlines`, `/amana`, `/pontaj`,
`/resolving-tt-bugs`, `/writing-*-test-plans`…) rulează în contextul proiectului deja
rezolvat — nu re-întreba proiectul și nu re-face înrădăcinarea. La închiderea naturală a
sesiunii de lucru, propune pontajul (`/pontaj`) dacă omul nu l-a cerut deja.
