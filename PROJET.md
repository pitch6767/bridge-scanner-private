# bridge-scanner — Livre 4 : Triangle Equities U/S/F + Carry xStocks

## Thèse
Chaque action US liquide existe en 3 versions qui se désynchronisent :
- **U** : action réelle (NYSE/Nasdaq, via IBKR) — observable uniquement pendant les heures de marché US
- **S** : token spot xStocks (Kraken / Solana), trade 24/7
- **F** : perp equity Hyperliquid HIP-3, trade 24/7, funding rate

Hors heures de marché, U est inobservable : S et F font la découverte de prix seuls.
C'est là que la basis S-F est la plus large (le perp mène, le token traîne).
À la réouverture, convergence historique < 1% d'écart.

## Deux moteurs
1. **Scanner triangle (paper d'abord)** : détecter les dislocations S-F nettes de frais,
   mesurer leur survie (anti-mirage), logger la convergence à chaque réouverture.
2. **Carry delta-neutre xStocks** : long spot xStock (venue spot à choisir : Bybit dispo API, Kraken pour xPoints) + short perp HL.
   Revenus = funding perp + lending yield + xPoints. Clone de la doctrine farm-scanner
   appliqué aux equities.

## Go/No-Go (Phase 1 → exécuteur)
- GO si : ≥3 dislocations nettes ≥1% par semaine sur l'univers
  ET taux de survie à 60s ≥ 50%
- NO-GO : sentinelle d'alerte uniquement.

## Règles de risque (carry, Phase 2)
- Max 20% du capital du livre par ticker
- Distance de liquidation perp ≥ 40%
- Rebalance si |delta net| > 5%
- Phase test : $2-3k total avant multiplication
- Risque émetteur (Backed/custodian) : jamais >50% du livre en xStocks au total

## Méthode de travail
- Claude pousse via token GitHub, Pitch déploie via bouton dashboard Replit
- JS validé par extraction du HTML rendu + `node --check`
- Agent Replit exclu de l'écriture de code
- Port dashboard : **8085**
- Persistance : state.json en écriture atomique (tmp + rename)

## Roadmap
- v1.1 : scanner S-F paper (Bybit spot xStocks + HL dex xyz), dashboard, télémétrie dislocations
- v2 : jambe U via IBKR pendant heures de marché, triangle complet
- v3 : compteurs carry (funding + points), positions paper
- v4 : exécuteur (si GO)

## À VÉRIFIER (config.json)
- Jambe S : Bybit spot (TSLAXUSDT, NVDAXUSDT, APPLXUSDT, MSTRXUSDT, COINXUSDT) — Kraken API publique = zéro xStock
- Jambe F : HL dex builder "xyz", coins xyz:TSLA etc. SPY/QQQ absents du dex
