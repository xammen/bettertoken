# BetterToken - Spec Complete

## Qu'est-ce que c'est
Plugin TUI pour OpenCode qui track la consommation de tokens cumulee entre toutes les sessions (today, yesterday, week, month, all-time) avec synchro temps reel entre sessions.

## Comment ca s'installe
- Plugin configure dans `~/.opencode/tui.jsonc` (PAS `~/.config/opencode/tui.json`)
- Le bon fichier de config TUI est `~/.opencode/tui.jsonc`

## Bug critique decouvert
- `api.command.register()` ne fonctionne PAS quand il y a beaucoup de code dans le meme fichier
- Solution: separer le code en deux fichiers (logic.tsx + tui.tsx) OU tout mettre dans un seul fichier TRES court
- Le test plugin minimal (30 lignes) marche. Le meme code dans un fichier de 800+ lignes ne marche pas.
- `import "./logic"` (side-effect) ne casse PAS le register
- MAIS importer et UTILISER les fonctions de logic.tsx dans le callback du plugin casse le register
- Hypothese: Bun a un bug avec les gros fichiers TSX ou les imports circulaires JSX pragma

## Architecture cible
```
bettertoken/
  package.json
  bin/bettertoken.js     # CLI wrapper Node -> Bun
  src/
    tui.tsx              # Plugin entry (DOIT etre court)
    logic.tsx            # Toute la logique metier
  src/cli.ts             # CLI: patch/unpatch/init/status
```

## Features implementees

### 1. Collecte de tokens
- Ecoute `api.event.on("message.updated")` 
- A chaque message assistant complete, enregistre:
  - timestamp, sessionID, modelID, providerID
  - input, output, reasoning, cache_read, cache_write tokens
  - cost (estime si l'API reporte $0)
- Dedup par message ID (Set)

### 2. Estimation de cout
- Quand `msg.cost === 0`, lookup le modele via `api.state.provider`
- Calcul: (input * rate.input + output * rate.output + reasoning * rate.output + cache_read * rate.cache.read + cache_write * rate.cache.write) / 1_000_000
- Les rates viennent de models.dev (auto-refresh par OpenCode)

### 3. Stockage fichier (synchro cross-session)
- Fichier dedie: `~/.local/state/opencode/bettertoken.json`
- PAS api.kv (qui est en memoire seulement, pas synchro)
- Lecture directe avec `fs.readFileSync`
- Cache mtime: ne relit que si le fichier a change (`fs.statSync`)
- `record()` force un read frais du disque (bypass cache) avant d'ecrire pour merger avec les autres sessions
- Rotation: entries > 90 jours sont purgees au write
- seen[] borne a 5000 entrees

### 4. Config
- Stockee dans `api.kv` (cle `bettertoken.config`) -- pas besoin de synchro cross-session pour les settings
- Champs:
  - display: "total" | "output" | "input" | "cache" | "all"
    - total = input + output + reasoning + cache_write (PAS cache_read qui gonfle artificiellement)
    - all = tout inclus cache_read
  - show_cost: boolean -- afficher le cout dans le footer
  - compact: boolean -- "T:" au lieu de "Today:", separateur "|" au lieu de " | "
  - footer_periods: Period[] -- quels periodes afficher dans le footer
  - budget: { enabled, daily_tokens, daily_cost, monthly_tokens, monthly_cost }

### 5. Periodes supportees
- today: depuis minuit
- yesterday: minuit hier -> minuit aujourd'hui
- week: depuis lundi 00:00
- month: depuis le 1er du mois
- all: tout

### 6. Footer (slots)
- `sidebar_footer`: toujours affiche
- `session_footer`: affiche sous le footer natif (fallback sans patch)
- `session_usage`: affiche inline a cote du TPS (necessite patch)
  - Inclut le context % (lookup model.limit.context)
  - Format: " · 181.1K (18%) · T:45K|M:1.2M"
- Budget: footer passe en rouge (#EF4444) avec "! " devant quand un seuil est depasse
- Un seul timer (setInterval 2s) partage entre tous les composants footer

### 7. Dashboard (DialogSelect via Ctrl+K > BetterToken)
Menu principal avec categories:
- **Usage**: Today, Yesterday, Week, Month, All-time -- chaque ligne montre tokens + cout
  - Cliquer dessus ouvre un DialogAlert avec breakdown (input/output/reasoning/cache_read/cache_write/cost/messages)
- **Stats**: Daily avg + sparkline 7 jours (caracteres unicode ▁▂▃▅▇)
- **By Model**: breakdown par provider/model (trie par cout desc)
- **Top Sessions**: 5 sessions les plus gourmandes (ID tronque, tokens, cout, nb messages)
- **Settings**: tous les settings modifiables inline
- **Actions**: Export clipboard + Reset data

### 8. Settings (sous-menus du dashboard)
- **Display mode**: DialogSelect avec les 5 modes, reste ouvert apres selection
- **Show cost**: toggle direct avec toast
- **Compact mode**: toggle direct avec toast
- **Footer periods**: DialogSelect multi-toggle avec [x]/[ ] devant chaque periode, reste ouvert
- **Budget alerts**: sous-menu avec toggle on/off + DialogPrompt pour chaque seuil
- Chaque sous-menu a un "<- Back" en premiere option
- Les settings sont sauvegardees dans api.kv (persistant)

### 9. Budget / alertes
- 4 seuils configurables: daily_tokens, daily_cost, monthly_tokens, monthly_cost
- Quand un seuil est depasse: footer rouge + "! " prefix
- Configurable via le sous-menu Budget dans le dashboard

### 10. Export clipboard
- Copie un rapport texte complet via OSC52 (`\x1b]52;c;BASE64\x07`)
- Contenu: periodes, daily avg, sparkline, by model, top sessions, metadata

### 11. Sparkline
- 7 derniers jours en unicode: ▁▂▃▅▇
- Affichee dans la section Stats du dashboard
- Normalisee par rapport au max des 7 jours

### 12. Daily average
- total tokens / nombre de jours depuis la premiere entree
- Affichee dans la section Stats du dashboard

### 13. CLI (bin/bettertoken)
Commandes:
- `bettertoken init`: ajoute le plugin dans tui.jsonc
- `bettertoken patch`: applique le patch inline (session_usage slot)
- `bettertoken unpatch`: retire le patch
- `bettertoken status`: montre l'etat d'installation
- `bettertoken help`: aide

### 14. Patch inline (optionnel)
Modifie 2 fichiers dans le source OpenCode:
1. `packages/plugin/src/tui.ts`: ajoute `session_usage` dans TuiSlotMap
2. `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`:
   - Import TuiPluginRuntime
   - Wrappe le bloc context/cost dans un `<Slot name="session_usage" mode="replace">`
   - Le TPS meter reste TOUJOURS visible (en dehors du slot)

### 15. Detection du patch
- Au chargement, le plugin verifie si le fichier source contient `name="session_usage"`
- Si patch detecte: session_usage actif, session_footer masque (pas de doublon)
- Si pas de patch: session_usage ignore silencieusement, session_footer actif (fallback)

## Fonctions helpers cles

### formatStats(entries, cfg) -> string
Genere le texte du footer: "Today: 45K $0.12 | Month: 1.2M $3.45"
En compact: "T:45K|M:1.2M"

### checkBudget(entries, cfg) -> { over: boolean, warnings: string[] }
Verifie si un seuil budget est depasse

### estimateCost(api, msg) -> number
Estime le cout quand msg.cost === 0

### contextInfo(api, sid?) -> string
Retourne "181.1K (18%)" -- le context % du dernier message assistant

### readDisk(api) / writeDisk(api, store)
Lecture/ecriture du fichier bettertoken.json avec cache mtime

### topSessions(entries, limit, mode) -> [sid, {tokens, cost, count}][]
Top N sessions triees par tokens

### sparkline(entries, mode) -> string
Histogramme unicode des 7 derniers jours

### dailyAvg(entries, mode) -> string
Moyenne quotidienne formatee

## Formats de donnees

### Entry (dans bettertoken.json)
```json
{
  "ts": 1712345678000,
  "sid": "ses_abc123",
  "model": "claude-sonnet-4-20250514",
  "provider": "anthropic",
  "input": 1200,
  "output": 450,
  "reasoning": 0,
  "cache_read": 800,
  "cache_write": 200,
  "cost": 0.0034
}
```

### Config (dans kv.json cle bettertoken.config)
```json
{
  "display": "total",
  "show_cost": true,
  "compact": true,
  "footer_periods": ["today", "month"],
  "budget": {
    "enabled": true,
    "daily_tokens": 500000,
    "daily_cost": 5.0,
    "monthly_tokens": 0,
    "monthly_cost": 0
  }
}
```

## Problemes connus a resoudre

1. **command.register ne marche pas dans un gros fichier**: Le plugin DOIT etre separe en un fichier court (tui.tsx ~50 lignes) et un fichier de logique (logic.tsx ~750 lignes). Le probleme semble lie a Bun/SolidJS qui perd le reactive owner quand le fichier est trop gros ou quand certains imports sont utilises.

2. **Le plugin npm s'auto-reinstalle**: Quand installe via le TUI (Shift+I), OpenCode persist le plugin dans plugin-meta.json et le re-telecharge a chaque demarrage. Difficile a desinstaller completement.

3. **Le bon fichier de config est ~/.opencode/tui.jsonc**: PAS ~/.config/opencode/tui.json. On a perdu beaucoup de temps a modifier le mauvais fichier.
