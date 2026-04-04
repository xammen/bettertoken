# BetterToken - Known Issues & Post-Mortem

## Issue 1: Plugin impossible a desinstaller via le TUI

**Severite**: Critique
**Status**: Non resolu

Quand bettertoken est installe via le TUI d'OpenCode (Shift+I / Install plugin), il est impossible de le desinstaller completement. Meme apres :
- Toggle off dans Plugins
- Suppression du `plugin-meta.json`
- Suppression du cache `~/.cache/opencode/node_modules/bettertoken`
- Suppression de la cle `plugin_enabled` dans `kv.json`
- Kill de tous les process bun

OpenCode re-telecharge le package npm et le reactive au prochain demarrage.

**Cause probable**: OpenCode persiste la liste des plugins installes dans un endroit qu'on n'a pas identifie (possiblement une DB SQLite, ou le serveur backend re-resolve les plugins depuis un etat en memoire avant de se fermer).

**Workaround**: `npm unpublish` le package de la registry npm pour qu'OpenCode ne puisse plus le trouver. Solution destructive.

**A investiguer**: 
- Chercher une base SQLite dans `~/.local/state/opencode/` ou `~/.cache/opencode/`
- Regarder le code source d'OpenCode pour comprendre comment les plugins TUI installed sont persistes
- Trouver la difference entre un plugin dans `tui.json` (config) et un plugin installe via le TUI (runtime)

---

## Issue 2: Commande /bettertoken et menu Ctrl+K ne fonctionnent pas

**Severite**: Critique
**Status**: Partiellement resolu

`api.command.register()` retourne bien une fonction de dispose (l'enregistrement semble reussir), mais la commande n'apparait jamais dans :
- La palette Ctrl+K (command_list)
- Le slash command `/bettertoken` dans le prompt

Pourtant :
- `api.ui.toast()` fonctionne
- `api.ui.dialog.replace()` fonctionne (teste avec setTimeout)
- `api.slots.register()` fonctionne (footer s'affiche)
- `api.event.on()` fonctionne (tokens collectes)
- `api.command.trigger("bettertoken.stats")` n'a pas ete teste

**Cause probable**: Le `command.register()` dans `dialog-command.tsx` utilise `runWithOwner()` avec le SolidJS reactive owner. Quand le plugin est `async` (ce qu'il etait initialement), l'owner est perdu. Apres avoir retire le `async`, le probleme persiste, possiblement a cause du conflit avec la version npm du plugin qui charge en parallele.

**Hypotheses non testees**:
- Conflit d'ID entre la version npm et la version file:// (les deux ont `id: "bettertoken"`)
- La version npm (v0.1.1 avec le bug async) ecrase les commandes de la version locale
- Le `register` fonctionne mais le `CommandProvider` ne re-evalue pas ses `registrations` quand un plugin externe s'ajoute

**A investiguer**:
- Tester avec UNIQUEMENT la version file:// (aucune version npm, aucun plugin_enabled)
- Ajouter du logging dans `dialog-command.tsx` pour voir si la commande est dans `entries()`
- Tester `api.command.trigger("bettertoken.stats")` pour confirmer que la commande est enregistree mais pas affichee

---

## Issue 3: `showMain()` bloquait indefiniment (RESOLU)

**Severite**: Haute
**Status**: Resolu

La fonction `showMain()` etait `async` et faisait `await Promise.all(api.client.session.get(...))` pour chaque session dans "Top Sessions". Si une session avait ete supprimee ou si le serveur etait lent, l'`await` ne se resolvait jamais et le menu ne s'ouvrait pas.

**Fix**: Retire tous les `await` et `async` de `showMain()` et `doExport()`. Les titres de sessions affichent l'ID tronque au lieu du vrai titre.

---

## Issue 4: `session_usage` slot ne remplacait pas le natif

**Severite**: Moyenne
**Status**: Resolu

Quand `replace_native` etait active, le slot `session_usage` rendait un `<text>` imbrique dans un `<span>` dans un `<text>` -- structure invalide en opentui. Le `<text>` ne peut contenir que des `<span>`, `<b>`, etc.

**Fix**: Cree un composant `InlineView` separe qui rend un `<span>` au lieu d'un `<text>`.

---

## Issue 5: Unicode escapes affiches en clair

**Severite**: Faible
**Status**: Resolu

Les caracteres unicode (`\u00b7` pour `·`, `\u203a` pour `>`, etc.) s'affichaient en clair dans le TUI au lieu d'etre interpretes.

**Fix**: Remplace toutes les escape sequences par les caracteres ASCII equivalents (`·` -> ` · `, `>` -> `>`).

---

## Issue 6: Tokens gonfles par le cache read

**Severite**: Moyenne
**Status**: Resolu

Le mode `display: "total"` additionnait `input + output + reasoning + cache_read + cache_write`. Les `cache_read` sont enormes (le contexte complet est relu du cache a chaque tour) et gonflaient artificiellement le compteur.

**Fix**: Le mode `total` exclut `cache_read` (qui n'est pas un token "consomme"). Un mode `all` est disponible pour voir le total reel incluant le cache.

---

## Issue 7: Pas de synchro cross-session

**Severite**: Moyenne
**Status**: Resolu

`api.kv.get()` lit depuis un store SolidJS en memoire, charge une seule fois au demarrage. Les modifications faites par d'autres sessions n'etaient jamais visibles.

**Fix**: Utilise un fichier dedie `bettertoken.json` lu directement depuis le disque avec `fs.readFileSync()`. Un cache `mtime` evite de relire le fichier quand il n'a pas change.

---

## Issue 8: Race condition sur l'ecriture

**Severite**: Moyenne
**Status**: Resolu

Deux sessions ecrivant en meme temps pouvaient perdre des entrees (read cache -> write = ecrase les entrees de l'autre session).

**Fix**: `record()` force un read frais du disque (bypass le cache mtime) avant d'ecrire, pour merger avec les entrees des autres sessions.

---

## Architecture du plugin

```
bettertoken/
  package.json          # exports "./tui" + bin "bettertoken"
  bin/
    bettertoken.js      # wrapper CLI (Node -> Bun)
  src/
    tui.tsx             # plugin TUI SolidJS (~840 lignes)
    cli.ts              # CLI: patch/unpatch/init/status
```

### Dependances
- OpenCode >= 1.3.13
- Bun (pour le CLI et le runtime)
- `@opencode-ai/plugin` (peer dep)

### Slots utilises
- `sidebar_footer` (natif) : stats dans la sidebar
- `session_footer` (natif) : stats sous le footer (fallback sans patch)
- `session_usage` (patch requis) : stats inline a cote du TPS et context%

### Stockage
- `~/.local/state/opencode/bettertoken.json` : donnees de tokens (entries + seen)
- `~/.local/state/opencode/kv.json` cle `bettertoken.config` : config du plugin
