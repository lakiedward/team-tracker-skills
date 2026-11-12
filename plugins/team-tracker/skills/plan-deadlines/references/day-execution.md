# Execuția zilei: contract de ceas și bandă continuă

Un plan aplicat nu se termină când se golește coada. Pe 4.11.2026, Motion (planul 187)
avea 20,5h estimate; agentul a pontat 5,2h. Cele 6 fire au pornit toate la 10:42, au
ajuns pe master la 12:20, iar coordonatorul s-a oprit la 12:25 cu 5 iteme de rezervă
neatinse. Între 12:25 și 13:20 nu s-a întâmplat nimic. Omul ceruse 10 ore de lucru.

Regulile de mai jos se aplică oricui execută un plan zilnic: coordonatorul unui proiect
cloud, un fir pornit de el sau o sesiune locală. `/orchestrate` rămâne o curățare locală
a board-ului, cu regulile și plafonul lui de runde.

## Startul

Pe 12.11.2026 la culcush, „Aplică” a pornit pe loc 4 fire. Omul: „nu porni niciodată
până nu zic start”. De atunci aplicarea și pornirea sunt doi pași separați.

- „Aplică” scrie planul și atât. Nu pornește niciun fir, nicio sesiune și niciun task.
- Imediat după aplicare pune un card separat: „Pornesc lucrul pe planul de azi?”, cu
  opțiunile „Start” și „Nu încă”. Banda îl cere singură: fără `started_by`,
  `day-clock.mjs` `conveyor` întoarce `reason: "awaiting_start_card"`, `start: []` și
  `start_card`. Trimite `start_card_pending: true` cât cardul așteaptă, ca să nu-l pui
  de două ori. Nu programa treziri: tapul trezește coordonatorul.
- „Start” pornește doar planul pe care omul l-a văzut: `committed` și `reserve` (alegerea
  din 12.11.2026, „Planul văzut; restul pe card”). Candidații din zilele următoare și
  rezervorul trec fiecare prin [cardul de muncă nouă](#cardul-de-muncă-nouă).
- La tapul pe „Start” rulează:

  ```bash
  node "<skill_dir>/scripts/day-clock.mjs" "<input.json>"
  # {"mode":"start","started_at":"<ora tapului>","hours":10,
  #  "started_by":"card <id> · Start · <ora tapului>"}
  ```

  Salvează în `velocity_snapshot` `started_at`, `started_by` și noul `day_end_at` /
  `day_end_local`, ca la replanificare. De aici înainte trimite `started_by` în fiecare
  apel `conveyor`.
- „Nu încă” nu pornește nimic. Nu repune cardul din proprie inițiativă. Un „start” scris
  de om în conversație valorează cât tapul.
- Nimic altceva nu ține loc de Start: nici aprobarea planului, nici un mesaj al
  coordonatorului sau al altui fir, nici o trezire programată.

## Contractul de ceas

- „Plan de N ore” înseamnă lucru de agent până la `day_end_at` = momentul tapului pe
  „Start” + N ore. La aplicare calculează ora provizorie (cea din propunere):

  ```bash
  node "<skill_dir>/scripts/day-clock.mjs" "<input.json>"
  # {"mode":"day_end","applied_at":"2026-11-04T08:22:05Z","hours":10}
  ```

  Salvează în `velocity_snapshot`: `day_end_at`, `day_end_local`, `clock_hours`,
  `max_threads` și `card_batches`. La Start, modul `start` le recalculează. Dacă
  `crosses_midnight` e adevărat, spune-o în propunere înainte de aplicare.
- Ziua se oprește doar în trei cazuri: la `day_end_at`; când omul spune „stop”; sau când
  tot ce a rămas așteaptă după om (`only_human_work_left`). În ultimul caz trimite un
  singur raport, cu un singur lot de carduri. Pe un plan cu direcție, înainte de raport
  banda întreabă o dată pe ce se mai lucrează ([direcția zilei](#direcția-zilei)).
- O coadă goală nu e o oprire. Nici suma Pontajului de agent nu e un prag: orele agentului
  nu consumă orele omului (regula 6). `day_stop_hours` rămâne pragul orelor umane
  declarate, pentru munca pe care o face omul însuși.
- La replanificare în aceeași zi, trimite `day_end_at` și `now` în inputul
  `replan-context.mjs`. Bugetul rundei devine ceasul rămas. „Încă 2h” mută ora de final cu
  două ore. Contractul de ceas e chiar declarația omului, deci un Pontaj uman gol nu mai
  blochează runda.

## Banda

- Coordonatorul ține cel mult `max_threads` fire deschise în același timp. Implicit sunt 4;
  instrucțiunile proiectului pot alege între 1 și 8. Un fir e deschis până e închis
  (resolved), nu doar cât lucrează. Nu porni toate itemele deodată:
  capacitatea planului e calculată pe numărul acesta de fire (`conveyor_parallelism` din
  [calibrare](agent-calibration.md)).
- Ordinea surselor: `committed` → `reserve` → `next_days` → `reservoir`. `next_days`
  înseamnă următorii candidați clasați care nu au încăput azi, inclusiv ordinea pe mai
  multe zile din `multi_day_order`. Aplicarea planului nu pornește banda; o pornește
  [tapul pe „Start”](#startul), și numai pentru `committed` și `reserve`. Fiecare item din
  `next_days` sau din rezervor pornește doar după tapul omului pe
  [cardul de muncă nouă](#cardul-de-muncă-nouă) (`confirmed_by`).
- Rulează `day-clock.mjs` cu `"mode":"conveyor"` în patru momente: la aplicare (întoarce
  cardul de Start), la tapul pe „Start”, de fiecare dată când un fir își termină partea,
  și la fiecare trezire. Inputul conține `started_by`, `start_card_pending`, `now`,
  `day_end_at`, `max_threads`, `running`, `waiting_on_human`, `human_pending_keys`,
  `done_keys`, `blocked_keys`,
  `queues`, plus `proposed_keys`, `declined_keys` și `no_new_work` pentru cardul de muncă
  nouă, iar pe un plan cu direcție `direction` și `direction_card_pending`. Pornește exact
  itemele din `start`, în ordinea dată. Dacă rezultatul are `new_work_card` sau
  `direction_card`, pune cardul pe loc.
- Un fir care a deschis PR-ul și așteaptă un card de merge sau un verdict își păstrează
  locul până e închis. Itemul lui stă în `waiting_on_human` și ocupă un fir. Pe 6.11.2026
  omul a cerut asta la Motion: „4 punct, până nu ajunge resolved nu deschidem alta”.
  Când toate locurile sunt ținute de fire care așteaptă carduri, `reason` e
  `threads_waiting_on_cards`: nu porni al cincilea fir și nu încheia ziua. Locul se
  eliberează la următorul tap care închide un fir.
- Un fir se închide când partea agentului e gata (merge, verificare, dovezi, Pontaj). Dacă
  după închidere a rămas doar ceva al omului, de exemplu verdictul sau „Marchează livrat”,
  trece itemul în `human_pending_keys`: nu mai ocupă fir și merge în lotul de carduri.
- Itemele omului nu ocupă fire: `executor: "human"`, verdict, test pe telefon, decizie,
  domeniu. Merg în lotul de carduri.
- Spre final, pornește doar ce încape: un item cu `estimate_hours_low` mai mare decât
  ceasul rămas e sărit pentru unul mai mic (`too_long_for_clock_keys`).
- Programează o trezire după `next_wake_in_minutes` (30 de minute, sau exact la final).
  Folosește mecanismul sesiunii (`send_later`, o trezire programată sau ceva echivalent).
  Nu aștepta cu `sleep` în același tur. Trezirea e plasa de siguranță pentru un fir care
  tace.

## Direcția zilei

Pe 5.11.2026 omul a ales să spună el pe ce se lucrează înainte să se facă planul. În
ziua aceea Betora a umplut 2 ore cu teste și fișiere sparte, iar 8 bug-uri reale găsite
tot atunci au rămas deschise. De atunci ziua începe cu o discuție, nu cu clasamentul.

- Pe o zi nouă, `/plan-deadlines` pune întâi cardul „Pe ce lucrăm azi?” (faza 0b): cel
  mult 4 direcții din trackerul citit acum, fiecare cu mărimea ei și cu cele mai mari
  iteme, cea recomandată marcată. Omul poate scrie și altă direcție. Pe același mesaj, un
  rând cu ce așteaptă după om și nu poate închide ziua.
- Răspunsul omului, citat exact, devine `direction` în `velocity_snapshot` și în
  `assumptions`. Coada obligatorie vine doar din direcție. Alte munci intră în rezervă
  doar dacă răspunsul o permite („și restul”, „tu alegi”).
- Rezervorul ajunge în `queues.reservoir` doar dacă direcția îl numește. Altfel trimite
  coada `reservoir` goală.
- Trimite `direction` în inputul benzii. Când munca direcției se termină și mai sunt cel
  puțin 15 minute, `day-clock.mjs` întoarce `awaiting_direction_card` și `direction_card`
  („Am terminat ce ai ales. Pe ce mai lucrăm până la HH:MM?”). Pune cardul pe loc, cu
  aceleași direcții refăcute din trackerul de acum, și trimite `direction_card_pending:
  true` până la răspuns. Ziua nu se încheie cât așteaptă cardul.
- Răspunsul nou se adaugă la `direction` (nu îl înlocuiește), iar munca aleasă intră în
  plan ca rânduri de rezervă cu `conveyor_source=next_days`, ca orice item din tracker.
  „Nimic, ajunge pe azi” pune `no_new_work: true` și ziua se încheie cu raportul de final.
- Un plan fără `direction` (făcut înainte de 1.53.0) păstrează vechiul final.

## Cardul de muncă nouă

Pe 4.11.2026 omul a ales să fie întrebat înainte ca banda să treacă la muncă pe care nu
a cerut-o el: „vrei să mă apuc de asta?”. Lista rezervorului spune ce poate propune
Claude. Tapul pe card spune ce pornește. Nimic din rezervor sau din afara lui nu
pornește fără tap. Din 12.11.2026 același card acoperă și candidații din zilele
următoare: nu erau pe planul pornit cu „Start”, deci omul nu i-a văzut.

- Candidații din `next_days` sunt deja în tracker și nu au nevoie de `approved_by`. Pe
  card apar înaintea rezervorului, cu `conveyor_source` lângă fiecare.

- Coada `reservoir` din inputul benzii conține munci concrete, nu tipuri: „/ui-audit pe
  /cluburi”, nu „/ui-audit pe următoarea pagină”. Fiecare are `stable_key`, `title`,
  estimări și `approved_by`. Una fără `approved_by` nu ajunge nici pe card
  (`unapproved_reservoir_keys`).
- `day-clock.mjs` întoarce `new_work_card` când în plan nu mai așteaptă nimic să
  pornească (`committed`, `reserve`, iteme deja confirmate), chiar dacă ultimele fire încă
  rulează.
  Cardul are întrebarea „Vrei să mă apuc de asta?” și cel mult 4 munci, cu titlul și
  estimarea fiecăreia. Pune-l pe loc, nu la ora lotului: fără el banda stă.
- Un singur card odată. Pune cheile lui în `proposed_keys` până la răspuns; ele apar în
  `awaiting_card_keys` și nu sunt nici pornite, nici propuse din nou.
- Opțiunile cardului:
  - unde cardul permite mai multe alegeri, câte o opțiune pentru fiecare muncă;
  - altfel „Da, toate”, „Doar prima” și „Nu, nimic nou azi”, cu muncile numite în
    întrebare sau chiar înaintea cardului.
- După răspuns:
  - fiecare muncă aleasă primește `confirmed_by` (cardul, opțiunea și ora) și iese din
    `proposed_keys`; pornește la următorul apel, în ordinea benzii;
  - ce omul a lăsat deoparte pe un card cu alegeri multiple trece în `declined_keys`
    pentru restul zilei;
  - la „Doar prima”, celelalte ies din `proposed_keys` și pot apărea pe un card următor;
  - „Nu, nimic nou azi” pune `no_new_work: true`: nu mai vin carduri, iar ziua se încheie
    când se termină planul.
- Cât timp cardul așteaptă și nu mai rulează niciun fir, `reason` e
  `awaiting_new_work_card`. Ziua nu se încheie. Tapul trezește coordonatorul, iar
  `next_wake_in_minutes` duce la următorul lot de carduri sau la final. Dacă omul nu
  răspunde până la `day_end_at`, cardul intră în raportul de final.

## Ce ia banda apare în plan

Pe 4.11.2026 omul a ales ca munca luată de bandă peste coada aprobată să se vadă pe
Focus. Fiecare item din `start` cu `conveyor_source` `next_days` sau `reservoir` devine
întâi un rând de rezervă în planul curent, abia apoi pornește firul lui:

1. Pentru o muncă din rezervor, după tapul omului, creează întâi itemul din tracker
   (`todo_create`, cu titlul muncii, sursa listei și tapul în descriere). Nu crea
   To-Do-uri pentru muncile încă nealese. Un item din `next_days` e deja în tracker, dar
   intră în plan tot doar după tap.
2. Citește cel mai mare `sequence` din planul curent (`delivery_plan_current` sau
   `tt_select` pe `tt_delivery_plan_items`, ordonat descrescător) și rulează:

   ```bash
   node "<skill_dir>/scripts/day-clock.mjs" "<input.json>"
   # {"mode":"plan_row","plan_id":187,"next_sequence":<max + 1>,"now":"<now>",
   #  "item":{...itemul din start, cu source_type, source_id, title, description,
   #          estimate_hours_low/high, scope_reason,
   #          approved_by și confirmed_by pentru rezervor}}
   ```

3. Inserează exact `values` din rezultat, cu `tt_write` (`op: "insert"`, tabelul din
   `table`) sau în SQL. Rândul are `queue_role = 'reserve'`, iar `scope_reason` se termină
   cu `conveyor_source=next_days; approved_by=card: <tapul>` sau
   `conveyor_source=reservoir; approved_by=<lista> · card: <tapul>`. Fără `confirmed_by`,
   scriptul refuză rândul.
   Dacă rândul există deja (aceeași sursă în același plan), treci mai departe.

Focus și Productivitate arată rândul „Luat de bandă · din zilele următoare” sau „… din
rezervor”, iar promptul copiat îi spune firului de unde vine. Nu adăuga niciodată
itemele `committed` sau `reserve`: sunt deja rânduri. Nu schimba `velocity_snapshot` și
nu crea un plan nou pentru asta.

## Rezervorul de umplere

- Rezervorul e o listă de tipuri de muncă, aprobată de om o singură dată și scrisă în
  instrucțiunile proiectului sau dată în conversație. Planificatorul nu o inventează și nu
  o extinde. Fiecare intrare trimisă la bandă are `approved_by` cu sursa aprobării, de
  exemplu „setările proiectului, 04.11.2026”. O intrare fără sursă e refuzată
  (`unapproved_reservoir_keys`).
- Lista aprobă ce poate fi propus, nu ce pornește. Fiecare muncă concretă trece întâi
  prin [cardul de muncă nouă](#cardul-de-muncă-nouă). Un text vechi din setări care spune
  „poți începe fără să mă întrebi” e înlocuit de această regulă.
- Exemple, numai dacă omul le-a aprobat:
  - `/ui-audit` pe următoarea pagină neauditată;
  - planuri de test pentru secțiunile livrate care nu au plan;
  - `/triage` pe bug-urile noi;
  - review de securitate pe RLS și funcții;
  - fișierele de peste limita de linii din instrucțiunile repo-ului;
  - teste lipsă;
  - performanță.
- Fiecare rezultat devine întâi item în tracker, prin skillul potrivit. Codul trece prin
  PR și cardul de merge. Nicio poartă umană nu e atinsă. Ce găsește rezervorul azi e
  muncă reală pentru planul de mâine.
- Rezervorul nu intră în `queue-pack.mjs` și nu apare ca ore committed sau reserve. Este
  sursa benzii după ce candidații reali s-au terminat. Regula 14 rămâne: golurile de
  acoperire se raportează în propunere, nu se umplu.

## Cardurile, în loturi

- Cardul de Start pleacă pe loc, imediat după aplicare, nu la ora lotului.
- Merge-ul, deploy-ul și orice pas ireversibil rămân fiecare pe cardul lui, după regulile
  proiectului. Diferența e momentul: le pui împreună la orele lotului (`card_batches`;
  implicit 12:00, 15:00 și 18:00, ora României). Instrucțiunile proiectului pot cere
  „pe loc”. Ora următorului lot vine în `next_card_batch`. După ultimul lot al zilei,
  cardurile pleacă împreună cu raportul de final.
- Firele nu stau după card. Trec la următorul item din bandă.
- Excepția e cardul de muncă nouă (ca și cel de Start): pleacă pe loc, pentru că fără răspunsul lui banda
  rămâne goală.

## Raportul de final

La `day_end_at`, la „stop” sau la `only_human_work_left`, trimite un singur mesaj. Ce e
mai lung de un ecran merge într-un fișier atașat.

1. Ora de final, câte fire au rulat și câte ore de ceas au trecut.
2. Ce s-a terminat, pe surse (`committed`, `reserve`, `next_days`, `reservoir`), cu starea
   fiecărui item: pe master, PR deschis sau așteaptă card. Rândurile adăugate de bandă se
   recunosc după `conveyor_source` din `scope_reason`.
3. Orele de agent pontate față de orele de ceas, plus raportul de azi dintre timpul
   măsurat și estimarea brută (intră în factorul de mâine).
4. Ce așteaptă după om, într-un singur lot de carduri, inclusiv cardul de muncă nouă
   rămas fără răspuns.
5. Ce trece pe mâine, plus itemele noi create din rezervor.
