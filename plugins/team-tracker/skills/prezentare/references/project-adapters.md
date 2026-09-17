# Adaptor Motion pentru datele de prezentare

CLI-ul emite descriptori fără să execute SQL:

```text
node <plugin>/skills/prezentare/scripts/prezentare.mjs inspect input.json
node <plugin>/skills/prezentare/scripts/prezentare.mjs prepare input.json
node <plugin>/skills/prezentare/scripts/prezentare.mjs verify input.json
node <plugin>/skills/prezentare/scripts/prezentare.mjs reset input.json
node <plugin>/skills/prezentare/scripts/prezentare.mjs flow input.json
```

`input.json` conține `adapter='motion'`, `projectId=16`, `presentationId`,
`runId`, `resourceKey`, `ownerId`, `dedicatedAccountIds`, `table`, `payload`;
resetarea folosește `expectedFingerprint`. Nu include parole în acest fișier.
`inspect` are nevoie doar de adapter. Inspectează schema, constrângerile, trigger-ele și
versiunea reală înainte de a folosi un descriptor generat.

Bootstrapul `scripts/source-receipts.sql` este o migrare explicită, aplicată o singură dată
prin `apply_migration` în baza Motion. Nu rulează implicit din skill. Registrul
`tt_demo_source_receipts` este inaccesibil anon/authenticated și nu conține payload-uri.
Lipsa lui blochează pregătirea SQL, dar permite inspecția și pașii manuali.

Tranzacția verifică contul, rolul, cheile deterministe, receipt-ul și fingerprintul.
La resetare blochează rândul și verifică toate FK-urile dependente, inclusiv CASCADE și
SET NULL; pentru cursuri/tabere blochează tabelele înscrierilor polimorfice și notificărilor
înainte de verificare și refuză resetarea când acestea au înregistrări asociate. Dacă o relație de produs
nu este FK, citește și contractul ei înainte de a decide că o resursă poate fi resetată.

## Motion — proiect 16, `ehdzafadshbaaghzdzdo`

- Conturi: Auth Admin `createUser`, folosind `ensureAccount` și metadata internă de ownership.
  La retry verifică metadata și email-ul exact; o coliziune străină nu este adoptată.
  Trigger-ul actual creează PARENT; rolurile COACH/CLUB se acordă prin administrația produsului.
  Creează numai rolurile necesare; autentificarea și drepturile se verifică separat.
- SQL automat: copil al părintelui dedicat, club deținut de contul CLUB, curs gratuit al
  antrenorului dedicat fără club, tabără gratuită a antrenorului fără club. Folosește sportul
  și locația existente. Numele sunt normale; nu există prefix DEMO obligatoriu.
- Trigger-ele live `capture_course_push` și `capture_camp_push` pot publica notificări
  când există `club_id`. Din acest motiv, scenariile pentru club folosesc `productOperation`
  și verificarea destinatarilor de test; nu dezactiva trigger-ele și nu inventa dovada TEST.
- Înscrieri, confirmări și prezență: execută UI/API-ul actual, înregistrează ID-urile create,
  verifică părintele/copilul/cursul/tabăra și rezultatul în rolurile afectate. Nu fabrica plăți.
- Android: verifică infrastructura existentă în `motiontimisoaraApp/scripts/prepare-client-demo.mjs`,
  manifestul `/.well-known/motion-build.json`, APK-ul și configurația Capacitor. Instalarea pe
  telefon cere solicitarea omului; el parcurge apoi pașii. Reutilizarea canalului demo nu dovedește
  pornirea, permisiunile, push-ul sau plățile native pe dispozitiv.

## Efecte externe și limite

`requireTestBoundary` cere dovadă recentă: `mode='test'`, `livemode=false`, destinatari
`test_only`, referința verificării și timestamp. Aceste valori vin din inspecția reală a
providerului și aplicației, nu din presupunerea că proiectul este `pre_launch`.
Nu cere mod TEST pentru citirea paginilor ori popularea fără efecte externe.
`productOperation` întoarce o operație existentă sau pași de browser concreți; operațiile
nesuportate întorc `blocked`, fără a pretinde că au fost executate.

Teste: `node --test <plugin>/skills/prezentare/scripts/*.test.mjs`.
Testele SQL folosesc PGlite din repo-ul Team Tracker (`TT_APP_REPO` poate schimba locația).
Ele dovedesc tranzacțiile și limitele adaptorului, nu autentificarea ori plățile live.
