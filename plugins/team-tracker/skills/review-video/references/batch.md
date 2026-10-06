# Briefuri compacte și joburi pe clip

Citește această referință pentru mai multe scenarii/viewporturi sau când delegi cu
`fork_turns: "none"`. Pentru un clip poți transmite aceleași date direct în mesaj.
Grupează întâi criteriile în cât mai puține scenarii clare, apoi pregătește joburile.

## Brief

Salvează JSON într-un director temporar al taskului, în afara repo-urilor și cache-ului
pluginului. `repo_path` este absolut; `revision` identifică **aplicația testată**, nu
doar ultimul commit presupus. Pentru schimbări necomise include identificatorul
patchului/snapshotului și explică workerului cum se verifică. Nu pune credențiale,
storage state sau date personale în brief; `session_hint` indică sesiunea/tabul permis.

```json
{
  "project": "Proiectul curent",
  "repo_path": "C:/workspace/aplicatie",
  "revision": "revizia verificata in sesiune",
  "url": "http://localhost:3000/formular",
  "criteria": [
    { "id": "open", "text": "Formularul se deschide" },
    { "id": "long-name", "text": "Numele lung ramane lizibil" },
    { "id": "validation", "text": "Datele invalide arata eroarea" },
    { "id": "offline", "text": "Eroarea de retea este explicata" }
  ],
  "scenarios": [{
    "id": "formular",
    "title": "Deschidere si validare",
    "steps": [
      { "action": "Deschide formularul din butonul verificat in sesiune", "expected": "Formularul apare" },
      { "action": "Introdu numele sintetic lung din context", "expected": "Textul ramane lizibil" },
      { "action": "Declanseaza validarea locala cu acel camp invalid", "expected": "Apare mesajul de validare verificat; nu se persista date" }
    ],
    "covers": ["open", "long-name", "validation"]
  }],
  "viewports": [
    { "id": "desktop", "width": 1440, "height": 900 },
    { "id": "mobile", "width": 390, "height": 844 }
  ],
  "capture": { "mode": "shared-desktop" },
  "context": {
    "session_hint": "Tabul de test deja pregatit; confirma proprietatea cu parintele",
    "test_data": "Date sintetice pregatite; nume: Exemplu Demonstrativ Cu Un Nume Foarte Lung",
    "allowed_actions": ["navigare", "completare cu date sintetice", "validare locala fara salvare"],
    "recorder": "Metoda reala si comenzile permise, confirmate din documentatia sesiunii",
    "isolation_evidence": "Desktop si cursor comune: control exclusiv acordat de parinte"
  },
  "unavailable_states": ["Nu se simuleaza defecte asupra serviciului real"],
  "unavailable_criteria": [{ "id": "offline", "reason": "Eroarea de retea nu poate fi fortata cu instrumentele permise" }]
}
```

Înlocuiește exemplul cu URL-ul, controalele și mesajele **observate**. `context` și
`unavailable_criteria` sunt opționale în schema helperului; completează contextul
necesar înainte de controlul browserului. Fiecare criteriu trebuie fie acoperit de
un scenariu, fie declarat indisponibil cu motiv. Acoperirea declarată în brief nu
dovedește că pasul a fost executat. Stările indisponibile nu devin criterii trecute.

`capture.mode` se stabilește din capabilitățile verificate:

- `isolated`: recorder, input și date independente; verifică izolarea înainte de
  paralelism. Declarația din JSON nu este dovadă.
- `shared-desktop`: pregătirea/inputul/captura au un singur proprietar activ.
- `unavailable`: nu există recorder permis; nu porni workers care ar înregistra.
  Refolosește dovezile existente și raportează lipsa video.

## Helper

Din directorul skillului instalat, identificat prin catalogul sesiunii:

```sh
node scripts/prepare-jobs.mjs --brief <scratch/brief.json> --out <scratch/jobs-nou> --slots 4 --occupied 1 --effort low --model gpt-6.1-sol
```

`--slots` este limita **totală** a sesiunii; `--occupied` numără subagenții deja
ocupați cu alte lucrări, fără părinte. Exemplul lasă doi workers liberi:
4 − 1 părinte − 1 ocupat. Verifică lista agenților la dispatch; manifestul este
doar un buget pregătit, nu o rezervare. Dacă nu sunt sloturi libere, refolosește un
agent devenit liber sau execută secvențial în părinte.

`--model` trebuie să fie un identificator GPT Sol cu `low`/`medium` **disponibil în
catalogul curent**. Helperul verifică forma identificatorului, nu disponibilitatea.
`low` este implicit; folosește `medium` doar pentru ambiguități concrete. Nu schimba
modelul global al utilizatorului și nu configurează agenți permanenți.

Ieșire: `manifest.json` și câte un director per scenariu × viewport, cu `job.json`
și `worker-prompt.md`. Directorul de ieșire trebuie să fie nou/gol; helperul refuză
suprascrierea și scrierea în repo-ul aplicației ori sursa/cache-ul pluginului.
Nu pornește server, browser, recorder, agenți sau uploaduri.

## Dispatch și rezultat

Părintele citește manifestul și trimite conținutul promptului jobului prin tool-ul
`spawn_agent`, cu nume distinct, `fork_turns: "none"`, modelul și effortul alese.
Promptul conține directorul absolut și contractul video; adaugă numai dovezile și
instrucțiunile permise din sesiune care lipsesc. Pe resurse comune, comunică explicit
„ai controlul” unui singur worker; următorul primește controlul după eliberare.
Workers fără recorder nu trebuie lansați doar pentru a redescoperi același blocaj.

Păstrează un rezultat pe job: `recorded`, `blocked` sau `capture_unavailable`, cu
fișierul real dacă există, durata verificată, timestamps și dovezile din SKILL.md.
Nu transforma `recorded` automat în `verified`: părintele inspectează fiecare clip.
Retryul folosește un director nou și reface numai clipul afectat; nu suprascrie
dovezile anterioare și nu reînregistrează întregul lot.

Nu promite un timp total măsurat fără probă. Înregistrarea trebuie să lase timp
pentru citirea rezultatului; economia vine din refolosirea contextului, prompturi
scurte, lipsa montajului și paralelismul efectiv permis.
