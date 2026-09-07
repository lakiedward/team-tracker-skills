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
exact două butoane.

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
rezolvat — nu re-întreba proiectul și nu re-face înrădăcinarea. La închiderea naturală a
sesiunii de lucru, propune pontajul (`/pontaj`) dacă omul nu l-a cerut deja.
