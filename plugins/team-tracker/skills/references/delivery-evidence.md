# Dovada publicării și cererea principală

Se aplică livrării secțiunilor UI. Păstrează porțile umane și restricțiile proiectului
pentru primul launch. Un PR merged, un build sau o captură locală nu dovedesc publicarea.

1. Citește secțiunea, proiectul, amprenta curentă și `tt_ui_delivery_status`.
   Identifică cererea originală din conversație/PR/tracker; nu ghici legătura după titlu.
   Verifică în `tt_bugs`, `tt_features` sau `tt_todos` că sursa aparține aceluiași proiect.
2. Verifică PR-ul merged și SHA-ul complet. Verifică deploy-ul **publicat**, ready,
   și SHA-ul acestuia. Dacă este ulterior PR-ului, dovedește că include commitul prin
   istoricul Git. Un titlu de deploy nu este singur dovadă: dacă providerul nu expune SHA,
   compară hashurile artefactelor live cu build-ul verificat al commitului.
3. Verifică fluxul pe URL-ul public și viewportunile/dispozitivele relevante. Păstrează
   URL, pași, rezultat, consolă și capturi. Dovezile Android nu acoperă iOS; un demo static
   nu dovedește formularul/plata. Nu publica dacă autorizarea/gate-ul proiectului lipsesc.
4. Numai după verificare, inserează în `tt_ui_delivery_evidence`: `surface_id`,
   `project_id`, `inventory_fingerprint`, `commit_sha` (SHA-ul publicat, 40 caractere),
   `pr_url`, `deployment_url` (permalink al deploy-ului), `production_url`,
   `verification_note` (inclusiv relația SHA PR → publicat și rezultatele live),
   `verified_at` (ora reală, cu fus). Folosește valori parametrizate/SQL escaping corect.
   Păstrează același payload și timestamp la retry, cu `ON CONFLICT DO NOTHING`; citește
   apoi rândul și verifică toate valorile. O reverificare reală ulterioară adaugă un nou
   eveniment, nu rescrie dovada veche. Nu fabrica dovezi pentru înregistrările istorice.
5. Leagă fiecare sursă confirmată prin `tt_ui_delivery_sources(surface_id, project_id,
   source_type, source_id)` cu `ON CONFLICT DO NOTHING`, apoi verifică legătura.
   Tipuri acceptate: `bug`, `feature`, `todo`. Lipsa unei surse nu împiedică dovada
   publicării unei secțiuni create direct în site map; rămâne explicită.
6. Citește din nou `tt_ui_delivery_status`. Dovada trebuie să aibă amprenta curentă;
   pentru o nouă confirmare umană de livrare verificarea trebuie să aibă cel mult 7 zile.
   Dacă lipsește, raportează „publicare de confirmat”, nu „în producție”.
7. Reconciliază sursa principală numai după citirea întregului scop și verificarea
   criteriilor, testelor, platformelor, aprobărilor și publicării. Toate secțiunile legate
   publicate sunt un semnal de verificare, nu autorizare automată pentru `Gata`/`Fixed`.
   Explică ce mai lipsește sau actualizează statusul permis de skillul sursei, cu dovada.

`shipped_at`, `manual_verdict`, `spec_approved_at`, `launch_stage` rămân exclusiv ale
omului. Inserarea dovezii nu le modifică. Nu imita sesiunea umană și nu dezactiva trigger-ele.
Planificarea citește aceste dovezi read-only; nu migrează și nu repară date ca efect secundar.
