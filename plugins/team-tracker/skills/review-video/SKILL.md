---
name: review-video
description: Record short review videos of completed user-visible changes in the real application. Use after a Team Tracker UI task, for /review-video, /generate-video, or requests for desktop and mobile result clips. Reuses verified scenarios and delegates independent clips to local GPT Sol low or medium agents in Codex; delivers videos only in chat.
---

# review-video — clipuri rapide ale rezultatului

Aplică [contractul video](../references/review-video.md) și
[execuția locală](../references/local-execution.md). Acest skill produce dovada
rezultatului după verificarea taskului; nu repetă implementarea sau întregul QA.
Pentru marketing folosește `team-tracker:marketing`, iar pentru pregătirea unei
întâlniri `team-tracker:prezentare`.

## Brief și captură

Refolosește din sesiune repo-ul/worktree-ul, revizia testată, serverul pornit,
URL-ul exact, autentificarea disponibilă, criteriile și datele de test. Nu redeschide
`/proiect` și nu reface inventarul. Pentru o cerere directă citește numai contextul
necesar și verifică scenariul înainte de înregistrare.

Grupează criteriile într-un parcurs scurt pe viewport: desktop și mobil pentru UI.
Preferă un singur scenariu compact care acoperă mai multe criterii; separă clipurile
când ar depăși 90 s sau ar deveni greu de urmărit. Include stările relevante de gol,
eroare, încărcare și date lungi; listează explicit ce nu poate fi demonstrat.

Verifică **înainte de delegare** că există o metodă de înregistrare continuă reală,
permisă în sesiune. Citește documentația instrumentului de browser sau a recorderului
nativ disponibil; nu presupune API-uri de recording. Refolosește recorderul existent,
fără instalarea unui nou stack și fără instrumentele interzise de utilizator.
O captură Windows se operează prin instrumentul Computer Use documentat în sesiune.
Nu folosi slideshow-uri din screenshots drept video al comportamentului.

Confirmă că recorderul include cursorul și face clickurile ușor de urmărit. Folosește
evidențierea nativă dacă există; altfel mută vizibil cursorul la control, apoi arată
clickul și efectul lui. Verifică acestea în fișierul rezultat, nu doar în preview.
Pregătește pagina și datele înainte de start, fără ecrane de autentificare în clip.

Localhost poate folosi backendul real. Brief-ul include operațiile deja autorizate;
nu repeta scrieri, mesaje, plăți sau porți umane doar pentru filmare. Folosește date
de test și scenarii fără efecte externe, ori mediul de demo verificat pentru task.

## Agenți Codex și paralelism

În Codex folosește subagenții locali ai **aceleiași sesiuni**, prin `spawn_agent`;
nu crea chaturi noi, agenți cloud sau procese Codex autonome. Un worker per clip.
Părintele pornește/verifică serverul și deține Pontajul; workerii nu modifică cod,
nu fac merge/deploy, nu scriu în tracker și nu pontează separat.

- Model: cel mai nou **GPT Sol** disponibil în catalogul curent (de exemplu
  `gpt-6.1-sol`). Verifică identificatorul și suportul pentru effort.
- **`low` implicit** pentru un parcurs deja verificat; **`medium`** când există
  ambiguități de navigare sau recorder. Un blocaj de acces/captură nu se rezolvă
  schimbând modelul. Nu escalada automat la un model mai puternic.
- Trimite `fork_turns: "none"`, `model` și `reasoning_effort` explicit, plus brief-ul
  compact și calea contractului. Nu copia istoricul complet al implementării.
- Folosește numai sloturile libere din sesiune. Cu patru sloturi totale sunt cel
  mult trei workers, mai puțini dacă alte subtaskuri sunt încă active.
- Capturează simultan numai după verificarea izolării recorderului, inputului și
  datelor: fiecare worker are propriul tab/context și director de ieșire. Taburi
  diferite nu dovedesc singure izolarea.
- Dacă focusul, cursorul, profilul/datele ori capturarea sunt comune, părintele
  acordă pe rând dreptul de control. Serializează și pregătirea care mută focusul;
  paralelizează doar munca fără interacțiune, inspecția fișierelor și encodarea.
  Nu permite doi workers să controleze simultan desktopul sau browserul comun.

În clienți fără selecție de model/subagenți folosește același brief și instrumentele
permise, secvențial dacă este necesar; precizează limita, fără a promite Sol/paralelism.

Pentru mai multe clipuri folosește [formatul brief-ului și helperul de joburi](references/batch.md).
Helperul pregătește fișiere și prompturi; **nu pornește agenți și nu înregistrează**.
Pentru un singur clip scurt, brief-ul poate fi transmis direct, fără fișiere intermediare.

## Execuție și predare

Workerul execută numai pașii primiți, observând rezultatul real după fiecare acțiune.
Înregistrează un take curat, fără explorare, cod, încercări greșite sau timp mort.
Păstrează pauzele necesare lizibilității; viteza nu justifică ascunderea loadingului
sau a unui defect. Timestamps în mesaj sunt suficiente: fără montaj, muzică,
voiceover sau randare suplimentară dacă nu au fost cerute.

Folosește formatul nativ al recorderului dacă se redă în client. Nu transcoda și nu
upscala implicit. Workerul returnează calea absolută a fișierului, URL-ul, viewportul,
revizia, durata din player/metadata, timestamps, criteriile arătate, stările lipsă și
rezultatul verificării consolei. Consola se verifică separat, în afara clipului;
fără un instrument permis, rezultatul este „consolă neverificată”.

Părintele verifică redarea și momentele de început/click/rezultat/final pentru fiecare
clip: cursor, efecte, lizibilitate, date sensibile, durată și corelarea cu revizia.
O diferență de revizie cere revalidarea scenariului afectat. Mobil responsive nu
înseamnă verificare nativă; clipul local nu dovedește publicarea. Corectează o dată
numai clipul defect; dacă rămâne blocat, păstrează celelalte și raportează lipsa.

Atașează fiecare video în final folosind suportul nativ al clientului; în Codex un
fișier media local poate fi afișat cu `![Review desktop](/cale/absoluta/desktop.mp4)`.
Dacă previewul nu funcționează, oferă linkul local clicabil. Adaugă timestamps și
1–4 propoziții în română despre rezultat și limite. Fără upload sau rânduri în Team
Tracker; verdictul omului rămâne în conversație.

Dacă nu există recorder permis, spune **„Video indisponibil: <motiv concret>”**,
predă dovezile UI disponibile și păstrează livrarea video deschisă. Nu pretinde
că joburile pregătite, capturile statice sau buildul îndeplinesc contractul.
