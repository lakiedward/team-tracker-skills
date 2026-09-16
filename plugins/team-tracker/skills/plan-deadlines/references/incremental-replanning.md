# Replanificare în aceeași zi

Se aplică înainte de fazele 1–6. Planificarea rămâne o propunere read-only până la
aprobarea utilizatorului; acest mod nu schimbă bornele, capacitatea viitoare sau porțile umane.

1. Stabilește data în Europe/Bucharest și citește cel mai nou plan aplicat pentru acea zi,
   profilul, toate sursele live, bornele, dependențele externe și Pontajul. Include munca
   făcută de oameni sau în alte instrumente, dacă există dovezi; lipsa logului nu înseamnă
   zero ore. Reconcilierea timpului lipsă este necesară înainte să promiți capacitate.
2. Alege modul din cerere:
   - `new_day`: prima planificare a zilei, cu inventar complet și bugetul profilului;
   - `continue_day`: „am terminat, mai fă plan”, „continuă azi” — numai orele rămase;
   - `extra_budget`: doar când omul cere explicit ore suplimentare, de exemplu „încă 2h”;
   - `close_day`: „închidem ziua” — rezumat și blocaje, zero taskuri noi și zero rescanări.
   O cerere ambiguă de replanificare în aceeași zi înseamnă `continue_day`.
3. Calculează cu `scripts/replan-context.mjs <input.json>`; exemplu:

```json
{"mode":"continue_day","planning_date":"2026-09-16","previous_date":"2026-09-16","day_limit_hours":5,"spent_hours":3,"extra_hours":0,"extra_authorized":false,"repositories":[]}
```

`day_limit_hours` este limita cumulată a zilei din ultimul plan aplicat (`day_stop_hours`,
fallback la `gross_daily_hours` pentru planurile vechi). `spent_hours` este timpul consumat
verificat, fără dublarea înregistrărilor. Pentru prima planificare folosește capacitatea
profilului și scade și munca deja făcută azi. O autorizare de ore suplimentare se adaugă
**o singură dată**: păstrează ID-ul cererii în propunere și verifică dacă planul aplicat o
conține deja; la retry sau după aplicare, folosește limita actualizată și `continue_day`.
Nu însuma bugetele planurilor succesive. Proiectele care împart o persoană trebuie să
respecte și timpul ei disponibil declarat; nu presupune că poate lucra simultan.

În planurile noi `gross_daily_hours` este bugetul **acestei runde**, iar `day_stop_hours`
este pragul Pontajului cumulat de azi. Orele suplimentare se adaugă peste maximul dintre
limita precedentă și orele deja consumate, astfel încât „încă 2h” să ofere 2h și după
o depășire a bugetului inițial. Folosește bugetul rundei la packing și pragul
cumulat la oprirea execuției. `committed_target_hours` păstrează bufferul de 1h când
rămâne mai mult de o oră; până la o oră, tot bugetul este committed;
urgența poate folosi bufferul conform regulilor existente, fără să depășească bugetul rundei.
La zero ore rămase, nu inventa taskuri pentru a umple coada.

## Refolosirea inventarului

Pentru fiecare codebase înregistrat, verifică rapid `git status` și HEAD. Nu rula mai întâi
întregul `repo-inventory.mjs` doar ca să afli că nu s-a schimbat nimic. Păstrează local
inventarul și metadatele lui: repo_path absolut canonic, planning_date, head_sha, dirty,
complete, SHA256 al registrului codebase-urilor și SHA256 al instrucțiunilor aplicabile
(AGENTS.md/CLAUDE.md, skillurile folosite și referințele lor). Nu salva secrete.

`inventoryDecision(previous,current,date)` din script aprobă `reuse` numai pentru același
repo curat, același HEAD, aceeași zi și aceleași instrucțiuni/registru, cu inventar anterior
complet. `current.status_verified=true` se setează numai după un status reușit, incluzând
fișierele untracked. Worktree dirty, HEAD schimbat, repo nou/lipsă, inventar trunchiat,
modificări de reguli sau dovezi insuficiente => scanare completă a repo-ului respectiv.
Cache-ul nu se folosește ca dovadă pentru browser, CI, deploy sau starea serviciilor externe.

Trackerul, milestone-urile, gates, override-urile și activitatea externă se recitesc de
fiecare dată. Elimină munca devenită gata și reevaluează blocajele/dependențele; nu muta
automat verificările omului în coada AI. Un raport vechi sau un cache absent nu blochează:
revino la scanarea completă. `close_day` doar raportează starea live.

## Propunere și aplicare

Arată modul, orele consumate, bugetul rămas, pragul zilei, repo-urile refolosite/rescanate
și diferența față de planul anterior. Păstrează bornele și toate obligațiile externe în
evaluare. În `velocity_snapshot` salvează rezultatul helperului, `extra_budget_request_id`
dacă există și `previous_plan_id`; contractul 2 și celelalte câmpuri rămân compatibile.
La `close_day` nu crea o nouă coadă și nu schimba automat statusul planului existent.
Înainte de aplicare recitește planul activ, orele, profilul și starea repo-urilor;
dacă baza s-a schimbat, regenerează propunerea și cere aprobarea rezultatului actualizat.
Păstrează protocolul existent de proposal_hash, idempotence și tranzacție atomică.
