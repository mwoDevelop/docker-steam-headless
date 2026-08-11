# Kontrola maszyny wirtualnej Cloud Run

Ta konfiguracja zastępuje przepływ PAT przechowywany w przeglądarce GitHub:

1. statyczny frontend na GitHub Pages,
2. logowanie Google w przeglądarce,
3. API Cloud Run, które bezpośrednio kontroluje maszynę wirtualną GCE.

W tym trybie przeglądarka nigdy nie potrzebuje tokena GitHub.

## Architektura

- GitHub Pages obsługuje interfejs użytkownika z `docs/vm-control/`
- Usługi tożsamości Google logują użytkownika
- przeglądarka wysyła token Google ID do backendu
- Cloud Run weryfikuje token i sprawdza listę dozwolonych
- Cloud Run używa konta usługi wykonawczej do kontrolowania maszyny wirtualnej

## Pliki

- Frontend: [`docs/vm-control/`](./vm-control/index.html)
- Zaplecze: [`cloud-run-vm-control/`](../cloud-run-vm-control/app.py)
- Wdróż skrypt: [`cloud-run-vm-control/deploy.sh`](../cloud-run-vm-control/deploy.sh)

## Co kontroluje backend

Zaplecze zarządza zarejestrowanymi punktami końcowymi maszyn wirtualnych, a nie jedną stałą maszyną wirtualną. Każdy
punkt końcowy ma hosta DuckDNS i można mu przypisać profil maszyny wirtualnej zdefiniowany przez
sprzęt i strefa. Panel administratora udostępnia akcje cyklu życia,
kopie zapasowe, zarządzanie punktami końcowymi/IP, skanowanie wydajności GPU, wybór obrazu w czasie wykonywania,
Dane uwierzytelniające Sunshine, instalacja aplikacji, zarządzanie Minecraftem i
dowód zgodności.

Zwykła strona kontroli maszyny wirtualnej jest celowo przeznaczona tylko do odczytu, z wyjątkiem dostępu na żywo
spinki do mankietów. Administracja wymaga konta Google znajdującego się na liście dozwolonych; uprzywilejowany
Dostęp do Minecrafta można przyznać osobno dla każdego użytkownika.

Aktualnie wybrany punkt końcowy określa każde żądanie cyklu życia. Tworzenie
lub uruchomienie maszyny wirtualnej sprawdza również, czy inna zarządzana maszyna wirtualna nie jest już uruchomiona,
ponieważ w przeciwnym razie porty świadczące usługi publiczne powodowałyby konflikt.

## Wymagana konfiguracja Google Cloud

### 1. Utwórz identyfikator klienta Google OAuth

Utwórz **aplikację internetową** klienta OAuth w Google Cloud Console.

Ustaw **Autoryzowane źródła JavaScript** tak, aby zawierało co najmniej:

- `https://mwodevelop.github.io`

Jeśli hostujesz stronę w innym miejscu, dodaj także to źródło.

Zapisz wygenerowany **ID klienta**. Frontend tego potrzebuje, a backend weryfikuje pod tym kątem tokeny.

### 2. Wybierz, kto może kontrolować maszynę wirtualną

Ustaw jedno z:

- `ALLOWED_GOOGLE_EMAILS`
- `ALLOWED_GOOGLE_DOMAINS`

Przykłady:

- `ALLOWED_GOOGLE_EMAILS=mwodevelop@gmail.com`
- `ALLOWED_GOOGLE_DOMAINS=example.com`

### 3. Wdróż backend

Skrypt wdrażania ładuje `gcp-vm/.env` i `gcp-vm/.env.secrets`, a następnie wdraża publiczną usługę Cloud Run chronioną logowaniem Google w warstwie aplikacji.

Przykład:

```bash
cd /path/to/docker-steam-headless

GOOGLE_CLIENT_ID="1234567890-abc123def456.apps.googleusercontent.com" \
ALLOWED_GOOGLE_EMAILS="mwodevelop@gmail.com" \
ALLOWED_ORIGINS="https://mwodevelop.github.io" \
./cloud-run-vm-control/deploy.sh
```

Co robi skrypt:

- włącza wymagane API
- w razie potrzeby tworzy dedykowane konto usługi wykonawczej
- przyznaje `roles/compute.instanceAdmin.v1` i minimalną rolę w projekcie dla krótkotrwałych rezerwacji mocy GPU
- przechowuje `DUCKDNS_TOKEN` w Secret Managerze, jeśli jest obecny lokalnie
- wdraża usługę Cloud Run ze źródła

Po wdrożeniu drukuje adres URL zaplecza.

## Korzystanie ze strony

1. Otwórz:
- `https://mwodevelop.github.io/docker-steam-headless/vm-control/`
2. Wklej raz adres URL backendu Cloud Run
3. Kliknij `Connect API`
4. Zaloguj się za pomocą Google
5. Otwórz **Administracja** dla cyklu życia maszyny wirtualnej i operacji oprogramowania
6. Użyj opcji **Kontrola maszyny wirtualnej**, aby wybrać punkt końcowy, profil sprzętowy i strefę

Panel administratora to także miejsce, w którym sprawdzana jest pojemność procesora graficznego przed utworzeniem,
i gdzie wyniki zgodności są rejestrowane po prawdziwym teście Sunshine.

Strona przechowuje:

- URL backendu w `localStorage`
- krótkotrwały token sesji Google w `sessionStorage`
- lokalna historia akcji w `localStorage`

Nie przechowuje żadnego tokena GitHub.

## Zmienne środowiskowe środowiska wykonawczego

W backendzie czytamy:

- `GCP_PROJECT`
- `GCP_ZONE`
- `GCE_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_IDS`
- `ALLOWED_GOOGLE_EMAILS`
- `ALLOWED_GOOGLE_DOMAINS`
- `ALLOWED_ORIGINS`
- `DUCKDNS_DOMAINS`
- `DUCKDNS_TOKEN`
- `VM_NOVNC_PORT`
- `VM_SUNSHINE_PORT`

## Notatki

- Ten tryb dotyczy przepływu GCE `gcp-vm`, a nie `gcp-v8s`.
- Usługa Cloud Run jest publiczna, ale kontrolne punkty końcowe wymagają ważnego tokena identyfikatora Google z dozwolonego konta.
- CORS jest ograniczony przez `ALLOWED_ORIGINS`, ale prawdziwa autoryzacja jest wymuszana przez weryfikację tokena i listę dozwolonych.
- Jeśli maszyna wirtualna zmieni publiczny adres IP przy uruchomieniu, DuckDNS może zachować aktualną nazwę hosta DNS bez rezerwowania statycznego adresu IP.
