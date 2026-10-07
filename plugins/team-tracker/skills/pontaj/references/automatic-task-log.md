# Pontaj automat după task

Opt-in pe persoană și calculator, comun clienților care folosesc pluginul instalat.
Nu este un monitor al tuturor aplicațiilor. Taskurile executate fără acest contract
și activitatea umană externă rămân de reconciliat separat. Automatizările nesupravegheate
și subagenții nu pontează timp pe numele omului.

Aplică [proveniența orelor](time-basis.md): fiecare înregistrare automată nouă este
`conversation_estimate`, separat de orele declarate de om. Nu consumă automat
capacitatea umană și nu calibrează efortul uman al planurilor.

## Activare și început

- La cererea „pontaj automat după fiecare task”, rulează `node <skill_dir>/scripts/task-clock.mjs enable`.
  `status` verifică opțiunea; `disable` o dezactivează. Nu e nevoie de o nouă aprobare per task.
- La începutul fiecărui task de lucru, înainte de inventar, implementare sau testare, citește `status`.
  Dacă e activ, rezolvă membrul și proiectul live conform SKILL.md. Nu ghici identitatea.
- Folosește ID-ul exact al conversației și un task key stabil, de exemplu `bug:640`;
  cheia `<tip>:<id>` leagă singură checkpointul de item (vezi mai jos).
  Pentru un task fără item TT folosește cheia turnului cererii. Un nou ciclu de lucru pe
  același item după înregistrare primește un sufix cu ID-ul noii cereri; reluarea aceleiași
  execuții păstrează cheia. Orchestratorul deține un singur ceas, fără orele subagenților.
- Scrie un JSON temporar și rulează `node <skill_dir>/scripts/task-clock.mjs enter <input.json>`:

```json
{"session":"exact-client-session-id","task":"bug:640","member":"<membru verificat>","project_id":1,"source":{"type":"bug","id":640,"estimated_hours":2}}
```

`source` este opțional; `sources: [...]` acceptă mai multe iteme deodată (deduplicate
după tip:id, cel mult 25). Fără sursă explicită, o cheie care începe cu
`<bug|feature|test_plan|todo|ui_surface>:<id>` devine sursa checkpointului, și cu sufix
(`ui_surface:874:approve-spec` → secțiunea #874); o sursă explicită are prioritate.
Receipt-ul întoarce `sources`: verifică fiecare item în DB — tip, ID, același proiect —
înainte de lucru. O sursă care nu există sau e din alt proiect înseamnă cheie greșită:
nu lucra pe ea, raportează Pontaj în așteptare și nu rescrie registrul. Estimarea vine din
itemul planului curent, doar dacă există; altfel omite `estimated_hours`. Schema acceptă
`ui_surface` pentru secțiuni. Un worktree se rezolvă la proiectul repo-ului de origine,
nu după numele folderului nou.

Verifică receipt-ul înainte de lucru: `started` confirmă checkpointul nou, `active`
reluarea aceluiași checkpoint, `paused` cere `resume` la reluarea efectivă, `pending`
înseamnă SQL pregătit de reconciliat, `recorded` înseamnă task deja închis. Nu reporni
același task și nu schimba cheia ca să ocolești un conflict. `enabled:false` respectă
opțiunea dezactivată. `start` rămâne compatibil, dar verifică și el identitatea la retry.
Schimbarea membrului sau proiectului unui checkpoint este respinsă; un retry poate numi
o sursă pe care checkpointul o are deja, iar o sursă nouă se adaugă numai prin `link`.
Corectează identitatea din context, fără să rescrii registrul. Dacă nu se poate crea
checkpointul, continuă munca autorizată, raportând Pontaj în așteptare; nu recupera
retrospectiv ore ghicite.

## Legarea itemelor de tracker

Team Tracker arată „pontat ~X” pe taskurile terminate din suma `tt_work_log_items` a
fiecărui item. Un checkpoint fără legătură nu apare la niciun task.

**Iteme pe rând:** un checkpoint per item — `enter` cu cheia `<tip>:<id>` → lucru →
`prepare` / SQL / `ack` → itemul următor. Ceasul ține un singur checkpoint deschis per
conversație, deci îl închizi pe cel curent înainte să-l pornești pe următorul.

**Iteme întrețesute sub un singur ceas** — un thread `/proiect` de tipul „terminăm planul
de azi”, un sweep `resolving-*` rulat de un singur agent, orchestratorul: rulează `link`
pentru fiecare item imediat ce lucrezi efectiv pe el (investigat, implementat, verificat,
specificat), nu doar citit sau raportat. `link` primește același JSON ca `enter`, cu
`source` sau `sources`, pe un checkpoint `active` sau `paused`; dublurile după tip:id se
ignoră, iar limita e de 25 de iteme. Verifică fiecare item în DB înainte, ca la `enter`:

```json
{"session":"exact-client-session-id","task":"proiect:betora:2026-10-07","member":"<membru verificat>","project_id":1,"sources":[{"type":"bug","id":1006,"estimated_hours":1.5},{"type":"ui_surface","id":874}]}
```

Înainte de `prepare`, compară itemele terminate sau avansate în task cu `sources` și
leagă-le pe cele lipsă. Un ceas fără nicio legătură e acceptabil numai pentru muncă fără
item în tracker. `prepare` scrie o legătură per item pentru fiecare zi, iar triggerele DB
reîmpart orele logului: după estimarea planului când toate legăturile o au, egal altfel.
După `prepare` receipt-ul e imuabil și `link` e respins. Nu edita manual SQL-ul pregătit
și nu adăuga legături la loguri deja înregistrate fără confirmarea explicită a omului.

## Pauze și închidere

- Înainte să aștepți un răspuns/verdict al omului sau să lași taskul blocat, rulează
  `pause` cu același session/task; la reluare `resume`. Nu include orele de așteptare.
- După lucru și verificări, inclusiv când predai un rezultat parțial, rulează `prepare`
  cu session/task, `category`, o `description` în română despre rezultatul real și
  `transcripts`, lista fișierelor JSONL ale conversației exacte. Codex poate împărți
  același session ID în mai multe rollouts: include toate segmentele relevante. Scriptul
  validează identitatea, deduplică timestampurile și respinge transcripturile altui chat.
  Nu selecta automat cel mai recent fișier din folder. Clienții fără ID și timestampuri
  verificabile rămân cu Pontaj în așteptare, fără estimări din mtime sau număr de mesaje.
- Scriptul exclude gapurile peste 15 minute și pauzele explicite, separă zilele în
  Europe/Bucharest și păstrează fracțiile de oră fără minimum 0.5h. Este o **estimare a
  activității conversației**, nu măsurarea exactă a efortului uman. Precizează asta în log.
  Scriptul adaugă markerul `[pontaj:basis=conversation_estimate]` și eticheta lizibilă.
- `prepare` salvează întâi rezultatul într-un registru local durabil la
  `~/.claude/team-tracker-task-clock/`. La retry returnează aceeași durată și același SQL.
  Un receipt pregătit înainte de upgrade nu se rescrie pentru a adăuga markerul;
  eticheta istorică rămâne recunoscută drept estimare a conversației.
  Execută SQL-ul returnat prin Supabase MCP, în baza TT. Inserarea folosește un ID negativ
  determinist, sigur pentru numerele JavaScript, din domeniul existent BIGSERIAL; secvența
  pozitivă rămâne intactă. PK previne duplicatele, iar un conflict cu date diferite oprește
  tranzacția. Logul și legăturile se salvează atomic. Nu necesită DDL.
  O legătură către un item care nu mai există sau e din alt proiect se sare, nu oprește
  logul; la fel o zi atât de scurtă încât cota ar ieși 0. Orele rămân salvate.
- Verifică rândurile returnate (membru, proiect, zi, ore și coloana `links`), apoi `ack` cu
  `verified_ids`. Raportează fiecare item legat care lipsește din `links`; nu-l adăuga după
  `ack` fără confirmarea omului. Un timeout nu înseamnă eșec sigur: repetă SQL-ul pregătit,
  nu genera alt ID. Nu șterge registrul și nu modifica manual payloadul pregătit ca să „repari” un conflict.
  O corecție făcută de om în Pontaj prevalează; raportează conflictul.
- Eroarea de Pontaj nu anulează livrarea taskului. Spune „Pontaj în așteptare” și păstrează
  checkpointul pentru retry. Nu declara ore salvate înainte de confirmarea DB. Închiderea
  ceasului nu marchează automat taskul Gata și nu înlocuiește merge/deploy/verdictul omului.
  După `ack`, un nou `prepare` returnează numai `recorded` și ID-urile confirmate, fără SQL:
  nu recrea o înregistrare pe care omul a șters-o după încheierea taskului.
- Rulează `summary` cu session/task înainte de răspuns: `saved:true` indică un `ack`
  verificat anterior în DB și afișează ID-urile; celelalte stări sunt „Pontaj în așteptare”.
  `summary` nu scrie ore și nu pretinde că a recitit DB. La un task nou verifică salvarea
  în DB înainte de ack; nu folosi un summary istoric pentru a recrea rânduri șterse de om.

## Pontaj manual și limite de acoperire

Înainte de `/pontaj`, rulează `inspect` pentru ID-ul exact al conversației. Dacă există
checkpointuri, finalizează numai taskurile neînregistrate prin acest protocol. Nu mai
insera întregul chat cu scriptul vechi: ar dubla intervalele. Pentru muncă dinaintea
activării sau din alt client, cere intervalul/orele explicite încă nepontate dacă nu sunt
deja cunoscute. Nu deduce zero din lipsa unui checkpoint. Verifică Pontajul live înainte
de activare într-o conversație deja pontată; pornește doar de acum înainte.

Pe clienți/calculatoare diferite, conversațiile au identități diferite; verifică logurile
live înainte de transfer și nu porni ceasuri paralele pentru același efort uman. Registrul
local nu promite deduplicare a unor sesiuni distincte care descriu aceeași muncă.
Păstrează estimările lor separate; nu le prezenta suma drept ore umane și nu deduce
efortul uman din suprapunerea ori reuniunea intervalelor. Disponibilitatea actuală
deja declarată de persoană prevalează, fără o nouă confirmare per task.
