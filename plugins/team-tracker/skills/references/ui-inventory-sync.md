# Inventarul UI după fiecare task

Contract comun pentru `/proiect`, skilluri invocate direct și taskuri libere sau
copiate din Team Tracker. Când taskul autorizat schimbă interfața, sincronizarea
incrementală a UI Coverage face parte din finalizare, fără o aprobare separată
pentru evidență. Respectă scope-ul și porțile umane ale implementării. Analiza,
planificarea și verificarea fără modificări UI nu autorizează schimbări de inventar.
Comenzile explicite `/ui-audit` și `/proiect-nou` își păstrează propriul protocol
de inventariere; acest contract nu îl înlocuiește.

## Înainte de cod

Rezolvă proiectul/codebase-ul din registrul instalat și verifică schema live.
Citește harta `tt_ui_surfaces`: ID, părinte, `stable_key`, etichetă, tip, codebase,
rută, navigare, platforme, `code_refs`, amprentă, origine, stare și `updated_at`.
Include `planned`, `missing` și `archived` pentru deduplicare; paginează până termini.
La `/proiect` încarcă această hartă, nu doar totalurile pipeline-ului.

Corelează taskul cu suprafețele existente prin ID, cheie, rută și cod. Citește și
criteriile, dovezile, legăturile și câmpurile omului pentru zona afectată. Notează
delta: adăugare/modificare/mutare/retragere, identitate, părinte, fișiere și motiv.
Reutilizează secțiunea pentru schimbări de text, stil sau buton; nu crea un rând
pentru fiecare control. O pagină nouă primește secțiuni coerente. Chrome-ul comun
se inventariază o dată. Identitatea ambiguă rămâne nesincronizată, fără duplicat.

## Versiunea canonică și draftul

Inventarul canonic urmărește codul integrat în branchul de livrare verificat al
proiectului, de regulă branchul implicit; **nu dovedește publicarea**.
Cât timp schimbarea este numai într-un draft/PR/worktree, păstrează delta în
predarea taskului/PR, cu branch, SHA și ID-uri. Nu suprascrie amprenta canonică și
nu transforma `planned` în `active`. La reluare continuă aceeași delta și același draft.

După merge verifică SHA-ul integrat și recalculează delta din codul curent al
branchului de livrare, inclusiv schimbările altor PR-uri din aceeași zonă. Un branch
vechi nu poate retrage secțiuni noi. Fără Git folosește numai sursa canonică verificată;
dacă nu se poate stabili, lasă sincronizarea în așteptare. Păstrează checkout-urile străine.
Calculează amprenta din fișierele relevante cu `ui-audit/scripts/audit-contract.mjs
fingerprint --repo <repo> --files <fișiere>`, același algoritm ca auditul. Include
componentele comune afectate și recalculează paginile părinte, fără audit complet.

## Delta aplicată în schema existentă

| Schimbare confirmată în codul canonic | Scriere |
|---|---|
| Suprafață nouă implementată | Inserează pagina înaintea secțiunilor, cu cheie unică în proiect, părinte din același proiect, metadate observate, `inventory_origin='llm'`, `inventory_state='active'`. La conflict recitește; nu dubla. |
| Suprafață modificată | Actualizează numai metadatele schimbate, referințele de cod, amprenta și `last_seen_at`. Păstrează ID, cheie, origine și legături. |
| Redenumire, mutare sau schimbare de rută | Actualizează același rând, inclusiv `parent_id` când e cazul; păstrează `stable_key` chiar dacă numele vechi apare în ea. |
| Suprafață `planned` construită | Refolosește rândul și treci în `active` după integrare. Secțiunile încă neconstruite rămân `planned`. |
| Suprafață eliminată de taskul autorizat | Marchează `missing`, fără DELETE. Confirmă eliminarea și lipsa unei mutări/redenumiri. Include explicit copiii eliminați; mută întâi copiii păstrați. |
| Suprafață `missing` reapărută | Refolosește identitatea și reactivează numai pe baza codului canonic. |
| Suprafață `archived` | Păstrează arhivarea omului. Revenirea cere intenție explicită; nu reactiva automat și nu crea un duplicat. |

Absența dintr-un scan parțial, viewport, rol fără acces sau feature flag nu dovedește
eliminarea. Nu retrage nimic în afara deltei autorizate. O idee discutată la specificare
rămâne criteriu/feature conform fluxului existent; devine suprafață prin acest protocol
doar când este implementată și integrată. Nu crea audituri goale pentru upsert și nu
fabrica audit items, findings, scoruri, teste trecute sau dovezi de publicare. Nu adăuga DDL.

## Concurență și verificare

1. Recitește rândurile afectate, părinții și copiii unei pagini mutate/retrase.
   Păstrează snapshotul cu `updated_at` și lista exactă de ID-uri.
2. Aplică delta într-o tranzacție: blochează rândurile în ordine de ID și compară
   toate reviziile înainte de prima scriere. Actualizează numai ID-urile blocate,
   filtrate și după proiect. Triggerul unui copil schimbă `updated_at` al părintelui:
   nu confunda această schimbare proprie tranzacției cu un conflict extern.
   Verifică numărul de rânduri RETURNING; un conflict anulează întreaga delta.
   Recitește și reconstruiește înainte de retry.
3. Un retry care găsește aceleași valori este no-op. După timeout recitește DB înainte
   de reinserare. Unicitatea `(project_id, stable_key)` nu înlocuiește deduplicarea semantică.
4. UPDATE permite doar `parent_id`, `label`, `codebase_label`, `route_pattern`,
   `navigation_hint`, `platforms`, `code_refs`, `inventory_fingerprint`,
   `inventory_state`, `last_seen_at`. Nu rescrie `purpose` din presupuneri. Un tip
   sau o ierarhie incompatibilă se raportează, nu se repară prin recrearea istoricului.
5. Nu modifica `manual_*`, `required_for_launch`, criterii, `spec_approved_at`,
   `verdict_fingerprint`, `verified_at`, `shipped_at`, `delivery_stage` sau `launch_stage`.
   Nu șterge teste, audituri, dovezi sau legături. Amprenta schimbată poate învechi
   verdictul/dovezile; păstrează această stare reală, fără reaplicarea aprobării vechi.
6. După commit recitește delta: ID-uri, părinți, stări, amprente, lipsa duplicatelor
   și păstrarea câmpurilor omului/criteriilor/legăturilor. Înregistrează separat
   publicarea reală conform [delivery-evidence.md](delivery-evidence.md).

## Predare

Raportează compact, cu ID-uri verificabile:
`UI Coverage: 1 adăugată (#…), 2 actualizate (#…), 1 retrasă (#…); verificat în DB.`
Fără schimbări UI: `UI Coverage: fără modificări necesare.`
Draft: `UI Coverage: delta pregătită, sincronizare după merge (<branch/PR>).`
La acces lipsă, conflict sau eșec: `inventar UI nesincronizat`, cauza și delta rămasă
cu SHA/PR/ID-uri pentru reluare. Livrarea codului rămâne vizibilă separat; nu declara
sincronizarea sau taskul complet închis fără confirmarea DB.
