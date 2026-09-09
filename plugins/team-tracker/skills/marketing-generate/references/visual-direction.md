# Contractul vizual

`context.json` conține `visual_direction` și `source_manifest`. Căile persistente sunt repo-relative.

```json
{
  "schema_version": 1,
  "summary": "Tema Betora, mockup mare și titluri scurte.",
  "rationale": "Produsul demonstrează ideea; spațiul liber păstrează lectura ușoară.",
  "theme": {
    "name": "Betora · tema paginii", "background": "#0A0A0C", "background_asset": "background.png",
    "text": "#EDEAE3", "muted": "rgba(237,234,227,0.55)", "accent": "#C8FF3E",
    "fonts": {"display":"Bricolage Grotesque","body":"Sora","serif":"Instrument Serif","mono":"JetBrains Mono"}
  },
  "composition": {"align":"left","margin":96,"background_opacity":1}
}
```

Acestea sunt exemple, nu defaulturi impuse altui proiect. Pentru fundal plat cerut explicit, setează
`composition.background_opacity:0` și culoarea dorită. Pentru altă imagine, adaug-o în assets și manifest.

Slide: `layout:compose`, `design.layout_variant:stack|split|full`, align, headline_size, body_size, margin,
gap, image_scale, image_fit, image_position, frame, background_opacity. Domeniile sunt validate în renderer;
nu introduce CSS liber în JSON. `source_asset` păstrează path, sha256, width/height, language, frame și
crop normalizat `{x0,y0,x1,y1}`. Un crop nou trebuie cerut explicit; implicit rămâne cel din proiect.

Preferință: `{schema_version:1,mode:'custom',request:'mai aerisit',overrides:{composition:{gap:56}}}`.
`resolveVisualDirection(defaults,campaignPrefs,postPrefs,slidePrefs)` păstrează câmpurile neatinse.
Preferințele per slide se țin în `post.visual_preferences.overrides.slide_preferences`, chei 1-based;
extrage-le înainte de rezolvarea postării și aplică-le separat în slide.design. `mode:'project_default'`
restaurează defaulturile în aria respectivă. `reviseSlides` păstrează literal câmpurile și slide-urile neatinse.

## Versiuni și API

`tt_marketing_post_versions`: brief/caption/hashtags, visual_direction, source_manifest, renderer_version,
status și momentele generării. `tt_marketing_slides.props` păstrează designul și metadatele fiecărui slide.
Manifestul include căile și hashurile surselor din Storage; restore verifică hashurile înainte de reutilizare.

- `tt_start_marketing_post_version(p_post_id,p_expected_version,p_snapshot)` → versiune nouă; brief are n 1-based.
- `tt_finish_marketing_post_version(p_post_id,p_version)` → toate imaginile există; numai helperul cu service key.
- `tt_fail_marketing_post_version(p_post_id,p_version,p_error)` → eșec salvat, revine la ultima versiune completă.
- `tt_approve_marketing_post(p_post_id,p_expected_version)` → numai sesiunea umană din aplicație.

După eșec, următoarea versiune este peste MAX(istoric), nu post.version+1. La conflict de versiune,
recitește înainte de retry; nu suprascrie munca altui agent. Sursele/fundalul sunt salvate, iar versiunea
rendererului este înregistrată; aspectul fonturilor externe poate necesita recuperarea fonturilor originale.
Pentru template-uri custom, păstrează folderul în `context/sources/custom-templates` și folosește
`--templates <restored-context/sources/custom-templates>` la regenerare. După modificări de text/design,
ambele markere de randare completă se refac; helperul verifică hashul rețetei și al fiecărui PNG.

## Review artistic înainte de salvare

1. Tema și fundalul sunt ale paginii proiectului ales?
2. Coperta exprimă o idee clară, demonstrată de mockup?
3. Textele sunt lizibile pe telefon peste fundalul real?
4. Mockupurile sunt originale, fără deformare, blur, rame duble sau crop accidental?
5. Caruselul are ritm și spațiu liber, păstrând o singură identitate vizuală?
6. Cererile omului sunt aplicate numai în aria cerută?

Acesta este review vizual AI; aprobarea și publicarea rămân la om în Team Tracker.
