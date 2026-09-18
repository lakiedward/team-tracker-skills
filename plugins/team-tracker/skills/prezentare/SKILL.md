---
name: prezentare
description: "Pregătește o prezentare pentru client într-o singură rulare de aproximativ 20 de minute: progres, date și acces disponibile, scenariu, verificări esențiale și predare pentru revizuire. Folosește când utilizatorul invocă /prezentare ori cere să pregătească demonstrația unui proiect Team Tracker. Omul revizuiește singur și raportează problemele în același task. Popularea automată este disponibilă numai prin adaptorul Motion; celelalte proiecte folosesc resurse existente și limite explicite."
---

# prezentare — o singură pregătire, apoi revizuirea omului

Aplică [execuția locală](../references/local-execution.md). Folosește pluginul instalat,
registrul [proiectelor](../orchestrate/projects.json) și prezentarea salvată în Team Tracker.
Intrarea implicită este `/prezentare <proiect> prezentarea <uuid>` sau `Operație: complet`.
Execută planificarea, pregătirea și verificarea esențială în aceeași rulare, apoi predă
scenariul pentru revizuire. Nu cere omului să trimită pe rând trei prompturi.
Planificarea și verificarea resurselor existente sunt comune proiectelor. Adaptorul de
populare/resetare disponibil rămâne numai Motion; nu reintroduce adaptoare Culcush/Betora.
Pentru un proiect fără adaptor, pregătește partea utilizabilă din resursele existente și
marchează exact conturile/datele lipsă. Nu prezenta lipsa adaptorului ca eșec al întregului rezultat.
Nu folosi un cont admin ca înlocuitor implicit pentru contul unui client.

Prompturile vechi `planifica` / `pregateste` (inclusiv `--...`) sunt compatibile cu fluxul
complet și reutilizează ce există. Dacă omul cere explicit numai una dintre etape,
respectă cererea. `repeta` oferă implicit verificarea pregătirii și scenariul întreg, fără
interviu pas cu pas. Repetiția ghidată începe numai la cererea explicită a omului.
`reseteaza` / `--reseteaza` rămâne operație separată, numai la cerere; nu intră în fluxul implicit.

## Rulare în Cursor

În Cursor, folosește același skill din pluginul Team Tracker instalat în Cursor.
Deschide local proiectul demonstrat și rulează `/prezentare <proiect> prezentarea <uuid>`
sau lipește promptul copiat din Team Tracker. Un prompt care menționează Codex ori
`team-tracker:prezentare` desemnează acest flux; execută-l în sesiunea Cursor curentă.
Nu cere schimbarea aplicației și nu lansa încă un agent sau trei skilluri pentru cele trei etape.

- Rezolvă scripturile și referințele relativ la acest `SKILL.md` instalat. Nu fixa o
  versiune din cache-ul Codex și nu folosi copiile vechi din `.agents/skills`.
- Verifică accesul MCP Supabase disponibil în Cursor la tracker și la proiectul demonstrat.
  Refolosește conexiunile existente; lipsa accesului devine blocaj explicit pentru pașii
  dependenți. Nu copia tokenuri din alt client și nu cere chei în conversație.
- Pornește aplicația cu comenzile repo-ului și verifică prin browserul disponibil în
  sesiunea Cursor. `@Browser`, `@Chrome` și Claude Preview din prompturi indică etapa de
  verificare, nu un nume obligatoriu de instrument. Dacă browserul lipsește, predă
  scenariul cu verificările web deschise; nu declara succes doar din build sau cod.
- Păstrează ținta de aproximativ 20 de minute și revizuirea independentă. Omul trimite
  problemele în aceeași conversație Cursor. Telefonul rămâne operat de om.
- Aplică Pontajul comun numai cu identitatea și timestampurile verificabile ale acestei
  conversații. Nu folosi transcriptul Codex; fără dovezi compatibile, Pontajul rămâne în așteptare.

## Bugetul unei rulări complete

Ținta implicită este aproximativ **20 de minute de lucru al agentului**, distinct de
`document.duration_minutes`, durata întâlnirii. Nu scurta întâlnirea la 20 de minute și
nu promite finalizarea unor fluxuri neverificate ca să te încadrezi.

- Citește ceasul la început și stabilește termenul de predare. Verifică timpul după fiecare
  etapă; după 15 minute concentrează-te pe livrabil, iar de la 18 minute salvează și predă.
  Nu porni operații lente aproape de termen. Închide scrierile deja începute în siguranță;
  orice depășire tehnică se raportează, nu se ascunde.
- Citește contextul o singură dată; grupează lecturile independente. Recitește revizia
  înaintea scrierilor și configurația sensibilă înaintea efectelor externe.
- Distribuție orientativă: 5 minute progres și selecție, 8 minute date/acces, 5 minute
  verificare esențială, 2 minute salvare și predare. Refolosește dovezile actuale din task,
  fără a repeta audituri complete, schema cunoscută sau verificări identice între etape.
- Nu porni audit general, suită completă de regresie, build/deploy sau remedieri extinse
  în pregătirea unei prezentări. Verifică traseele esențiale și schimbările relevante;
  consemnează ce nu ai verificat. Noutățile nepublicate primesc URL local sau blocaj explicit.
- Dacă lipsește o informație necesară pentru un anumit pas, păstrează-l blocat și continuă
  restul. Întreabă doar dacă nu poți identifica deloc proiectul/prezentarea/baseline-ul.
  Nu aștepta conectarea telefonului ori răspunsuri după fiecare pas.
- Rezultatul este un scenariu utilizabil pentru revizuire chiar dacă unele puncte sunt
  blocate. Bugetul nu permite declararea falsă a unui rezultat `passed`/`completed`.

## Contractul întâlnirii

- Omul conduce demonstrația și repetiția efectivă, inclusiv acțiunile de pe telefon.
  Omul parcurge scenariul singur după predare și trimite problemele în același task.
  Agentul pregătește datele, accesul, versiunea disponibilă și pașii exacți; poate verifica
  web-ul pentru pregătire. Nu pilotează automat telefonul și nu marchează pașii omului ca trecuți.
- Instalarea unei versiuni pe telefon, când este cerută, se verifică separat de funcționarea
  aplicației native. Absența dispozitivului lasă verificarea nativă deschisă.
- Datele pregătite pot apărea normal în aplicațiile și bazele reale, fără etichete DEMO sau
  izolare vizibilă. Identificarea pentru mentenanță este internă, prin ID-uri și registre.
- Plățile, mesajele, notificările și celelalte integrări cu efecte externe cer mod TEST verificat
  și destinatari de test. Citește și trigger-ele: un INSERT poate trimite notificări.
- Conturile sunt dedicate prezentării; parolele rămân într-un handoff privat în afara repo-ului
  și trackerului. Datele populate, verificarea web, instalarea APK și demonstrația omului sunt dovezi distincte.

## Înainte de orice operație

1. Rezolvă proiectul și ID-ul prezentării; recitește prezentarea, destinatarul, revizia, resursele,
   ultimele rulări și `tt_delivery_profiles.launch_stage`. Câmpul este doar citit.
2. Verifică schema live prin `information_schema.columns` înaintea query-urilor necunoscute;
   refolosește schema deja citită în aceeași rulare cât timp nu există o migrare nouă.
   Nu executa un adaptor pe alt proiect decât cel verificat în registru și prezentare.
3. Citește [contractul de persistare](references/tracker-contract.md). Helperul
   `scripts/prezentare.mjs` produce descriptori SQL/pași; nu execută nimic în fundal.
4. Pentru operațiile pe produs citește
   [pregătirea Motion](references/project-adapters.md), regulile repo-ului și schema live.

## Planifică

Folosește ultima prezentare **ținută** cu același destinatar, nu data ultimei borne și nici
ultima prezentare cu alt client. Pentru prima prezentare cere data de început dacă lipsește.
Snapshotul întâlnirii anterioare și rezultatele efective decid ce a fost demonstrat.

Inventariază paginat schimbările din intervalul relevant din tracker: features, bugs,
To-Do și dovezile existente din UI Coverage/teste/publicare. Grupează sursele acelorași
schimbări; investighează detaliat doar elementele selectate pentru scenariu. Compară cu
Git și versiunea publicată. Dacă bugetul nu permite terminarea inventarului, declară
acoperirea parțială și sursele rămase; nu pretinde că ai inventariat tot proiectul.
`updated_at` selectează candidați, nu dovedește finalizarea. Notează pentru fiecare schimbare
beneficiul clientului, sursa, dovada și starea. `scripts/planning.mjs` oferă selecția baseline-ului,
reportarea elementelor sărite și clasificarea conservatoare a dovezilor.

Propune din nou elementele selectate dar nedemonstrate anterior. Păstrează ordinea, notele,
excluderile și textul editat de om. Pentru sursele existente actualizează conservator numai
starea calculată și dovada tehnică; o verificare veche nu rămâne validă după un blocaj nou.
Scrie regenerarea prin RPC cu revizia citită; la conflict recitește și refă adăugările și
actualizarea dovezilor, fără suprascrierea textului ori alegerilor omului.

Fiecare pas are schimbarea, persoana, rolul, dispozitivul, URL-ul, condițiile inițiale,
acțiunea, rezultatul așteptat și durata. Setează `manual=true` pentru pașii executați de om.
Indică ce pagină deschide el, ce face clientul de pe telefon și ce rezultat vede fiecare.
Capabilitățile nesuportate primesc un pas manual/blocaj explicit.

## Pregătește

Pornește o rulare `prepare` cu cheia de idempotentă stabilă. Rulează inspecția adaptorului,
verifică conturile, accesul și versiunea. Pregătește numai resursele cerute de scenariul ales.
La proiectele fără adaptor nu invoca adaptorul Motion: înregistrează resursele existente
verificate ca reutilizate și lipsurile în scenariu. Nu crea o resursă blocată fictivă doar
pentru că lipsește un adaptor; dacă o resursă cerută este efectiv blocată, păstrează blocajul
și respectă statusul `failed` al rulării, explicând partea utilizabilă a prezentării.

Pentru creație: salvează mai întâi intenția în Team Tracker, execută tranzacția produsului
care scrie și resursa și receipt-ul, apoi citește receipt-ul și salvează starea `ready`.
La răspuns pierdut recitește aceeași cheie; nu genera altă cheie și nu adopta o coliziune.
`executePreparation` din `scripts/transport.mjs` implementează această ordine.

Pentru reutilizare: înregistrează `ownership=reused`, ID-ul și dovada citirii, fără a pretinde
că resursa aparține prezentării. După acțiuni prin UI/API, capturează ID-urile returnate și
relația cu contul dedicat; păstrează-le în registru. Lipsa unei dovezi de proprietate blochează
resetarea, nu lectura sau prezentarea acelei resurse.

## Verifică și predă

Execută preflight-ul versiunii, accesului, datelor și integrărilor; recitește cursurile, taberele
și evenimentele dependente de timp. Oferă omului scenariul ordonat cu linkuri și QR din Team Tracker.
O verificare web a agentului este dovadă de pregătire și se menționează separat.
În fluxul complet, salvează verificările agentului în rularea `prepare` și predă scenariul.
Nu porni automat `rehearsal` și nu transforma predarea într-o conversație cu întrebări
după fiecare pas. Absența telefonului se notează, fără a bloca predarea scenariului web.

## Repetiția omului, la cerere

Rularea `rehearsal` înregistrează numai rezultate observate sau raportate explicit de omul
care a parcurs pașii. Pașii încă neexecutați rămân fără rezultat; nici disponibilitatea unui
link, nici instalarea APK nu înseamnă `passed`. Nu copia rezultate din repetiție în rularea `live`.
La schimbarea versiunii, scenariului sau datelor, verificările vechi rămân dovezi istorice
și necesită o nouă repetiție. Rezultatul include dispozitivul real și ora observării.

## Resetează

Pornește rulare `reset`. Resetează numai ID-uri cu ownership creat verificat, în ordinea
inversă a dependențelor. Helperul cere fingerprintul recitit și refuză modificări concurente,
FK-uri dependente sau resurse străine. Nu folosi nume/prefixe și nu șterge receipt-urile.

Conturile Auth nu se șterg automat. Plățile, înscrierile și acțiunile cu
efecte externe se tratează numai prin contractele lor de produs; nu se anulează prin DELETE.
O resursă reutilizată rămâne intactă. La resetare nesuportată marchează blocajul și propune
un scenariu nou, fără a falsifica starea inițială.

## Închidere

Raportează prezentarea, versiunea și datele pregătite, ce poate demonstra omul, blocajele și
pașii rămași pentru repetiție. Predă un singur rezultat în Team Tracker: noutățile și
beneficiile, scenariul complet ordonat cu linkuri/roluri/rezultate așteptate, accesul fără
secrete, ce ai verificat și lista scurtă a limitelor. Dă linkul și spune „Revizuiește în
ritmul tău; trimite aici numărul pasului și problema.” Nu încheia cu o întrebare pentru pasul 1.
Nu schimba durata întâlnirii, selecția sau notele omului pentru a economisi timp.

Când omul revine cu o problemă, continuă în același task: recitește pasul și versiunea
curentă, investighează și corectează punctual datele/scenariul sau codul autorizat, apoi
reverifică partea afectată. Nu relua întregul inventar și nu cere alte skilluri/prompturi.
Pentru reparații de cod aplică verificările și livrarea proiectului; bugetul pregătirii
nu anulează aceste cerințe și nu înseamnă că orice reparație încape în 20 de minute.

Rezultatele și închiderea întâlnirii se consemnează în modulul
Prezentări; aprobarea clientului rămâne separată de demonstrație. Nu modifica automat
bornele atinse, cererile închise, aprobările UI sau `launch_stage`.
