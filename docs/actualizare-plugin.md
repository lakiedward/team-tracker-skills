# Actualizarea pluginului pe fiecare client

Sursa unică e `master` din `lakiedward/team-tracker-skills`. Versiunea curentă e cea din
`plugins/team-tracker/.claude-plugin/plugin.json` (aceeași în manifestele Cursor și Codex).
Un client e la zi când versiunea **instalată** e egală cu aceasta și skill-ul apare în
catalogul unei conversații **noi**. O conversație deja deschisă rămâne pe versiunea veche.

## Claude Code

```text
/plugin marketplace update team-tracker
/plugin update team-tracker@team-tracker
```

Repornește Claude Code (sau deschide o sesiune nouă), apoi verifică în `/plugin` →
**Installed** că `team-tracker` arată versiunea curentă. Dacă `update` nu există în
versiunea ta de Claude Code, `/plugin uninstall team-tracker@team-tracker` urmat de
`/plugin install team-tracker@team-tracker` face același lucru.

## Codex

```bash
codex plugin marketplace upgrade team-tracker
codex plugin add team-tracker
codex plugin list --json | jq '[.[] | select(.name=="team-tracker") | {name, version}]'
```

`list` trebuie să arate o singură intrare, cu versiunea curentă. Dacă apar două versiuni
(de ex. o instalare de utilizator și una de proiect), elimină-o pe cea veche cu
`codex plugin remove team-tracker` în scope-ul ei și reinstalează o dată. Dacă `upgrade`
rămâne pe commitul vechi, reînregistrează marketplace-ul:

```bash
codex plugin marketplace remove team-tracker
codex plugin marketplace add lakiedward/team-tracker-skills
codex plugin add team-tracker
```

Pornește o sesiune Codex nouă. Autentificarea MCP (`codex mcp login team-tracker`) se
păstrează; nu trebuie refăcută la update.

## Cursor

```powershell
cursor-agent plugin marketplace update team-tracker
cursor-agent plugin marketplace list --format json
```

`gitRef` trebuie să fie commitul curent din `master`. Apoi **Developer: Reload Window** și
verifică în **Customize → Plugins** versiunea, iar în **Customize → Skills** că apar
skill-urile Team Tracker. Dacă `update` păstrează commitul vechi, urmează pașii din
[ghidul Cursor](cursor.md#dacă-actualizarea-păstrează-versiunea-veche) (remove + add cu
`--git-ref master`, apoi reinstalare din **Customize → Plugins** în același scope).

## Verificare comună

Într-o conversație nouă pe fiecare client, rulează `/plan-deadlines` pe un proiect: din
v1.46.0 propunerea afișează coada în blocuri, fiecare cu o propoziție de logică, iar itemele
poartă `grup=` și `logica_grup=`. O listă plată înseamnă că rulează încă o versiune veche.
