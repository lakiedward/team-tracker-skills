---
name: marketing-generate
description: Produce or revise Instagram copy and slide images for Team Tracker. Use for /marketing generate, /marketing regen, /marketing-generate, carousel rendering or conversational visual changes. Inherits each project's presentation background, text theme and original mockups; AI art direction composes slides and optionally explores alternatives with the human. Saves complete versions for review; never approves or publishes to Instagram.
---

# marketing-generate — design din proiect, decis cu AI și omul

Aplică [execuția locală și verificarea în browser](../references/local-execution.md).
Schema și exemplele sunt în [contractul vizual](references/visual-direction.md).

## 1. Contextul real

Primește proiectul și postările din /marketing; direct, fă Faza 0 de acolo.
Folosește pagina proiectului din portofoliu, nu automat tema globală a studioului.

```sh
node scripts/project-context.mjs --repo <presentation-repo> --project <slug> --out <scratch/context> --language en
```

Rezultatul: context.json, assets/ (originale + fundal PNG 1080×1350), sources/.
Directorul de ieșire trebuie să fie nou sau gol; nu amesteca sursele a două extrageri.
Adaptorul WebsitePresentation citește projects.js, moodPalettes.js, tokenii CSS și shaderul real.
Nu modifica repo-ul sursă sau cache-ul pluginului. La altă structură, construiește și verifică un adaptor
cu aceeași ieșire din componentele reale; nu substitui pe ascuns fundalul generic.

Mockupurile vin din referințele explicite ale proiectului, inclusiv variantele pe limbă.
Inspectează originalele. Păstrează transparența și crop-ul; dacă există deja ramă, folosește frame: none.
Alege cea mai bună variantă existentă a aceleiași imagini; nu face screenshot al paginii sau upscale AI.
Dacă rezoluția e mică, micșorează imaginea în compoziție sau alege alt asset.
O imagine fără variantă explicită de limbă este marcată `original`; inspecteaz-o și nu pretinde că a fost tradusă.

## 2. Direcția artistică AI și conversația opțională

AI-ul sesiunii este directorul artistic: inspectează pagina și mockupurile, apoi decide hook-ul, ordinea,
compoziția, mărimea imaginii, spațiul liber și ritmul. Explică alegerea în visual_direction.summary și rationale.
Obiectiv: atent compus, simplu, captivant, lizibil pe telefon, specific proiectului. Evită decorul gratuit,
cifrele inventate și repetarea mecanică. Nu promite engagement măsurat fără dovezi.

Defaulturile sunt fundalul real al paginii, fonturile și culorile textelor ei. Layouturile sunt puncte
de pornire; compose permite stack/split/full și ajustări validate.

- „Generează”: decide autonom; nu impune un pas de aprobare a designului.
- „Hai să alegem designul”: arată 2–3 coperți randate și ajustează după conversație.
- „Mai aerisit / mockup mai mare”: schimbă numai parametrii ceruți.
- „Doar fundalul slide-ului 3”: păstrează textele și asseturile; schimbă numai acel fundal.
- „Revino la tema proiectului”: restaurează defaulturile în aria cerută.

Salvează cererile în visual_preferences pe campanie/postare; slide_preferences pentru un slide.
Nu folosi feedback pentru alegeri creative din chat: este nota omului din aplicație.
Folosește resolveVisualDirection din scripts/visual-contract.mjs: proiect → campanie → postare → slide.
La regenerare, pornește de la snapshotul precedent; nu reîmprospăta tema fără să se fi cerut.

## 3. Copia și rețeta

Un subagent per postare, în paralel, după stabilirea direcției comune a campaniei. Fiecare primește
contextul real, cererile omului, brief-ul și aria modificării; scrie doar postarea și fișierele lui.

post.json conține post_id, caption, hashtags, slides, visual_direction, source_manifest.
Fiecare slide: order_index 0-based, layout, headline, body, asset, source_asset din inventar și design.
Caption engleză ≤2200 caractere, ≤5 hashtag-uri fără #, headline ≤12 cuvinte, body ≤25.
Faptele vin din textele proiectului. Cifrele de demo necesită „sample output, not client results”.

## 4. Randare și review vizual

```sh
node scripts/validate-post.mjs --post <post.json> --assets <context/assets>
node scripts/render-slides.mjs --post <post.json> --assets <context/assets> --out <scratch/render>
```

Chromium așteaptă fonturile și imaginile, verifică depășirile și limitează imaginile la pixelii nativi.
Fundalul shader are timp și poziție fixe salvate în manifest. Inspectează TOATE slide-urile și caruselul
împreună: fidelitate, contrast, ierarhie, crop, rezoluție, margini, varietate. Verifică la dimensiune de telefon.
Corectează și randează din nou. --only e pentru iterații locale; înainte de persistare randează complet.
Un template nou cerut în conversație trebuie validat și păstrat în context/sources/custom-templates.
Randează-l cu `--templates <context/sources/custom-templates>`; adaugă fișierele și hashurile lor în
`context.json.source_manifest.theme_sources` și în manifestul postării înainte de randarea finală.

## 5. Salvare după inspecția vizuală AI

SUPABASE_SERVICE_ROLE_KEY trebuie să existe înainte de orice scriere externă; nu o afișa.

```sh
node scripts/generation-io.mjs publish --post <post.json> --context <context-dir> --dir <render-dir> --project <project_id> --expected-version <versiunea-citita>
```

Helperul verifică rețeta randată, salvează sursele în bucketul privat marketing-assets, alocă atomic
o versiune și creează slide-urile goale. Urcă și completează fiecare slide pe rând, apoi validează
completitudinea și marchează generated. La eșec păstrează ultima versiune completă și istoricul încercării.
Nu incrementa manual versiunea și nu folosi vechile UPDATE-uri directe de început/finalizare.
Numele publish al helperului înseamnă salvare pentru review în Team Tracker, nu publicare pe Instagram.

Pentru regenerare, restaurează source_manifest al versiunii selectate:
```sh
node scripts/generation-io.mjs restore --manifest <source-manifest.json> --out <restored-context>
```
Pentru legacy fără snapshot, extrage sursele actuale și precizează diferența; nu afirma reproducere exactă.
La un răspuns de rețea incert după finalizare, folosește `generation-io.mjs recover --post <id> --version <n>`;
helperul verifică starea înainte să încerce din nou. La start incert, recitește postarea și istoricul înainte
de orice retry; nu aloca automat încă o versiune și nu marca eșuată o versiune deja finalizată.

## Limite și raport

- Nu scrie approved_at, approved_version, feedback, published_* sau statusurile deciziilor umane.
- Postările aprobate/publicate sunt înghețate; o nouă variantă devine altă postare.
- Sursă neverificabilă, asset lipsă sau validare eșuată după două corecții: oprește acea postare și explică.
- Nu suprascrie imaginile unei versiuni finalizate.

Raportează titlu/id, versiune, temă, personalizări, slide-uri schimbate, verificări și imagini salvate.
Încheie cu „Așteaptă verificarea ta în Team Tracker → Marketing”.
