# Prezentări în Cursor

Pluginul Team Tracker expune același skill `prezentare` în Cursor, Codex și Claude Code.
Fișierul comun este `plugins/team-tracker/skills/prezentare/SKILL.md`; manifestul Cursor
indică întregul director `skills/`, păstrând scripturile și referințele dintre skilluri.

## Instalare și actualizare

Adaugă sau actualizează marketplace-ul prin Cursor Agent CLI, apoi activează pluginul
**Team Tracker** din **Customize → Plugins**, pentru utilizator sau proiect.
Pentru versiunile CLI care expun `plugin marketplace`, comenzile sunt:

```powershell
cursor-agent plugin marketplace list
# Numai dacă marketplace-ul lipsește:
cursor-agent plugin marketplace add https://github.com/lakiedward/team-tracker-skills
# După publicarea unei versiuni noi:
cursor-agent plugin marketplace update team-tracker
```

Numele executabilului poate fi `agent` în alte instalări; verifică `--help`.
Actualizarea marketplace-ului reindexează repository-ul. Nu înseamnă singură că o
conversație deschisă a încărcat noul skill. Rulează **Developer: Reload Window**, apoi
verifică în **Customize → Skills** că apare `prezentare` din Team Tracker. Versiunea
pluginului trebuie să fie cel puțin **1.39.3**, cu secțiunea „Rulare în Cursor”.

Nu modifica manual cache-ul identificat prin SHA și nu crea încă o copie personală a
skillului. Un plugin omonim din marketplace are prioritate față de o instalare locală.

### Dacă actualizarea păstrează versiunea veche

Verifică `cursor-agent plugin marketplace list --format json`: `gitRef` trebuie să
corespundă commitului publicat. În unele instalări, `update` reindexează commitul vechi,
iar un nou `add` schimbă descrierea fără să schimbe referința instalării. În acest caz,
reînregistrează numai marketplace-ul Team Tracker:

```powershell
cursor-agent plugin marketplace remove team-tracker
cursor-agent plugin marketplace add https://github.com/lakiedward/team-tracker-skills --git-ref master
```

Aceasta elimină și instalarea Cursor asociată. Reinstalează **Team Tracker** în același
scope din **Customize → Plugins** sau, în Cursor Agent CLI, din `/plugin` → Marketplace.
Verifică atât versiunea instalată, cât și prezența skillului; descrierea nouă din catalog
nu este suficientă. Nu este necesară ștergerea manuală a fișierelor sau a configurației MCP.

MCP Supabase trebuie conectat în Cursor, cu acces la Team Tracker și la proiectul
demonstrat. Folosește configurarea/autentificarea MCP din Cursor; nu pune chei în skill,
repository, prezentare sau conversație.

## O singură rulare

1. Deschide în Cursor proiectul demonstrat, de exemplu Motion, în Agent local.
2. În Team Tracker creează/deschide prezentarea și copiază promptul de pregătire.
3. Lipește promptul în Cursor. Eticheta butonului poate menționa Codex; promptul este
   compatibil cu același skill în Cursor. Alternativ, selectează `/prezentare` și scrie
   `Motion prezentarea <ID-ul real din Team Tracker>`.
4. Agentul pregătește noutățile, accesul/datele disponibile, scenariul și verificările
   esențiale într-o singură rulare de aproximativ 20 de minute. Nu trebuie să invoci
   separat planificarea, pregătirea sau repetiția.
5. Revizuiești în ritmul tău și trimiți în aceeași conversație numărul pasului și problema.
   Tu operezi telefonul și consemnezi rezultatele demonstrației efective.

Popularea și resetarea automate sunt disponibile numai pentru Motion. Un browser sau
telefon absent, accesul lipsă și modul TEST neconfirmat rămân limite vizibile în rezultat.
Nu porni pregătirea simultan în Cursor și Codex pentru aceeași prezentare.

Referințe: [pluginuri Cursor](https://cursor.com/docs/plugins),
[formatul pluginurilor](https://cursor.com/docs/reference/plugins),
[skilluri Cursor](https://cursor.com/docs/skills).
