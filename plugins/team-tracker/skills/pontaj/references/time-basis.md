# Proveniența orelor și capacitatea umană

Orele unei conversații sunt o estimare a activității agentului. Nu dovedesc timpul
lucrat de om. Două conversații paralele de câte 1h produc 2h de estimări ale
conversațiilor; nu se prezintă drept 2h de muncă umană și nu se scad automat din
capacitatea persoanei. Nici reuniunea intervalelor nu măsoară efortul uman.

Schema existentă rămâne neschimbată. Rândurile noi păstrează proveniența în
`description`, cu un singur marker la final:

| Bază | Marker | Folosită drept timp uman consumat |
|---|---|---|
| Ore declarate explicit de persoană sau reconciliate de ea în Pontaj | `[pontaj:basis=human_declared]` | Da, după verificarea zilei/persoanei și a duplicatelor |
| Durată estimată din conversație, inclusiv checkpointuri automate | `[pontaj:basis=conversation_estimate]` | Nu |
| Istoric fără proveniență, marker invalid sau markere contradictorii | fără marker valid | Nu; status de confirmat |

`scripts/work-log-basis.mjs` este classifierul pentru planificare. Eticheta istorică
`[durată activă estimată din conversație]` rămâne recunoscută. Un marker explicit
uman prevalează față de această etichetă, pentru reconcilierea făcută de om.
Un ID negativ, identitatea colegului ori categoria nu dovedesc singure proveniența.
Nu rescrie înregistrările istorice și nu adăuga o declarație umană pe baza calculului
agentului. O corecție de timp se face numai pentru rândurile și orele confirmate
explicit de persoană; nu se dublează checkpointurile printr-un nou pontaj integral.

La fiecare replanificare citește toate logurile live ale persoanei pentru ziua
locală, din toate proiectele. Deduplică după ID; o copie contradictorie oprește
calculul. Arată separat orele umane declarate, estimările conversațiilor și orele
cu bază necunoscută. Nu însuma bazele sub titluri precum „timp real” sau „ore
consumate”. O lipsă de loguri nu dovedește că persoana nu a lucrat.

Numai orele umane declarate/reconciliate pot consuma bugetul uman sau reduce
estimarea rămasă a unui item. Dacă există estimări/neclarități și disponibilitatea
actuală nu este deja declarată, propunerea semnalează reconcilierea necesară și
nu promite un nou buget de lucru. Nu inventa orele umane și nu declara întreaga
capacitate liberă doar fiindcă ai exclus estimările. Folosește fără încă o întrebare
o declarație disponibilă în context, precum „am 4h disponibile”, „am full” sau
„nu ține cont de ore”; transformă formulările relative în ore doar când referința
lor este verificată (de exemplu bugetul profilului). Păstrează în snapshot declarația
și valoarea folosită; nu modifica orele istorice ori capacitatea viitoare.

`tt_project_velocity` și `tt_delivery_calibration` sunt date istorice. Înainte să
folosești un factor/P50/P75 drept efort uman, verifică definiția live a view-ului și
bazele logurilor din eșantion. Un view mixt sau fără proveniență nu este calibrare
umană: păstrează eticheta istorică, omite factorul și folosește estimarea din cod,
cu incertitudinea explicită. Poți recalcula read-only pe loguri umane confirmate
dacă eșantionul și legăturile sunt suficiente; nu crea sau modifica view-uri.

Un receipt `prepare` existent rămâne imuabil la upgrade: se retrimite exact
SQL-ul pregătit, cu aceeași descriere și același ID. Classifierul recunoaște
eticheta lui veche; markerul nou se adaugă numai în receipts nou pregătite.
