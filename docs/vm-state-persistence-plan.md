# Plan trwałości stanu maszyny wirtualnej

## Cel

Zachowaj stan niezbędny do odbudowania maszyny wirtualnej Steam od zera, w tym:

- Stan logowania/sesji Steam
- Stan parowania/uwierzytelniania Sunshine
- Konfiguracja słoneczna
- stan aplikacji na poziomie użytkownika w domu kontenera
- zainstalowałem pliki gry w katalogu `/mnt/games`

Wynik docelowy:

1. maszynę wirtualną można całkowicie zniszczyć i odtworzyć,
2. wymagany stan jest przywracany automatycznie podczas ładowania początkowego,
3. Dysk Google pod adresem `mwodevelop@gmail.com` to jedyne zapasowe źródło prawdy,
4. sekrety nie trafiają do gita,
5. Normalne „Stop” i „Uruchom ponownie” działają dość szybko.

## Decyzje potwierdzone

1. Dysk Google służy do synchronizacji kopii zapasowych i przywracania, a nie jako główny system plików montowany na żywo.
2. Należy zachować pełne drzewo główne Steam Headless.
3. `/mnt/games` musi także przetrwać pełną przebudowę.
4. Kopia zapasowa/synchronizacja powinna nastąpić automatycznie.
5. Opcja „Usuń” musi wymagać potwierdzenia przez operatora przed utworzeniem kopii zapasowej i zniszczeniem.
6. Dane uwierzytelniające Dysku Google mogą być przechowywane w Secret Managerze.
7. Panel sterowania musi udostępniać opcje „Utwórz” i „Usuń”, z możliwością włączenia na podstawie stanu maszyny wirtualnej.
8. Miejsce na Dysku Google jest przypięte do konta głównego `mwodevelop@gmail.com`; inne dozwolone konta Google służą wyłącznie do logowania się do panelu.
9. `/home` i `/mnt/games` nie powinny używać tej samej metody utrwalania.
10. Układ pamięci masowej maszyny wirtualnej powinien wykorzystywać jeden współdzielony dysk danych dla `/opt/container-data/steam-headless/home` i `/mnt/games` oraz normalny dysk startowy.
11. „Utwórz” i „Usuń” muszą zarządzać pełnym cyklem życia tego współdzielonego dysku z danymi; Dysk pozostaje źródłem prawdy, a nie odłączonym dyskiem pozostawionym po operacji „Usuń”.

## Obecny stan

Obecne wdrożenie przechowuje już kontener Steam Headless na hoście maszyny wirtualnej w lokalizacji:

- ścieżka hosta: `/opt/container-data/steam-headless/home`
- ścieżka kontenera: `/home/default`

Biblioteka gier znajduje się pod:

- `/mnt/gry`

Bieżąca ścieżka startowa:

- Metadane maszyny wirtualnej zapewniają `steam-headless-env`
- skrypt startowy zapisuje `/opt/container-services/steam-headless/.env`
- docker compose montuje `${HOME_DIR}` do `/home/default`

Obecne zachowanie trwałości działa już w przypadku „/home” poprzez proces tworzenia kopii zapasowych/przywracania po stronie hosta powiązany z Dyskiem Google.

Aktualna uwaga dotycząca wdrożenia:

- istniejąca implementacja nie definiuje jeszcze opisanego poniżej cyklu życia współdzielonego dysku z danymi,
- zatem plan ten obejmuje zarówno zmianę układu przechowywania, jak i zmianę przepływu trwałości.

## Ustalenia odkrycia

Kontrola działającej maszyny wirtualnej wykazała:

- Stan Sunshine znajduje się pod `/opt/container-data/steam-headless/home/.config/sunshine`
- kluczowe pliki Sunshine obejmują:
  - `apps.json`
  - `credentials/cacert.pem`
  - `credentials/cakey.pem`
  - `sunshine.conf`
  - `sunshine_state.json`
- Stan Steam znajduje się w `/opt/container-data/steam-headless/home/.steam`
- kluczowe pliki Steam obejmują:
  - `.steam/steam/config/loginusers.vdf`
  - `.steam/steam/config/config.vdf`
  - `.steam/steam.token`

To oznacza:

- `/home` to właściwa granica odzyskiwania dla autoryzacji/sesji Steam i parowania/konfiguracji Sunshine,
- `/mnt/games` jest oddzielny i należy go traktować jako zainstalowaną zawartość, a nie lekki stan wykonawczy,
- konfiguracja bootstrap i sekrety muszą zostać przywrócone niezależnie od `/home`.

## Kierunek projektowania

### `/dom`

Zachowaj bieżącą lekką ścieżkę kopii zapasowej:

- przywróć przy rozruchu „Utwórz” / świeżo-utwórz
- wykonaj kopię zapasową przy poleceniach „Stop”, „Uruchom ponownie” i „Usuń”.

Rozumowanie:- zawiera stan uwierzytelnienia/konfiguracji, którego faktycznie często potrzebujemy,
- jest stosunkowo niewielki,
- dopuszczalne jest częste tworzenie kopii zapasowych.

### `/mnt/gry`

Nie przechowuj `/mnt/games` w tej samej ścieżce synchronizacji na poziomie katalogu, co `/home`.

Zamiast tego:

- archiwizuj `/mnt/games` tylko podczas `Delete`,
- przywróć to archiwum tylko podczas rozruchu typu `Create` / Fresh-create,
- nie twórz kopii zapasowej `/mnt/games` podczas `Stop` lub `Restart`.

Rozumowanie:

- biblioteki gier są duże,
- częsta synchronizacja jest zbyt wolna i zaszumiona,
— Dysk jest akceptowalny jako chłodnia dla zainstalowanej zawartości, a nie jako częsta synchronizacja operacyjna.

## Zalecana architektura

### Czas działania

- dysk startowy dla systemu operacyjnego, Dockera, skryptów startowych i środowiska wykonawczego hosta tymczasowego
- jeden współdzielony dysk z danymi stanu aplikacji
- `/opt/container-data/steam-headless/home` przechowywany na współdzielonym dysku z danymi
- `/mnt/games` przechowywane na tym samym współdzielonym dysku z danymi
- przywróć bramkowanie w oparciu o wyraźny zamiar świeżego tworzenia, a nie każdy zwykły rozruch

### Układ dysku maszyny wirtualnej

Maszyna wirtualna powinna mieć łącznie 2 dyski:

1. dysk rozruchowy
   - system operacyjny
   - Silnik Dockera i pakiety
   - narzędzia do uruchamiania/zamykania/trwałości
   - przejściowe lokalne środowisko wykonawcze komputera
2. dysk z danymi
   - montowany na początku bagażnika
   - zawiera oba:
     - `/opt/container-data/steam-headless/home`
     - `/mnt/gry`

Cykl życia:

- „Utwórz” tworzy i dołącza nowy, współdzielony dysk z danymi
- pierwszy rozruch formatuje go w razie potrzeby i montuje deterministycznie
- Opcja „Usuń” usuwa maszynę wirtualną i jej współdzielony dysk z danymi dopiero po pomyślnym wykonaniu kopii zapasowej
- źródłem odzyskiwania pozostaje Dysk Google, a nie usunięty dysk

Rozumowanie:

- prostsze zaopatrzenie niż osobne dyski dla domu i gier,
- mniej ruchomych części podczas `Tworzenia`,
- obie ścieżki reprezentują stan aplikacji, a nie stan systemu bazowego,
- zasady tworzenia kopii zapasowych mogą nadal różnić się w zależności od katalogu, nawet jeśli oba znajdują się na tym samym dysku z danymi.

### Magazyn kopii zapasowych

Dysk Google zakorzeniony na głównym koncie `mwodevelop@gmail.com`.

Proponowany układ:

- `steam-vm-state/home/home.tar.zst`
- `steam-vm-state/home/manifest.json`
- `steam-vm-state/games/archives/<znacznik czasu>.tar.zst`
- `steam-vm-state/games/current.json`
- `steam-vm-state/games/manifests/<timestamp>.json`
- `stan-VM Steam/manifest.json`
- `stan-VM/wersja.txt`

## Zakres danych do zachowania

### Częsty zakres kopii zapasowych

- pełne `/opt/container-data/steam-headless/home`

### Zakres archiwum tylko do usuwania

- pełne `/mnt/games`

### Konfiguracja środowiska wykonawczego z możliwością odbudowania

- `/opt/container-services/steam-headless/.env`
- wygenerowane metadane startowe
- pliki tymczasowe/pamięci podręcznej poza utrwalonymi obszarami
- podłączenie dysku i konfiguracja montażu, która powinna zostać odtworzona w sposób deterministyczny podczas „Utwórz”.
- utworzenie systemu plików na pustym dysku współdzielonym z danymi, który powinien być zautomatyzowany i idempotentny

## Proponowany plan wdrożenia

### Faza 1: Udoskonalenie strategii przechowywania1. Zachowaj istniejącą ścieżkę kopii zapasowej `/home` w niezmienionej postaci.
2. Usuń `/mnt/games` ze ścieżki częstej synchronizacji.
3. Wyraźnie określ model dysku maszyny wirtualnej:
   - `dysk startowy` dla systemu/środowiska wykonawczego
   - jeden współdzielony „dysk z danymi” zamontowany dla obu utrwalonych ścieżek stanu aplikacji
4. Zdefiniuj strategię montowania dla udostępnionego dysku z danymi, na przykład:
   - zamontuj dysk w stabilnym katalogu głównym, takim jak `/mnt/state`
   - mocowanie powiązania lub dowiązanie symboliczne:
     - `/mnt/state/home` -> `/opt/container-data/steam-headless/home`
     - `/mnt/stan/gry` -> `/mnt/gry`
   - lub montuj poszczególne podkatalogi w inny deterministyczny sposób
5. Zdefiniuj reguły cyklu życia współdzielonego dysku z danymi:
   - `Utwórz` tworzy nowy pusty dysk o skonfigurowanym rozmiarze/typu
   - startup formatuje dysk tylko wtedy, gdy nie istnieje jeszcze żaden system plików
   - startup montuje go poprzez stabilną tożsamość urządzenia, taką jak UUID, a nie niestabilną nazwę urządzenia
   - `Usuń` usuwa dysk razem z maszyną wirtualną po pomyślnym wykonaniu kopii zapasowej
6. Ustaw układ `/home` jako przejrzysty i stabilny:
   - `steam-vm-state/home/home.tar.zst`
   - `steam-vm-state/home/manifest.json`
   - zachowaj zgodność z obecną implementacją, chyba że migracja jest wyraźnie potrzebna
7. Zdefiniuj dedykowany układ archiwum gier na Dysku:
   - niezmienny obiekt archiwum: `steam-vm-state/games/archives/<timestamp>.tar.zst`
   - niezmienny manifest archiwum: `steam-vm-state/games/manifests/<timestamp>.json`
   - bieżący wskaźnik: `steam-vm-state/games/current.json`
8. Zdefiniuj zawartość manifestu dla kopii zapasowej `/home`:
   - znacznik czasu
   - ścieżka obiektu archiwum
   - ścieżka źródłowa
   - wersja formatu kopii zapasowej
9. Zdefiniuj zawartość manifestu dla archiwum gier:
   - znacznik czasu
   - ścieżka obiektu archiwum
   - ścieżka źródłowa
   - format kompresji
   - przybliżony rozmiar
   - przywróć wersję formatu
   - znacznik sukcesu / status publikacji
10. Zdefiniuj politykę przechowywania niezmiennych archiwów:
   - minimum: zachowaj najnowsze opublikowane archiwum
   - opcjonalnie: zachowaj ostatnie `N` archiwów do wycofania/debugowania

Możliwość dostarczenia:

- ostateczny układ dysku dla podzielonej trwałości

### Faza 2: Zmiany w narzędziach tworzenia kopii zapasowych/przywracania1. Rozszerz `gcp-vm/persist-state.sh` o osobne ścieżki kodu:
   - Kopia zapasowa/przywracanie `/home`
   - Archiwizacja/przywracanie `/mnt/games`
2. Dodaj pomocników, aby upewnić się, że udostępniony dysk z danymi jest zamontowany i że istnieją oczekiwane katalogi przed rozpoczęciem tworzenia kopii zapasowej lub przywracania.
3. Dodaj pomocników do:
   - wykryć, czy współdzielony dysk z danymi ma już system plików,
   - utwórz system plików tylko przy pierwszym uruchomieniu,
   - zamontuj za pomocą UUID lub równoważnego stabilnego identyfikatora.
4. Zaimplementuj archiwum `/mnt/games` jako strumień, a nie tymczasowy lokalny plik tar:
   - kopia zapasowa: `tar -C /mnt -cf - gry | zstd | rclone rcat .../archives/<znacznik czasu>.tar.zst`
   - przywróć: `rclone cat .../archives/<timestamp>.tar.zst | zstd -d | tar -C /mnt -xf -`
5. Upewnij się, że Steam/obciążenie zostało wyłączone przed utworzeniem kopii zapasowej `/home` i przed utworzeniem archiwum gier.
6. Zachowaj własność, uprawnienia i oczekiwania dotyczące punktów montowania po przywróceniu.
7. Odmów przywracania, jeśli `/mnt/games` nie jest pusty, chyba że przepływ jest jawnie w trybie świeżego tworzenia.
8. Publikuj kopie zapasowe gier transakcyjnie:
   - prześlij archiwum na niezmienną ścieżkę ze znacznikiem czasu,
   - napisz manifest ze znacznikiem czasu,
   - zaktualizuj `current.json` dopiero wtedy, gdy oba działania się powiodą.
9. Przywróć gry poprzez katalog pomostowy, na przykład:
   - wyodrębnij do `/mnt/games.restore.<token>`
   - sprawdzić skuteczność ekstrakcji
   - zastąp katalog docelowy atomowo, o ile pozwala na to system plików
   - dopiero wtedy ujawnij przywrócone drzewo jako `/mnt/games`
10. Jeśli kopia zapasowa `Usuń` nie powiedzie się po ustaniu obciążenia:
   - nie usuwaj VM,
   - na powierzchni wyraźny stan awaryjny,
   - pozostawić operatora z możliwym do odzyskania stanem maszyny,
   - opcjonalnie zrestartuj stos, jeśli wycofanie jest bezpieczne.

Możliwość dostarczenia:

- skrypt dzielonego tworzenia kopii zapasowych/przywracania wielokrotnego użytku

### Faza 3: Integracja Bootstrap z maszyną wirtualną

1. Zaktualizuj przebieg uruchamiania, aby przywracanie było kontrolowane przez wyraźną intencję świeżego utworzenia.
2. Preferowany mechanizm:
   - Cloud Run „Utwórz” zapisuje znacznik metadanych, taki jak „vm-restore-mode=create”
   - startup zużywa go dokładnie raz
   - uruchamianie usuwa go po pomyślnym przywróceniu lub po kontrolowanej ścieżce bez kopii zapasowej
3. Sondowanie stanu pustego można stosować wyłącznie w celu sprawdzenia bezpieczeństwa, a nie jako głównego wyzwalacza.
4. Przed rozpoczęciem przywracania upewnij się, że udostępniony dysk z danymi jest podłączony, zamontowany i przygotowany.
5. Jeśli udostępniony dysk z danymi jest pusty:
   - utwórz system plików,
   - utwórz oczekiwany układ katalogów,
   - następnie uruchom przywracanie.
6. Przywróć `/home` przed `docker compose up -d` tylko wtedy, gdy bramka przywracania jest otwarta.
7. Przywróć archiwum `/mnt/games` przed `docker compose up -d` tylko wtedy, gdy bramka przywracania jest otwarta i istnieje prawidłowy plik `current.json`.
8. Pomiń przywracanie gier w sposób czysty, jeśli nie istnieje żadne archiwum.
9. Wyczyść bramkę przywracania po pomyślnym pierwszym uruchomieniu, aby kolejne cykle `Stop`/`Start` nie powodowały ponownego importowania stanu.
10. Bezpieczne niepowodzenie, jeśli archiwum gier jest uszkodzone:
   - zaznacz stan przywracania,
   - pozostaw maszynę wirtualną bootowalną,
   - nie uruchamiaj stosu aplikacji na częściowo przywróconym pliku `/mnt/games`.
11. Zachowaj idempotentny bootstrap.

Możliwość dostarczenia:

- ścieżka startowa z automatycznym przywracaniem gier

### Faza 4: Integracja akcji mocy1. Zachowaj istniejące zachowanie dla `/home`:
   - `Stop` -> kopia zapasowa `/home`
   - `Uruchom ponownie` -> kopia zapasowa `/home`
   - `Usuń` -> kopia zapasowa `/home`
2. Dodaj zachowanie archiwum gier tylko do opcji „Usuń”:
   - wyciszyć obciążenie pracą
   - wykonaj kopię zapasową `/home`
   - archiwum `/mnt/games`
   - opublikuj `current.json`
   - usuń maszynę wirtualną dopiero po pomyślnym wykonaniu obu operacji
3. Zachowaj opcję „Utwórz” automatycznie:
   - jeśli istnieje kopia zapasowa `/home`, przywróć ją
   - jeśli archiwum gier istnieje, przywróć je
   - w przeciwnym razie kontynuuj w stanie pustym
4. W przypadku niepowodzenia „Usuń” po rozpoczęciu tworzenia kopii zapasowej:
   - zwróć wynik nieudanego polecenia,
   - nie usuwaj instancji,
   - zachować wystarczający status, aby operator mógł ponowić próbę lub sprawdzić.
5. Po pomyślnym „Usuń”:
   - usuń maszynę wirtualną,
   - usuń udostępniony dysk z danymi,
   - Zachowaj artefakty Dysku jako jedyne źródło odzyskiwania.

Możliwość dostarczenia:

- semantyka płaszczyzny kontrolnej dostosowana do nowego podziału

### Faza 5: Zmiany w backendie i GUI

1. Zaktualizuj ładunek stanu API Cloud Run, aby udostępnić bezpieczne metadane trwałe:
   - czas ostatniej kopii zapasowej `/home`
   - czas archiwizacji ostatnich gier
   - czy istnieje archiwum gier
   - czy najnowsze archiwum gier jest opublikowane i możliwe do przywrócenia
   - czy ostatnie przywracanie powiodło się, czy nie
   - czy obecnie oczekuje na przywrócenie, ponieważ instancja została świeżo utworzona
   - czy udostępniony dysk z danymi jest podłączony i zamontowany zgodnie z oczekiwaniami
2. Zaktualizuj komunikaty GUI, aby operatorzy zrozumieli:
   - `Stop` i `Restart` zapisują stan tylko dla `/home`
   - `Usuń` wykonuje pełną kopię zapasową, łącznie z zainstalowanymi grami
3. Zachowaj wyraźne potwierdzenie „Usuń”, ponieważ może to wymagać długiego etapu archiwizacji.
4. Pokaż postęp ścieżki destrukcyjnej na ogólnym poziomie:
   - łagodzenie obciążenia pracą
   - powrót do domu
   - archiwizacja gier
   - usunięcie maszyny wirtualnej
5. Wyświetl wskazówki dotyczące nieudanego usunięcia, jeśli faza tworzenia kopii zapasowej/archiwizacji nie powiodła się, a maszyna wirtualna została celowo zachowana.

Możliwość dostarczenia:

- status trwałości widoczny dla operatora

### Faza 6: Walidacja

Matryca testowa:

1. Zalogowany Steam -> kopia zapasowa -> zniszcz VM -> odtwórz VM -> przywróć -> potwierdź, że sesja Steam przetrwa.
2. Sunshine sparowany z klientem -> kopia zapasowa -> zniszcz maszynę wirtualną -> odtwórz maszynę wirtualną -> przywróć -> potwierdź, że parowanie przetrwało.
3. Drzewo katalogów zainstalowanych gier znajduje się w `/mnt/games` -> `Usuń` -> `Utwórz` -> potwierdź zwrócenie struktury katalogów.
4. Znana ścieżka zainstalowanej gry w `/mnt/games` powraca po przywróceniu.
5. Przywróć całkowicie pusty dysk rozruchowy.
6. Przywróć całkowicie pusty udostępniony dysk z danymi.
7. Przerwane przesyłanie nie powoduje przeniesienia pliku „current.json” do częściowego archiwum.
8. Brak archiwum gier nie blokuje uruchamiania.
9. Uszkodzone archiwum gier ulega awarii i pojawia się jasny status.
10. „Zatrzymaj” i „Uruchom ponownie” pozostają znacznie szybsze niż „Usuń”.
11. Zwykłe `Stop` -> `Start` na istniejącej maszynie wirtualnej nie powoduje pełnego przywrócenia `/home` lub `/mnt/games`.
12. Nieudane przywracanie do katalogu pomostowego nie powoduje zastąpienia wcześniej dobrego `/mnt/games`.
13. Odtworzona maszyna wirtualna poprawnie tworzy, podłącza, w razie potrzeby formatuje i montuje udostępniony dysk z danymi przed rozpoczęciem przywracania.
14. Pomyślne „Usuń” powoduje usunięcie udostępnionego dysku z danymi, zamiast pozostawiania osieroconej pamięci.

Możliwość dostarczenia:

- raport z odzyskiwania i testu cyklu życia

## Sugerowana kolejność pracy1. Zdefiniuj i zaimplementuj cykl życia współdzielonego dysku z danymi oraz układ montowania
2. Zrefaktoryzuj skrypt trwałości, aby podzielić `/home` i `/mnt/games`
3. Dodaj obsługę archiwum gier przesyłanych strumieniowo
4. Zintegruj przygotowanie dysku i przywracanie gier podczas uruchamiania
5. Dostosuj operację „Usuń”, aby uwzględnić archiwum gier i usunięcie dysku
6. Ujawnij status w zapleczu/interfejsie
7. Uruchom pełną weryfikację odzyskiwania `Usuń -> Utwórz`

## Ryzyko

- archiwizacja/przywracanie gier może zająć dużo czasu w przypadku większych bibliotek
- przerwane Opcja „Usuń” może pozostawić nieaktualne lub częściowe archiwum, jeśli zapisy nie są dokonywane w trybie transakcyjnym
- przywrócenie bardzo dużego archiwum wydłuży działanie „Utwórz”.
- W niektórych przypadkach zawartość Steam może nadal wymagać samodzielnej naprawy po przywróceniu
- Przepustowość/przydział dysku może stać się czynnikiem ograniczającym w przypadku dużych bibliotek
- przywracanie oparte na tar zachowuje pliki, ale nie tożsamość dysku na poziomie bloku; każde oprogramowanie oczekujące semantyki surowego obrazu dysku wymagałoby innego podejścia
- współdzielony dysk z danymi zwiększa promień działania w porównaniu z oddzielnymi dyskami stanu aplikacji, więc poprawność montażu i układu kopii zapasowych ma większe znaczenie
- jeśli identyfikacja dysku jest zaimplementowana niepoprawnie, nowa maszyna wirtualna może zamontować niewłaściwe urządzenie lub nie zamontować dysku z danymi; Montaż oparty na UUID jest zatem trudnym wymogiem

## Pierwszy zalecany następny krok

Zmodyfikuj bieżącą implementację trwałości, tak aby `/mnt/games` opuścił częstą ścieżkę synchronizacji i stał się archiwum przesyłanym strumieniowo, dostępnym tylko za pomocą opcji `Usuń`, z automatycznym przywracaniem w czasie `Utwórz`. Dzięki temu normalne działanie mocy jest szybkie i wyraźnie widać trwałość zainstalowanej gry.