# @projectsociety/mcp-core

Plomberie MCP partagée : registre d'outils, garde de confirmation, journal d'audit,
chargement de configuration, exécution de processus.

```bash
npm install @projectsociety/mcp-core
```

Extrait de deux serveurs MCP réels — [`hammer-mcp`](https://github.com/ProjectSocietyStudio/hammer-mcp)
et `gmod-mcp` — plutôt que conçu dans l'abstrait. Ce qui suit dit pourquoi, et surtout ce
qui est délibérément resté chez les serveurs.

Node ≥ 20. `@modelcontextprotocol/sdk` ≥ 1.30 et `zod` ^3.23 sont des **peer dependencies** :
c'est le serveur hôte qui les fournit, pour qu'il n'existe qu'une seule instance du SDK.

## Pourquoi il existe

Les deux serveurs ont d'abord dupliqué cette plomberie **délibérément** — ~350 lignes entre
deux dépôts, un paquet partagé aurait été prématuré. Le README de `hammer-mcp` avait écrit
le seuil de révision : « un troisième serveur MCP, ou le même bug de plomberie corrigé deux
fois ».

Ce seuil a été atteint le 11/08/2026, sur deux fronts à la fois :

1. **La dérive était déjà là.** `clip()` vivait dans le `registry.ts` de hammer-mcp et se
   retrouvait recopiée deux fois côté gmod-mcp (`tools/local.ts`, `tools/dev.ts`) ;
   `stripAnsi()` n'existait que d'un côté, le bloc image `IMAGE_KEY` que de l'autre. Trois
   divergences sur six fichiers.
2. **La montée du SDK arrivait.** Passer de `^1.12` à `1.30` — et exploiter ce qu'elle
   débloque (`outputSchema`, `serverInstructions`, elicitation, notifications de
   progression) — aurait été à faire et à prouver deux fois.

## Ce qui monte, ce qui ne monte pas

| Monte | Reste chez le serveur |
|---|---|
| `ToolRegistry`, `defineTool`, `isCallAllowed` | `fs/guard.ts` (hammer) — discipline d'écriture propre à ses arbres |
| `createMcpServer`, `successResult`, blocs image | `bridge/`, `bridge/lock.ts` (gmod) — le verrou et le transport fichier |
| `AuditLog` | `patch/engine.ts` (gmod) — sauvegarde/restauration de fichiers |
| `loadConfig`, `findRepoRoot` | le **schéma** de config de chacun |
| `run`, `clip`, `stripAnsi` | l'enum `Realm` de chacun — `map`/`local` contre `sv`/`cl`/`local` |

Le noyau est **paramétré, pas générique par principe** : `loadConfig` prend la variable
d'environnement et le nom du répertoire d'état ; `AuditLog` prend le vocabulaire de kinds
du serveur ; `ToolDef` est générique sur le contexte et sur le realm, si bien que chaque
serveur garde son propre `defineTool` typé via `makeToolkit`.

`installProject` prend le chemin du point d'entrée **en paramètre**. C'est le piège de
l'extraction : le code d'origine le calculait par `new URL("./index.js", import.meta.url)`,
qui, déplacé ici, aurait résolu vers le `dist/` du noyau et installé le mauvais binaire.

## Développement

```bash
pnpm install
pnpm build       # tsc -> dist/
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit, tests inclus
```

Les consommateurs lisent le `dist/` publié. En développement local — un checkout des
serveurs à côté de celui-ci, consommé par `file:../mcp-core` — **reconstruire est
nécessaire** pour qu'un changement leur parvienne. Le piège se paie une fois : un `dist/`
périmé rend les tests verts et le typecheck rouge sur le même arbre.

## L'oracle qui prouve le partage

Un test qui passe ne prouve rien tant qu'on n'a pas montré qu'il sait échouer, et un
paquet « partagé » qui serait en réalité recopié passerait tous les tests de la même façon.
Le contrôle est donc direct : neutraliser la garde dans `src/registry.ts`, reconstruire, et
lancer les trois suites. Mesuré le 11/08/2026 —

| Suite | Résultat |
|---|---|
| `mcp-core` | 2 échecs / 21 |
| `hammer-mcp` | 1 échec / 46 |
| `gmod-mcp` | 2 échecs / 130 |

Un seul octet changé ici fait rougir les deux serveurs. C'est la propriété qu'on voulait.
