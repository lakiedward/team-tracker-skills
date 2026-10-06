# Video de review după task

Omul lucrează pe mai multe proiecte deodată și nu poate urmări fiecare sesiune. După orice
task cu schimbare **vizibilă pentru utilizator**, îi lași **în conversație** un video scurt al
rezultatului. Așa vede imediat ce s-a făcut și îți spune dacă e de acord cu cum funcționează.

Aici e descris **ce** trebuie să primească omul. **Cum** produci și cum atașezi clipul e alegerea
ta: înregistrarea nativă a platformei (Cursor, Devin etc.), un script de browser sau orice altă
metodă care respectă contractul. Nu există o unealtă impusă.

Pentru execuție rapidă, folosește [`team-tracker:review-video`](../review-video/SKILL.md):
brief din scenariul deja verificat, GPT Sol low/medium și joburi pe clip/viewport.
Paralelismul capturii depinde de izolarea reală a recorderului și inputului; pe
desktop/focus comun se filmează pe rând. Dacă nu există recorder permis, livrarea
video rămâne deschisă, cu motivul concret; screenshots nu țin loc de înregistrare.

## Ce trebuie să arate clipul

- **Rezultatul terminat, în aplicația reală.** Clipul arată comportamentul, nu codul și nici
  drumul tău până acolo: fără încercări greșite, fără timp mort.
- **Cursorul și fiecare click se văd**, ca omul să urmărească ce s-a apăsat și ce a urmat.
- **Câte un clip pe viewport:** desktop, plus mobil când e vorba de UI.
- **Scurt**, ideal sub 90 de secunde pe clip. Mai bine două clipuri clare decât unul lung.
- **Pașii sunt etichetați**, pe ecran sau în mesaj (secunda + ce se întâmplă), ca omul să
  sară direct la pasul care îl interesează.
- **Acoperă criteriile taskului, nu doar drumul fericit.** Arată stările care contează: gol,
  eroare, încărcare, date lungi. Dacă o stare nu poate fi forțată, spune asta în mesaj.
- **Nimic sensibil pe ecran:** fără parole, tokenuri sau date personale reale. Folosește date
  de test.

## Cum ajunge la om

- **Doar în chat.** Atașează clipul la răspunsul de final, cu tool-ul de trimis fișiere sau
  atașamentul nativ al clientului. Dacă nu poți atașa, pune link-ul ori calea locală
  clicabilă. Nu-l urca în Team Tracker și nu-l scrie în baza de date.
- Lângă clip pui 1–4 propoziții în română: ce s-a schimbat, la ce să fie atent omul și ce
  a rămas neverificat.
- Răspunsul omului („e ok” / „nu e bine, …”) vine în aceeași conversație. Tratează-l ca
  feedback pe task: repari și trimiți un clip nou.

## Când nu faci clip

- **Taskuri fără efect vizibil** (migrări, backend, refactor): un rezumat cu dovada
  verificării (SQL, teste) ajunge. Nu inventa un clip care nu arată nimic.
- **Funcții care nu se pot arăta în browser** (push, biometrie, plugin nativ): spune ce
  rămâne de verificat pe telefon, în loc de un clip incomplet.
