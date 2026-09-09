# Șabloane de slide-uri (1080×1350, 4:5)

## Design din tema proiectului

Pentru postările noi, `post.visual_direction.theme` provine din contextul extras al paginii proiectului: `background`, `text`, `muted`, `accent`, `fonts` (`display`, `body`, `serif`, `mono`) și `background_asset`. Imaginea fundalului este captura deterministă a efectului original, la rezoluția finală. Calea ei și fiecare `slide.asset` sunt relative la snapshotul `--assets`; traversările și legăturile simbolice în afara lui sunt respinse.

Ordinea aplicării: tema proiectului → `visual_direction.composition` → `slide.design`. `slide.design.theme` suprascrie numai câmpurile declarate; restul identității rămâne. AI-ul alege compoziția, iar preferințele explicite din conversație au prioritate. Nu introduceți CSS liber în JSON.

`compose` este layoutul flexibil pentru text și un mockup original. `layout_variant` poate fi `stack`, `split` sau `full`; cele opt layouturi existente primesc aceleași culori, fonturi și fundal. În modul dinamic, imaginile folosesc implicit `frame: "none"`, astfel încât mockupurile deja încadrate nu primesc încă o ramă.

| Câmp `design` | Valori acceptate |
|---|---|
| `align` | `left`, `center` |
| `headline_size`, `body_size` | 36–120 px; 22–42 px |
| `image_fit`, `image_position` | `contain`/`cover`; `top`/`center`/`bottom` |
| `image_scale` | 0.25–1 din spațiul disponibil; plafonat la pixelii nativi |
| `frame` | `none`, `phone`, `browser` |
| `layout_variant` | `stack`, `split`, `full` (pentru `compose`) |
| `background_opacity` | 0–1 |
| `margin`, `gap` | 48–140 px; 16–96 px |
| `theme` | Suprascriere parțială validată a temei |

`slide.source_asset` păstrează metadatele extrase (`width`, `height`, hash, sursă) și opțional `crop: {x0,y0,x1,y1}` normalizat la 0–1. Rendererul decupează direct pixelii imaginii originale și folosește dimensiunile decodate pentru a evita mărirea artificială. `crop: null` înseamnă folosirea întregii imagini.

Rendererul așteaptă explicit încărcarea documentului, fonturilor și decodarea imaginilor prin Chromium CDP. Refuză imagini defecte, erori ale fundalului și texte ieșite din zona sigură. Un render complet reușit scrie `reviewed-post.json` și `reviewed-render.json`, care leagă rețeta și fiecare PNG prin SHA-256 înainte de publicarea versiunii în Team Tracker. `--only` produce previzualizări și invalidează acel marker; rulați randarea completă înainte de finalizare.

Testele pure rulează cu `node scripts/render-slides.test.mjs`. Testele reale de culori, crop, rezoluție și erori rulează cu `node --test scripts/render-slides.browser.test.mjs` dacă Chromium este disponibil.

## Compatibilitate cu postările vechi

Descrierea următoare documentează valorile studioului folosite numai dacă postarea nu conține o direcție vizuală nouă. `example-post.json` rămâne un exemplu de compatibilitate, nu o sursă pentru identitatea vizuală a unui proiect nou.

Fiecare fișier din `slides/` este un HTML self-contained: încarcă fonturile din Google Fonts (Bricolage Grotesque 700 pentru titluri, Sora 400/600 pentru text, Instrument Serif italic pentru cuvântul accentuat, JetBrains Mono pentru etichete), fixează corpul la `1080×1350px` cu `overflow: hidden`, ține totul în zona sigură de 96px și randează în josul paginii wordmark-ul `> alki|studio` (stânga) și contorul `{{n}} / {{total}}` (dreapta).

`scripts/render-slides.mjs` completează placeholder-ele `{{nume}}`: toate valorile sunt escapate HTML, iar în `headline` textul dintre `*asteriscuri*` devine `<em class="serif">…</em>` (Instrument Serif italic, culoarea de accent). Placeholder-ele fără valoare devin șir gol; elementele goale (`.kicker`, `.body`, `.meta`, `.pill`, `.cta`) se ascund singure din CSS. Accentul (`{{accent}}`) este un hex; implicit `#C8FF3E` (lime).

| Layout | Scop | Placeholder-e comune | Placeholder-e specifice |
|---|---|---|---|
| `cover` | Prima planșă: titlu uriaș (108px), kicker sus, meta jos, fără imagine. | `kicker`, `headline`, `meta`, `n`, `total`, `accent` | — |
| `statement` | O singură propoziție tare (72px) centrată vertical, cu body în ink estompat sub ea. | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | — |
| `screenshot_phone` | Titlu (56px) + body, apoi o captură portret într-o ramă de telefon (max ~880px înălțime, `object-fit: cover` aliniat sus, orice raport intră). | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | `asset_src` (obligatoriu) |
| `screenshot_desktop` | Titlu + body, apoi o captură de desktop într-un card „browser” lat de 888px (bară cu trei puncte, raport 1600×924). | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | `asset_src` (obligatoriu) |
| `split` | Coloană de text în stânga (kicker, titlu 64px, body, meta) și o ramă de telefon în dreapta. | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | `asset_src` (obligatoriu) |
| `diagram` | Kicker + titlu, apoi două coloane de chips (Input → Output) cu o săgeată în accent; body împins jos. | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | `inputs_html`, `outputs_html` (construite de script din `inputs` / `outputs` despărțite cu `\|`) |
| `stat` | O cifră uriașă (220px, accent) cu `headline` ca etichetă, body și un pill mono obligatoriu pentru cifre de mockup. | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | `stat`, `disclaimer` (pill-ul se afișează ori de câte ori valoarea nu e goală) |
| `cta` | Ultima planșă: wordmark-ul mare în centru, titlu (92px), body ca invitație, `cta` ca link/handle în accent. | `kicker`, `headline`, `body`, `meta`, `n`, `total`, `accent` | `cta` |

Câmpurile din `post.json` (`kicker`, `headline`, `body`, `meta`, `asset`, `inputs`, `outputs`, `stat`, `disclaimer`, `cta`, `accent`) se mapează 1:1 pe placeholder-e; `asset` (cale relativă la `--assets`) devine `asset_src` ca URL `file:///`, iar `n` / `total` vin din `order_index` și numărul de slide-uri. Un exemplu complet cu toate cele 8 layout-uri este în `example-post.json`.
