---
name: prezentare
description: "Pregătește întâlnirile Motion cu clienții din Team Tracker: progresul de la ultima prezentare, date reale pentru demonstrație, accesul, scenariul pe roluri și dispozitive, repetiția ghidată și resetarea resurselor deținute. Folosește când utilizatorul invocă /prezentare pentru Motion ori cere să pregătească o demonstrație Motion. Se leagă de bornele și întâlnirile existente; nu mută borne și nu confirmă în locul omului pașii făcuți pe telefon."
---

# prezentare — pregătirea unei întâlniri Motion cu clientul

Aplică [execuția locală](../references/local-execution.md). Folosește pluginul instalat,
registrul [proiectelor](../orchestrate/projects.json) și prezentarea salvată în Team Tracker.
Adaptorul disponibil este Motion. Pentru alt proiect raportează capabilitatea indisponibilă.
Exemple: `/prezentare motion planifica prezentarea <uuid>`, `/prezentare motion pregateste prezentarea <uuid>`,
`/prezentare motion repeta prezentarea <uuid>`, `/prezentare motion reseteaza prezentarea <uuid>`.
Acceptă și argumentele `--planifica`, `--pregateste`, `--repeta`, `--reseteaza`.

## Contractul întâlnirii

- Omul conduce demonstrația și repetiția efectivă, inclusiv acțiunile de pe telefon.
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
2. Verifică schema live prin `information_schema.columns` înaintea query-urilor necunoscute.
   Nu executa un adaptor pe alt proiect decât cel verificat în registru și prezentare.
3. Citește [contractul de persistare](references/tracker-contract.md). Helperul
   `scripts/prezentare.mjs` produce descriptori SQL/pași; nu execută nimic în fundal.
4. Pentru operațiile pe produs citește
   [pregătirea Motion](references/project-adapters.md), regulile repo-ului și schema live.

## Planifică

Folosește ultima prezentare **ținută** cu același destinatar, nu data ultimei borne și nici
ultima prezentare cu alt client. Pentru prima prezentare cere data de început dacă lipsește.
Snapshotul întâlnirii anterioare și rezultatele efective decid ce a fost demonstrat.

Inventariază toate paginile de rezultate din tracker: features, bugs, To-Do, UI Coverage,
planuri/rezultate de test și dovezi de publicare. Compară cu Git și versiunea publicată;
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

Pentru creație: salvează mai întâi intenția în Team Tracker, execută tranzacția produsului
care scrie și resursa și receipt-ul, apoi citește receipt-ul și salvează starea `ready`.
La răspuns pierdut recitește aceeași cheie; nu genera altă cheie și nu adopta o coliziune.
`executePreparation` din `scripts/transport.mjs` implementează această ordine.

Pentru reutilizare: înregistrează `ownership=reused`, ID-ul și dovada citirii, fără a pretinde
că resursa aparține prezentării. După acțiuni prin UI/API, capturează ID-urile returnate și
relația cu contul dedicat; păstrează-le în registru. Lipsa unei dovezi de proprietate blochează
resetarea, nu lectura sau prezentarea acelei resurse.

## Repetă

Execută preflight-ul versiunii, accesului, datelor și integrărilor; recitește cursurile, taberele
și evenimentele dependente de timp. Oferă omului scenariul ordonat cu linkuri și QR din Team Tracker.
O verificare web a agentului este dovadă de pregătire și se menționează separat.

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
pașii rămași pentru repetiție. Rezultatele și închiderea întâlnirii se consemnează în modulul
Prezentări; aprobarea clientului rămâne separată de demonstrație. Nu modifica automat
bornele atinse, cererile închise, aprobările UI sau `launch_stage`.
