# gcp-v8s

Konfiguracja i skrypty do uruchomienia `steam-headless` na GKE ze wsparciem GPU.

## Co tworzy `deploy.sh`

- klaster GKE Standard (`steam-gpu-k8s`)
- node pool GPU (`gpu-pool`) z konfigurowalnym GPU (`GPU_TYPE`)
- namespace `steam-headless`
- `Deployment` `steam-headless` z limitem `nvidia.com/gpu: 1`
- 2 usługi `LoadBalancer`:
  - `steam-headless-web` (noVNC 8083, Sunshine UI 47990, parowanie 47984, Sunshine TCP stream)
  - `steam-headless-stream-udp` (porty UDP streamingu Sunshine)
- wspólny statyczny adres publiczny dla obu usług

## Szybki start

```bash
cd gcp-v8s
./build-image.sh
./deploy.sh --profile L4
```

Wymagany jest jawny wybór profilu:

```bash
./deploy.sh --profile L4
./deploy.sh --profile T4
```

`--profile` jest obsługiwane tylko przez `deploy.sh`.
Pozostałe skrypty używają aktywnego profilu zapisanego po `deploy.sh`.

## Profil L4 + sharing

`nvidia-l4` nie jest dostępne w `europe-central2-b`.

```bash
cd gcp-v8s
./deploy.sh --profile L4
./build-image.sh
```

Profil `profiles/l4.env`:
- ustawia `GKE_LOCATION=europe-west4-b`
- ustawia `GPU_TYPE=nvidia-l4`
- włącza `GPU_SHARING_STRATEGY=time-sharing`
- ustawia `GPU_MAX_SHARED_CLIENTS_PER_GPU=4`
- ustawia `DEPLOY_DEFAULT_WORKLOAD=false` (pod multi-instance)

Profil `profiles/t4.env`:
- ustawia `GKE_LOCATION=europe-central2-b`
- ustawia `GPU_TYPE=nvidia-tesla-t4`
- włącza `GPU_SHARING_STRATEGY=time-sharing`
- ustawia `GPU_MAX_SHARED_CLIENTS_PER_GPU=4`
- ustawia `DEPLOY_DEFAULT_WORKLOAD=true`

Sprawdzenie:

```bash
./status.sh
```

Usunięcie klastra utworzonego przez ten katalog:

```bash
./destroy.sh
```

`destroy.sh` czyści zasoby powiązane z tym setupem:
- klastry o nazwach pasujących do `steam-gpu-k8s*` oraz `kub-free`
- namespace `steam-headless` i namespace fleet (`app.kubernetes.io/part-of=steam-headless-fleet`)
- statyczne IP o nazwach `steam-headless-*`

Opcjonalne usunięcie starego klastra `kub-free`:

```bash
./cleanup-kub-free.sh
```

## Konfiguracja

- Skrypty zawsze czytają wspólne `./.env`.
- Potem automatycznie dociągają profil z `./profiles/<profil>.env`.
- Profil możesz nadpisać parametrem `--profile` tylko w `deploy.sh`.
- `deploy.sh` zapisuje aktywny profil do `./.active-profile`.
- Pozostałe skrypty używają `./.active-profile`.
- Bez `./.active-profile` skrypty zgłoszą błąd (najpierw uruchom `deploy.sh --profile ...`).
- `./.env` jest lokalny (gitignored). Wzorzec: `./.env.example`.
- Startowo skopiuj: `cp .env.example .env`.
- Nie używamy już `.env.local` — cała konfiguracja jest w jednym pliku `.env`.
- Wersjonowane profile `.env` (np. `profiles/l4.env`, `profiles/t4.env`) zawierają tylko ustawienia profilu GPU.

## Multi-instance `steam-headless`

Model zarządzania:
- każda instancja ma osobny namespace
- każda instancja ma własny statyczny IP
- wszystkie instancje używają tych samych portów (8083/47990/…)
- dostęp jest kontrolowany przez `SOURCE_RANGES` (`loadBalancerSourceRanges`)

Skrypty:
- `deploy-instance.sh <instance-id>` – tworzy pojedynczą instancję
- `list-instances.sh` – lista instancji i endpointów
- `destroy-instance.sh <instance-id> [release-ip]` – usuwa instancję
- `sync-duckdns.sh` – synchronizuje rekordy DuckDNS dla wszystkich instancji
- `deploy-gamers.sh --profile <L4|T4|...> --gamers <0..5>` – deploy + autoskalowanie `gamer1..gamer5` + status

Przykład (L4 + sharing, 2 instancje):

```bash
cd gcp-v8s
./deploy.sh --profile L4
./deploy-instance.sh gamer1
./deploy-instance.sh gamer2
./list-instances.sh
```

Wrapper dla zarządzania liczbą instancji graczy:

```bash
./deploy-gamers.sh --profile T4 --gamers 3
./deploy-gamers.sh --profile T4 --gamers 1
./deploy-gamers.sh --profile T4 --gamers 0
```

## DuckDNS dla instancji

Dla każdej instancji skrypt tworzy domenę:
- `<DUCKDNS_BASE_DOMAIN><DUCKDNS_SUFFIX_SEPARATOR><instance-id>.duckdns.org`

Przykład:
- `DUCKDNS_BASE_DOMAIN=my-steam-domain`
- `DUCKDNS_SUFFIX_SEPARATOR=-`
- instancja `gamer1`
- domena: `my-steam-domain-gamer1.duckdns.org`

Włączenie (lokalnie w `.env`):
- ustaw `DUCKDNS_ENABLED=true`
- ustaw `DUCKDNS_BASE_DOMAIN=<twoja-domena>`
- ustaw `DUCKDNS_TOKEN=<token>`
- tryb multi-domain: `DUCKDNS_PER_INSTANCE=true` (domyślnie)
- tryb single-domain: `DUCKDNS_PER_INSTANCE=false` (wszyscy używają `DUCKDNS_BASE_DOMAIN.duckdns.org`)
- fallback (gdy domena per-instancja nie istnieje): `DUCKDNS_FALLBACK_TO_BASE=true` (domyślnie)
- użyj `deploy-instance.sh`

Ręczna synchronizacja wszystkich rekordów:

```bash
./sync-duckdns.sh
```

## Trwała instalacja Prism

- Prism jest instalowany na etapie budowania custom image w `gcp-v8s/image/Dockerfile`.
- Build/push do Artifact Registry robi `gcp-v8s/build-image.sh`.
- `deploy.sh` wdraża obraz z `IMAGE` z `gcp-v8s/.env`.
