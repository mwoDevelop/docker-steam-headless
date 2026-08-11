# Kontrola wirtualnej gry GitHub Pages (starszy tryb akcji GitHub)

W tym udostępnieniu starszego przepływu akcji z ustawieniami do GitHub, który używa tokenu GitHub w zasilaniu.

W przypadku konfiguracji z logowaniem Google i bazy Cloud Run urządzenia [Cloud Run VM Control](./cloud-run-vm-control.md).

W repozytorium znajduje się teraz statyczny panel sterowania w [`docs/vm-control/`](./vm-control/index.html) i pasujący przepływ pracy GitHub Actions w [`.github/workflows/vm-control.yml`](../.github/workflows/vm-control.yml).

Strona nie komunikuje się bezpośrednio z GCP. Zamiast:

1. przeglądarka internetowa GitHub Actions API z tokenem GitHub,
2. GitHub Actions uwierzytelnia się w Google Cloud za pomocą sekretu repozytorium,
3. przepływ pracy uruchamiający `status`, `start`, `stop` lub `restart` na jednej maszynie wirtualnej GCE.

## Co kontrola

Ta dotyczy **przepływu GCE z jedną maszyną wirtualną** w [`gcp-vm/`](../gcp-vm/).

**Nie** kontroluje cykle życia klastra `gcp-v8s` GKE.

## Wymagana repozytorium

Ustaw te **zmienne repozytorium** w GitHub:

- `GCP_PROJECT` – usunięte projekt Google Cloud
- `GCP_ZONE` – docelowa strefa VM, np. `europe-central2-b`
- `GCE_NAME` – nazwa maszyny wirtualnej, np. `steam`

Ustaw dziesięć **tajnego repozytorium** w GitHub:

- `GCP_SA_KEY` – pełny klucz JSON dla kont usług Google Cloud

Zalecana minimalna konfiguracja systemu GitHub:

- pozostałości pozostałości pracy jako `vm-control.yml`
- zachowaj domyślną substancję w utrzymaniu strony zgodną z domyślną gałęzią

## Konto usług Google Cloud

Przepływ pracy wymaga kont usług, które mogą wyłączyć i wyłączyć maszynę wirtualną.

Najprostsza opcja:

- przyznaj konto usługi `Compute Instance Admin (v1)` w aplikacji lub na konkretnej maszynie wirtualnej

Jeśli chcesz zastosować bardziej szczegółowe rozwiązanie, utwórz niestandardową wersję zawierającą co najmniejsze:

- `compute.instances.get`
- `compute.instances.start`
- `compute.instances.stop`
- `compute.instances.reset`
- wymagane do odczytu operacji obliczeniowych

## Włącz strony GitHub

Strona statyczna znajduje się w `docs/`, więc prosta strona jest następująca:

1. Otwórz repozytorium `Settings -> Pages`
2. Ustaw `Source` na `Deploy from a branch`
3. Wybierz domyślną funkcję
4. Wybierz folder `/docs`
5. Zapisz

Po podłączeniu panelu Pages będzie dostępny pod adresem:

- `https://<owner>.github.io/<repo>/vm-control/`

## Token GitHub dla ustawień

Strona wymaga tokena GitHub, ponieważ strony GitHub są statyczne i nie mają zaplecza.

Zalecany token:

- drobnoziarnisty token dostępu osobistego
- dostęp do repozytorium niskiego do tego repozytorium
- pozwolenie:
- `Actions: Read and write`
- `Contents: Read-only`

Nie koduj tokena na stałe na stronie. Wpisz go w formularzu podczas korzystania z panelu.

Domyślnie strona przechowuje token tylko w pamięci sesji. Jeśli włączysz `Remember token on this device`, zostaniesz przeniesiony do pamięci na tym komputerze.

## Jak urzędowy

1. Otwórz adres URL stron
2. Wypełnij:
- Token GitHuba
- właściciel
- repozytorium
- oddział/ref
- nazwa pliku roboczego, zwykle `vm-control.yml`
3. możliwe puste pole GCP, jeśli zmienne repozytorium są już gotowe
4. zużycie `Start`, `Stop`, `Restart` lub `Status`

Panel wyświetlający końcowy przebieg wyłączenia i wyodrębniony:

- końcowy stan zasilania maszyny wirtualnej
- zewnętrzne IP
- pokaż łącza dostępowe dla noVNC i Sunshine, gdy maszyna wirtualna jest uruchomiona
- oznaczenia dotyczące hosta/adresu IP dla klientów Moonlight, Sunshine i Steam Remote Play
- nieudany etap zakończenia pracy, gdy ostatnie wydanie nie nastąpi pomyślnie

## Notatki

- Przycisk `Status` nie dotyczy GCP z ustawieniami. Uruchamia ten sam przepływ pracy w tylko do odczytu.
- Jeśli domyślna zostanie dodana repozytorium do `main`, zmień pole strony z `master` na `main`.
- Jeśli chcesz kontrolować inną maszynę wirtualną, zastosuj opcję zastąpienia projektu/strefy/instancji przed wystąpieniem działania.
