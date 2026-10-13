# Vote 2026 — Système de vote électronique (prototype)

Prototype logiciel d'un système de vote électronique connecté : une interface de vote en
mode kiosque, un tableau de bord d'administration en temps réel, et un serveur central
qui enregistre et compte les votes.

Le serveur applique un principe clé du vote anonyme : **l'autorisation de voter est
séparée du bulletin**. Un jeton à usage unique est émis au moment de l'authentification,
puis consommé au moment du vote — de sorte qu'aucune donnée ne relie durablement un
électeur à son choix, à l'image de la liste d'émargement et de l'urne d'un bureau papier.

Aucune dépendance à installer : le serveur repose uniquement sur Node.js.

## Fonctionnalités

- **Interface de vote** (`vote.html`) : accueil, choix du candidat parmi une liste chargée
  depuis le serveur (plus le vote blanc), écran de confirmation, enregistrement réel du
  vote et animation de succès.
- **Tableau de bord d'administration** (`admin.html`) : participation, résultats par
  candidat avec barres, état du scrutin et contrôle d'intégrité, rafraîchis toutes les
  2 secondes ; ouverture et clôture du scrutin ; accès protégé par clé.
- **Serveur central** (`server.js`) : contrat d'API REST, jeton de vote à usage unique,
  idempotence (un rejeu du même jeton ne recompte pas), persistance des compteurs sur
  disque (reprise après redémarrage) et invariant d'intégrité vérifié en continu
  (« somme des compteurs = nombre de votants »).

## Démarrage

```bash
cd vote-app
node server.js
```

Dans le navigateur :

- Vote : <http://127.0.0.1:3000/vote.html>
- Administration : <http://127.0.0.1:3000/admin.html>

Variables d'environnement facultatives :

| Variable    | Rôle                           | Défaut            |
|-------------|--------------------------------|-------------------|
| `PORT`      | Port d'écoute                  | `3000`            |
| `HOST`      | Interface d'écoute             | `127.0.0.1`       |
| `ADMIN_KEY` | Clé d'accès au tableau de bord | `admin-2026-demo` |

## Déroulé de démonstration

1. Ouvrir l'administration et se connecter avec la clé d'administration.
2. Cliquer **Ouvrir le scrutin**.
3. Voter plusieurs fois depuis la page de vote : les compteurs montent en direct côté
   administration.
4. **Clore le scrutin** : la page de vote refuse alors toute nouvelle autorisation.

## Contrat d'API (préfixe `/api/v1`)

| Méthode | Chemin            | Authentification     | Rôle                                        |
|---------|-------------------|----------------------|---------------------------------------------|
| GET     | `/health`         | —                    | Version, état du scrutin, mémoire           |
| GET     | `/candidates`     | —                    | Candidats + vote blanc (id 0)               |
| POST    | `/auth`           | —                    | Émet un jeton de vote à usage unique        |
| POST    | `/vote`           | jeton dans le corps  | Enregistre le vote `{token, candidate_id}`  |
| POST    | `/session/cancel` | jeton dans le corps  | Annule une session en cours                 |
| GET     | `/admin/results`  | `Bearer <ADMIN_KEY>` | Participation, compteurs, intégrité         |
| POST    | `/admin/poll`     | `Bearer <ADMIN_KEY>` | Ouvre ou clôt le scrutin `{state}`          |
| GET     | `/admin/audit`    | `Bearer <ADMIN_KEY>` | Intégrité + compteurs d'événements          |
| POST    | `/admin/reset`    | `Bearer <ADMIN_KEY>` | Remise à zéro de démonstration              |

## Garanties de fiabilité

- **Vote unique par jeton** : un jeton n'autorise qu'un seul vote ; il est consommé puis
  mémorisé dans un anneau d'idempotence.
- **Idempotence** : un rejeu du même jeton renvoie `DEJA_ENREGISTRE` sans recompter.
- **Persistance** : les compteurs sont réécrits à chaque vote ; un redémarrage du serveur
  ne perd aucun vote enregistré.
- **Intégrité** : l'écart entre la somme des compteurs et le nombre de votants doit
  toujours valoir zéro ; il est exposé en permanence sur le tableau de bord.

## Structure

```
vote-app/
├── server.js            Serveur + API + service des fichiers statiques
├── data/
│   └── candidates.json  Candidats et nombre d'inscrits (source unique)
├── public/
│   ├── vote.html        Interface de vote (kiosque)
│   └── admin.html       Tableau de bord d'administration
└── README.md
```

Les fichiers `data/urne.json` (compteurs) et `data/state.json` (état du scrutin) sont
créés automatiquement à l'exécution.

## Périmètre

Ce dépôt couvre la partie logicielle : interface de vote, administration et serveur
central. L'authentification par carte RFID, la pseudonymisation cryptographique, le
transport TLS épinglé et la liaison série relèvent du firmware embarqué et ne font pas
partie de ce prototype logiciel.
