# Pontaj automat după task

Opt-in pe persoană și calculator, comun clienților care folosesc pluginul instalat.
Nu este un monitor al tuturor aplicațiilor. Taskurile executate fără acest contract
și activitatea umană externă rămân de reconciliat separat. Automatizările nesupravegheate
și subagenții nu pontează timp pe numele omului.

## Activare și început

- La cererea „pontaj automat după fiecare task”, rulează `node <skill_dir>/scripts/task-clock.mjs enable`.
  `status` verifică opțiunea; `disable` o dezactivează. Nu e nevoie de o nouă aprobare per task.
- La începutul fiecărui task de lucru, înainte de implementare/testare, citește `status`.
  Dacă e activ, rezolvă membrul și proiectul live conform SKILL.md. Nu ghici identitatea.
- Folosește ID-ul exact al conversației și un task key stabil, de exemplu `bug:640`.
  Pentru un task fără item TT folosește cheia turnului cererii. Un nou ciclu de lucru pe
  același item după înregistrare primește un sufix cu ID-ul noii cereri; reluarea aceleiași
  execuții păstrează cheia. Orchestratorul deține un singur ceas, fără orele subagenților.
- Scrie un JSON temporar și rulează `node <skill_dir>/scripts/task-clock.mjs start <input.json>`:

```json
{"session":"exact-client-session-id","task":"bug:640","member":"<membru verificat>","project_id":1,"source":{"type":"bug","id":640,"estimated_hours":2}}
```

`source` este opțional. Verifică ID-ul, tipul și proiectul în DB. Estimarea vine din
itemul planului curent, doar dacă există; altfel omite `estimated_hours`. Pentru
secțiuni schema curentă acceptă `ui_surface`; verifică suportul în DB înainte de scriere.
Un worktree se rezolvă la proiectul repo-ului de origine, nu după numele folderului nou.

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
- `prepare` salvează întâi rezultatul într-un registru local durabil la
  `~/.claude/team-tracker-task-clock/`. La retry returnează aceeași durată și același SQL.
  Execută SQL-ul returnat prin Supabase MCP, în baza TT. Inserarea folosește un ID negativ
  determinist, sigur pentru numerele JavaScript, din domeniul existent BIGSERIAL; secvența
  pozitivă rămâne intactă. PK previne duplicatele, iar un conflict cu date diferite oprește
  tranzacția. Logul și legătura se salvează atomic. Nu necesită DDL.
- Verifică rândurile returnate (membru, proiect, zi, ore, link), apoi `ack` cu
  `verified_ids`. Un timeout nu înseamnă eșec sigur: repetă SQL-ul pregătit, nu genera alt ID.
  Nu șterge registrul și nu modifica manual payloadul pregătit ca să „repari” un conflict.
  O corecție făcută de om în Pontaj prevalează; raportează conflictul.
- Eroarea de Pontaj nu anulează livrarea taskului. Spune „Pontaj în așteptare” și păstrează
  checkpointul pentru retry. Nu declara ore salvate înainte de confirmarea DB. Închiderea
  ceasului nu marchează automat taskul Gata și nu înlocuiește merge/deploy/verdictul omului.
  După `ack`, un nou `prepare` returnează numai `recorded` și ID-urile confirmate, fără SQL:
  nu recrea o înregistrare pe care omul a șters-o după încheierea taskului.

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
