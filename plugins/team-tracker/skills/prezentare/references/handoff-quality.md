# Predare coerentă pentru revizuire

O prezentare poate rămâne parțial verificată, dar trebuie să poată fi deschisă și parcursă
fără instrucțiuni contradictorii. Închide această verificare în bugetul aceleiași rulări.

## Câmpuri necesare

- `document.app_version`: identificator verificat al aplicației efectiv demonstrate.
  Preferă commitul publicat; dacă nu poate fi legat de Git, folosește deployment ID sau
  identificatorul exact al bundle-ului observat și declară limita. Nu inventa un SHA și
  nu scrie „latest”. Observarea unui bundle nu verifică automat fiecare schimbare.
- `document.data_version`: referință la configurația recitită a resurselor, de exemplu
  run ID și momentul verificării; fără parole sau date sensibile.
- `document.urls`: linkurile aplicației, separat de linkurile pașilor.
- `document.preparation`: destinatar/scop, roluri, acces disponibil, inventar și limite,
  mediu + versiune skill, dovezi desktop/mobil separate, blocaje actuale, momentul predării.

Fără versiunile aplicației și datelor, Team Tracker nu permite începerea repetiției sau
întâlnirii. Completează-le prin `tt_presentation_save`; `tt_presentation_regenerate` nu
scrie aceste câmpuri. Dacă nu poți identifica aplicația, explică blocajul fără o valoare fictivă.

## Când se rezolvă un blocaj

`tt_presentation_regenerate` păstrează textele și pașii existenți pentru a proteja editările
omului. Nu poate corecta singur mesajele „cont lipsă”, chiar dacă resursa a devenit `ready`.

1. Recitește prezentarea, resursele și ultima rulare; păstrează documentul ca bază.
2. Identifică textele invalidate de dovada nouă în schimbări, pași și pregătire.
3. Modifică numai afirmațiile factuale depășite. Păstrează ID-urile, ordinea, selecțiile și
   formulările omului care rămân valabile. Un pas duplicat generat pentru același flux poate
   fi eliminat din draftul curent; snapshoturile istorice nu se modifică.
4. Salvează documentul corectat prin `tt_presentation_save`, cu exact revizia recitită.
   La conflict, recitește și reaplică doar corecțiile; nu suprascrie documentul concurent.
5. Citește rezultatul din DB. Un cont verificat nu poate apărea simultan ca lipsă în pașii
   activi. O resursă creată nu se înregistrează ca `reused` doar pentru a ocoli identitatea
   înghețată a unei intrări vechi: folosește registrul corect și nu pretinde drept de resetare.

## Dovezi și acoperire

- Pentru un pas mobil web, verifică viewportul și traseul real, nu doar desktopul. Salvează
  URL, dimensiuni, rezultat, oră și captură. Un viewport mobil nu este un telefon fizic.
- Salvează observațiile agentului în `prepare.summary` și în `changes[].evidence`, cu
  pasul, dispozitivul, ora și dovada. Contractul actual respinge rezultate de pas pentru
  `prepare`/`reset`: trimite `results=[]`. Faptul că pasul este manual pentru om nu interzice
  o verificare separată a agentului; repetiția și demonstrația omului rămân necompletate.
- Consemnează erorile din consolă și limitele lor; nu spune „fără erori” dacă există mesaje
  de la o integrare externă. Nu rezolva CAPTCHA și nu trimite formulare ca să ascunzi limita.
- Pentru admin, include ce poate arăta prezentatorul, ce cont îi trebuie și ce nu a fost
  reverificat. Generarea AI, emailurile, plățile și AWB-urile cer în continuare TEST verificat.
- Pentru fiecare schimbare selectată: un pas care o demonstrează sau un motiv explicit că
  este numai informativă/blocată. Leagă schimbările grupate prin ID-uri în explicația pasului.
- Recitește totalul duratelor. Încadrează scenariul în durata întâlnirii, lăsând loc pentru
  feedback; nu scurta durata întâlnirii pentru bugetul agentului.

## Verificarea finală

Recitește documentul salvat și confirmă: versiunile și linkurile există, rolurile corespund
scopului întâlnirii, textele nu contrazic resursele, nu există pași dublați, acoperirea și
limitările sunt vizibile, iar repetiția poate fi pornită. Un `prepare` cu o resursă blocată
rămâne `failed` conform contractului; explică separat partea utilizabilă și blocajul rămas.
