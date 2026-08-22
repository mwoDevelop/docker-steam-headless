# Plan trwałości stanu wirtualnej

## Cel

Zachowaj stan przeznaczony do odbudowy wirtualnej maszyny Steam od zera, w tym:

- Stan logowania/sessji Steam
- Stan parowania/uwierzytelniania Sunshine
- Konfiguracja słoneczna
- stan aplikacji na poziomie użytkownika w domu kontenera
- zainstalowałem pliki gry w katalogu `/mnt/games`

Wynik usunięty:

1. maszynę wirtualną można zniszczyć i odtworzyć,
2. wymagany stan jest przywracany automatycznie podczas ładowania,
3. Dysk Google pod adresem `mwodevelop@gmail.com` do jedynego zapasowego źródła prawdy,
4. sekrety nie trafiają do gita,
5. Normalne „Stop” i „Uruchom ponownie” zawierają szybko.

## Decyzja rozstrzygająca

1. Dysk Google służy do synchronizacji kopii zapasowych i przywracania, a nie jako główny system plików podłączony na żywo.
2. Zawiera pełne drzewo główne Steam Headless.
3. `/mnt/games` musi także obejmować pełną przebudowę.
4. Kopia zapasowa/synchronizacja nastąpiła automatycznie.
5. Opcja „Usuń” musi wymagać potwierdzenia przez operatora przed kopią zapasową i zniszczeniem.
6. Dane uwierzytelniające Dysku Google mogą być wykorzystane w Secret Managerze.
7. Panel sterowania musi być opcją „Utwórz” i „Usuń”, z możliwością podłączenia do urządzenia wirtualnego.
8. Miejsce na Dysku Google jest przypięte do konta internetowego `mwodevelop@gmail.com`; inne konta Google, które są wyłącznie do logowania do panelu.
9. `/home` i `/mnt/games` niestosowne tej samej metody utrwalania.
10. Układ pamięci wirtualnej powinien być podłączony do wspólnego dysku danych dla `/opt/container-data/steam-headless/home` i `/mnt/games` oraz normalnego dysku startowego.
11. „Utwórz” i „Usuń” wymaga zastosowania cyklem życia w wspólnym dysku z danymi; Dysk pozostaje ukryty, a nie odłączony dyskiem pozostawionym po operacji „Usuń”.

## Obecny stan

Obecne uruchomienie instalacjie już kontener Steam Headless na hoście maszyn wirtualnych w lokalizacji:

- ścieżka hosta: `/opt/container-data/steam-headless/home`
- ścieżka kontenera: `/home/default`

Biblioteka gier zawiera się pod:

- `/mnt/gry`

Bieżąca ścieżka startowa:

- Metadane wirtualnej maszyny `steam-headless-env`
- skrypt startowy zapisuje `/opt/container-services/steam-headless/.env`
- okno dokowane montuje `${HOME_DIR}` do `/home/default`

Obecne zachowanie trwałości działa już w przypadku „/home” poprzez proces tworzenia kopii zapasowych/przywracania po stronie hosta niepowiązanego z dyskiem Google.

Aktualna uwaga dotycząca stosowania:

- element implementacji nie jest jeszcze zdefiniowany, znajdujący się poniżej cyklu życia współdzielonego dysku z danymi,
- w związku z tym plan ten stanowi uzupełnienie konfiguracji przechowywania, jak i zapewnienie trwałości.

## Ustalenia odkrycia

Kontrola działająca wirtualnej maszyny wirtualnej:

- Stan Sunshine znajduje się pod `/opt/container-data/steam-headless/home/.config/sunshine`
-kluczowe pliki Sunshine obejmują:
- `apps.json`
- `credentials/cacert.pem`
- `credentials/cakey.pem`
- `sunshine.conf`
- `sunshine_state.json`
- Stan Steam występuje w `/opt/container-data/steam-headless/home/.steam`
-kluczowe pliki Steam obejmują:
- `.steam/steam/config/loginusers.vdf`
- `.steam/steam/config/config.vdf`
- `.steam/steam.token`

Oznaczać:

- `/home` do szerokiej granicy komunikacyjnej dla autoryzacji/sesji Steam i parowania/konfiguracji Sunshine,
- `/mnt/games` jest oddzielny i należy go zastosować jako zainstalowaną funkcję, a nie lekki stan napędu,
- stworzony bootstrap i sekrety muszą zostać przywrócone od `/home`.

## Kierunek projektowania

### `/dom`

Zachowaj bieżącą lekką kopię zapasową:

- przywróć przy rozruchu „Utwórz” / świeżo-utwórz
- wykonaj kopię zapasową przy poleceniach „Stop”, „Uruchom ponownie” i „Usuń”.

Rozumowanie: - zawiera stan uwierzytelnienia/konfiguracji, który faktycznie często występuje,
- jest nieznacznie niewielkie,
- istnieje możliwość tworzenia kopii zapasowych.

### `/mnt/gry`

Nie przechowuj `/mnt/games` w tej samej ścieżce synchronizacji na poziomie katalogu, co `/home`.

Zamiast tego:

- archiwizuj `/mnt/games` tylko podczas `Delete`,
- przywróć do archiwum podczas tylko rozruchu typu `Create` / Fresh-create,
- nie twórz kopii zapasowej `/mnt/games` podczas `Stop` lub `Restart`.

Rozumowanie:

- biblioteki gier są duże,
- częsta synchronizacja jest zbyt wolna i zaszumiona,
— Dysk jest akceptowalny jako chłodnia dla kontrolowanej zawartości, a nie jako udostępnianie synchronizacji operacyjnej.

## zalecana architektura

### Czas działania

- dysk startowy dla systemu operacyjnego, Dockera, skryptów startowych i środowiska wykonawczego hosta tymczasowego
- jeden współdzielony dysk z danymi stanu aplikacji
- `/opt/container-data/steam-headless/home` przechowywany na wspólnym dysku z danymi
- `/mnt/games` dostępny na tym samym dysku w publicznym dysku
- przywróć bramkowanie w oparciu o początek pierwotnego przygotowania, a nie każdy zwykły rozruch

### Układ dysku wirtualnej

Maszyna wirtualna może mieć 2 dyski:

1. dysk rozruchowy
- system inicjujący
- Silnik Dockera i pakiety
- narzędzie do uruchamiania/zamykania/trwałości
- przejściowe lokalne środowisko wykonawcze komputera
2. dysk z danymi
- zamontowany na początku mocowania
- zawiera oba:
     - `/opt/container-data/steam-headless/home`
     - `/mnt/gry`

Cykl życia:

- „Utwórz” tworzy i dołącza nowy, współdzielony dysk z danymi
- pierwszy rozruch formatuje się w razie potrzeby i montuje deterministycznie
- Opcja „Usuń” usuwa maszynę wirtualną i jej wspólny dysk z danymi dopiero po pomyślnym wykonaniu kopii zapasowej
- pozostałości pozostają Dysk Google, a nie usuwanie dysku

Rozumowanie:

- proste zaopatrzenie niż podstawowe dyski dla domu i gier,
- mniej ruchomych części podczas `Tworzenia`,
- oba źródła zasilania aplikacji, a nie stanu systemu bazowego,
- zasady tworzenia zapasowych kopii zapasowych mogą nadal powodować skutki od katalogu, nawet jeśli oba znajdują się na tym samym dysku z danymi.

### Magazyn kopii zapasowych

Dysk Google zakorzeniony na koncie `mwodevelop@gmail.com`.

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

### Zakres archiwum tylko do wyszukiwania

- pełne `/mnt/games`

### Konfiguracja środowiska wykonawczego z odbudową elektryczną

- `/opt/container-services/steam-headless/.env`
- wygenerowane metadane startowe
- pliki tymczasowe/pamięci podręcznej poza utrwalonymi obszarami
- dysk i montaż, który został utworzony w sposób deterministyczny podczas „Utwórz”.
- zatwierdzony system plików na pustym dysku w spółdzielczym z danymi, który powinien być zautomatyzowany i idempotentny

## Proponowany plan wykonania

### Faza 1: Udoskonalenie przechowywania1. Zachowana jest podstawowa kopia zapasowa `/home` w niezmienionej postaci.
2. Usuń `/mnt/games` ze skutkiem awarii.
3. Wyraźne określenie modelu dysku wirtualnego:
- `dysk startowy` dla systemu/środowiska wykonawczego
- jeden współdzielony „dysk z danymi” zamontowany dla obu utrwalonych aplikacji
4. Zdefiniuj montaż dla podłączonego dysku z danymi internetowymi, na przykład:
- zamontuj dysk w wcześniejszym szczegółowym, takim jak `/mnt/state`
- mocowanie powiązań lub dowiązanie symboliczne:
     - `/mnt/state/home` -> `/opt/container-data/steam-headless/home`
     - `/mnt/stan/gry` -> `/mnt/gry`
- lub montuj poszczególne podkatalogi w inny deterministyczny sposób
5. Zdefiniuj dokładny cykl życia w dzielonym dyskusycie z danymi źródłowymi:
- `Utwórz` plastikowy nowy pusty dysk o skonfigurowanym urządzeniu/typu
- startup formatuje dyski tylko wtedy, gdy nie istnieje jeszcze niepożądany system plików
- startup montuje się poprzez stabilną tożsamość urządzenia, takiego jak UUID, a niestabilną obecność urządzenia
- `Usuń` usuwa dysk razem z maszyną wirtualnie po pomyślnym wykonaniu kopii zapasowej
6. Ustaw układ `/home` jako podstawowy i następujący:
- `steam-vm-state/home/home.tar.zst`
- `steam-vm-state/home/manifest.json`
- zachowaj zgodność z bieżącą implementacją, chyba że migracja jest wyraźnie widoczna
7. Zdefiniuj dziecięcy układ archiwum gier na Dysku:
- niezmienny obiekt archiwum: `steam-vm-state/games/archives/<timestamp>.tar.zst`
- niezmienny archiwum manifestu: `steam-vm-state/games/manifests/<timestamp>.json`
- bieżący wskaźnik: `steam-vm-state/games/current.json`
8. Zdefiniuj manifest zawartości dla kopii zapasowej `/home`:
- znacznik czasu
- ścieżka obiektu archiwum
- ścieżka źródłowa
- wersja formatu kopii zapasowej
9. Zdefiniuj treść manifestu dla archiwum gier:
- znacznik czasu
- ścieżka obiektu archiwum
- ścieżka źródłowa
- format kompresji
- przybliżony rozmiar
- przywróć wersję formatu
- ślad sukcesu / status publikacji
10. Zdefiniuj trwałość przechowywania niezmiennych archiwów:
- minimum: zachowaj dostępne archiwum
- opcjonalne: zachowaj ostatnie `N` archiwów do wycofania/debugowania

Możliwość dostarczenia:

- pozostały układ dla podzielonej trwałości

### Faza 2: Zmiany w narzędziach tworzenia kopii zapasowych/przywracania1. Rozszerzenie `gcp-vm/persist-state.sh` o wydanie kodu źródłowego:
- Kopia zapasowa/przywracanie `/home`
- Archiwizacja/przywracanie `/mnt/games`
2. Dodaj pomocników, aby zapewnić, że udostępniony dysk jest podłączony do zestawu i że wymagane są katalogi przed utworzeniem kopii zapasowej lub przywracania.
3. Dodaj pomocników do:
- dostępny, czy w spółdzielony dysk z danych ma już system plików,
- utwórz systemu plików tylko przy pierwszym uruchomieniu,
- zamontuj za pomocą UUID lub równoważnego identyfikatora.
4. Zaimplementuj archiwum `/mnt/games` jako źródło, a nie tymczasowy lokalny plik tar:
- kopia zapasowa: `tar -C /mnt -cf - gry | zstd | rclone rcat .../archives/<znacznik czasu>.tar.zst`
- przywróć: `rclone cat .../archives/<timestamp>.tar.zst | zstd -d | tar -C /mnt -xf -`
5. zastosowanie, że Steam/obciążenie dostępu do konta przed dostępną kopią zapasową `/home` i przed zapisanym archiwum gier.
6. Zachowaj własność, prawa i oczekiwania dotyczące punktów montowania po przywróceniu.
7. Odmów naprawy, jeśli `/mnt/games` nie jest pusty, chyba że przepływomierz jest jawnie w zasilaczu.
8. Publikuj kopie zapasowe gier transakcyjnie:
- prześlij archiwum na niezmienne hasło ze znacznikiem czasu,
- napisz manifest ze znacznikiem czasu,
- zaktualizuj `current.json` dopiero później, gdy oba działania się powiodą.
9. Przywróć gry poprzez katalog pomostowy, na przykład:
- wyodrębnij do `/mnt/games.restore.<token>`
- sprawdź skuteczność ekstrakcji
- zastąp katalog udostępniany atomowo, o ile pozwala na dostęp do systemu plików
- dopiero ujawnij przywrócone drzewo jako `/mnt/games`
10. Jeśli kopia zapasowa `Usuń` nie powiedzie się po ustaniu kontroli:
- nie usuwaj VM,
- na powierzchni końcowej,
- administrator operatora z możliwością odzyskania stanu maszyn,
- opcja zrestartuj stos, jeśli wycofanie jest bezpieczne.

Możliwość dostarczenia:

- skrypt dzielonego tworzenia kopii zapasowych/przywracania funkcjonalności użytkowej

### Faza 3: Integracja Bootstrap z maszyną wirtualną

1. Zaktualizuj przebieg uruchamiania, aby przywrócić kontrolę przez wyraźną intencję świeżego zasilania.
2. Preferowany mechanizm:
- Cloud Run „Utwórz” zapisuje znaczniki metadanych, taki jak „vm-restore-mode=create”
- uruchomienie wymaga dokładnego raz
- uruchomienie usuwa się po pomyślnym przywróceniu lub po sterowanej ścieżce bez kopii zapasowej
3. Sondowanie stanu pustego można zastosować wyłącznie w celu sprawdzenia bezpieczeństwa, a nie jako głównego wyłącznika.
4. Przed ponownym uruchomieniem, udostępniony dysk jest podłączony, zamontowany i wyposażony.
5. Jeśli udostępniony dysk z danych jest pusty:
- utwórz system plików,
- utwórz oczekiwanego układu katalogów,
- następnie uruchom przywracanie.
6. Przywróć `/home` przed `docker compose up -d` tylko ponownie, gdy bramka przywracania jest otwarta.
7. Przywróć archiwum `/mnt/games` przed `docker compose up -d` tylko ponownie, gdy bramka przywracania jest otwarta i pojawia się plik `current.json`.
8. Pomiń odzyskanie gier w sposób, jeśli nie istnieje żadne archiwum.
9. Wyczyść bramkę przywracania po pierwszym uruchomieniu, aby uzyskać kolejne cykle `Stop`/`Start`, które nie zostały opisane importowania stanu.
10. Bezpieczne niepowodzenie, jeśli archiwum gier jest uszkodzone:
- zaznacz stan przywracania,
- pozostaw maszynę wirtualną bootowalną,
- nie uruchamiaj stosu aplikacji na aktywnym pliku przywróconym `/mnt/games`.
11. Zachowaj idempotentny bootstrap.

Możliwość dostarczenia:

- ścieżki startowe z automatycznym przywracaniem gier

### Faza 4: Integracja akcji mocy1. Zachowaj zachowanie dla `/home`:
- `Stop` -> kopia zapasowa `/home`
- `Uruchom ponownie` -> kopia zapasowa `/home`
- `Usuń` -> kopia zapasowa `/home`
2. Dodaj zachowanie archiwum gier tylko do opcji „Usuń”:
- wyciszyć obciążenie robocze
- wykonaj kopię zapasową `/home`
- archiwum `/mnt/games`
- opublikuj `current.json`
- usuń maszynę wirtualną dopiero po pomyślnym wykonaniu operacji
3. Zachowaj opcję „Utwórz” automatycznie:
- jeśli istnieje kopia zapasowa `/home`, przywróć ją
- jeśli archiwum gier istnieje, przywróć je
- w razie wypadku w przypadku pustym
4. W przypadku niepowodzenia „Usuń” po rozważeniu tworzenia kopii zapasowej:
- zwróć wynik nieudanego polecenia,
- nie usuwaj skutków,
- dostępne status, aby operator mógł ponowić próbę lub sprawdzić.
5. Po pomyślnym „Usuń”:
- usuń maszynę wirtualnie,
- usuń udostępniony dysk z danymi,
- Zachowaj artefakty Dysku jako jedyne źródło adresu.

Możliwość dostarczenia:

- semantyka wskaźników kontrolnych ustalana w nowej konsoli

### Faza 5: Zmiany w backendie i GUI

1. Zaktualizuj ładowanie stanu API Cloud Run, aby udostępnić bezpieczne metadane elektroniczne:
- czas krótszy zapasowej `/home`
- czas archiwizacji ostatnich gier
- czy istnieje archiwum gier
- czy najnowsze archiwum gier jest dostępne i możliwe do przywrócenia
- czy ostatnie przywracanie powiodło się, czy nie
- czy obecnie występuje na przywrócenie, ponieważ instancja została świeżo utworzona
- czy udostępniony dysk z danymi jest podłączony i zamontowany zgodnie z oczekiwaniami
2. Zaktualizuj komunikaty GUI, aby operatorzy mogli odczytać:
- `Stop` i `Restart` za stosowanie stanu tylko dla `/home`
- `Usuń` pierwotne zapasowe, łącznie z zapasowymi grami
3. Zachowanie zabezpieczenia „Usuń”, ponieważ może być wymagane, aby zapewnić dostęp do archiwizacji.
4. Pokaż przebieg destrukcyjnej na poziomie:
- łagodzenie pracy
- wróć do domu
- archiwizacja gier
- usunąć maszynę wirtualną
5. Wyświetlenie dotyczące nieudanego zniszczenia, jeśli faza tworzenia kopii zapasowej/archiwizacji nie powiodła się, a maszyna wirtualna została celowo zachowana.

Możliwość dostarczenia:

- stan trwałości widoczny dla operatora

### Faza 6: Walidacja

Matryca testowa:

1. Zalogowany Steam -> kopia zapasowa -> zniszczenie VM -> odtwórz VM -> przywróć -> potwierdź, że sesja Steam przetrwa.
2. Sunshine sparowany z użytkownikiem -> kopia zapasowa -> zniszczona maszynę wirtualną -> odtwórz maszynę wirtualną -> przywróć -> potwierdź, że parowanie przetrwało.
3. Drzewo katalogów znajdujących się w `/mnt/games` -> `Usuń` -> `Utwórz` -> potwierdź z ponownym dostępem do katalogów.
4. Znana ścieżka leczenia gry w `/mnt/games` powraca po przywróceniu.
5. Przywróć całkowicie pusty dysk rozruchowy.
6. Przywróć całkowicie pusty udostępniony dysk z danymi.
7. Przerwane przesyłanie nie powoduje użycia pliku „current.json” do częściowego archiwum.
8. Brak archiwum gier nie blokuje uruchomienia.
9. dostępne jedno archiwum gier dostępnych w wersji dostępnej jako dostępny status.
10. „Zatrzymaj” i „Uruchom ponownie” zachować ostrożność niż „Usuń”.
11. Zwykłe `Stop` -> `Start` na wirtualnej maszynie, która nie powoduje całkowitego przywrócenia `/home` lub `/mnt/games`.
12. Nieudane przywracanie do katalogu pomostowego nie powoduje zastąpienia dobrego `/mnt/games`.
13. Odtworzona wirtualna maszyna jest, podłączana, w razie potrzeby formatuje i montuje udostępniany dysk z danych przed ponownym uruchomieniem.
14. Rozwiązanie „Usuń” powoduje usunięcie dysku z bazy danych, zamiast ustalonej osieroconej pamięci.

Możliwość dostarczenia:

- raport z siedzenia i testu cyklu życia

## Sugerowana przejście pracy1. Zdefiniuj i zaimplementuj cykle życia w dzielonym dysku z danymi oraz układem montażu
2. Zrefaktoryzuj skrypt trwałość, aby pokryć `/home` i `/mnt/games`
3. Dodaj usługę archiwum gier przesyłanych strumieniowo
4. Zintegruj przygotowanie dysku i przywracanie gier podczas uruchamiania
5. Dostosuj dźwięk „Usuń”, aby zapisać archiwum gier i usunąć dysk
6. Ujawnij status w zapleczu/interfejsie
7. Uruchomiona pełna weryfikacja biologiczna `Usuń -> Utwórz`

## Ryzyko

- archiwizacja/przywracanie gier może być zwolnione z dużej ilości czasu w magazynie bibliotek
- przerwane Opcja „Usuń” może być nieaktualne lub częściowe archiwum, jeśli zapisy nie są dostępne w trybie transakcyjnym
- przy zastosowaniu bardzo rozszerzonego archiwum wydłuży działanie „Utwórz”.
- W niektórych funkcjach Steam może nadal wymagać niezależnej naprawy po przywróceniu
- Przepustowość/przydział dysku może stać się ograniczeniem ograniczającym w przypadku dużych bibliotek
- przywracanie na tar pozostałości plików, ale nie tożsamość dysku na poziomie prywatnym; każde oprogramowanie oczekujące semantyki surowego obrazu dysku wymagałoby innego miejsca
- współdzielony dysk z maksymalnym promień działania w powiadomieniu z oddzielnymi dyskami stanu aplikacji, więc poprawność montażu i konfiguracja zapasowych urządzeń ma większe znaczenie
- jeśli identyfikacja dysku jest zaimplementowana niepoprawnie, nowa maszyna wirtualna może być urządzeniem wielofunkcyjnym lub nie dostępnym na dysku z danymi; Montaż oparty na UUID jest podłączony do gniazda

## Pierwszy zalecany następny krok

Zmodyfikuj dostępną implementację trwałości, tak aby `/mnt/games` udostępniał częstotliwość transmisji i stał się archiwum przesyłanym strumieniowo, dostępnym tylko za pomocą opcji `Usuń`, z automatycznym przywracaniem w czasie `Utwórz`. Dzięki temu normalnemu działaniu mocy jest szybkie i widoczne sprawdzenie działania gry.

---

# Aktualizacja planu: niezawodny transfer stanu i aktualny status GUI

## Powód aktualizacji

Podczas akcji `Stop` dla VM `steam-mwo-vm1-t4-europe-central2-c` archiwum `/home` o rozmiarze około 3,19 GB było przesyłane przez ponad 30 minut. Proces `rclone` pozostawał aktywny, ale wysłał ponad 11 GB, co wskazuje na ponawianie fragmentów uploadu na poziomie HTTP/API, a nie tylko na wolne łącze. Jednocześnie otwarta karta panelu administratora nadal pokazywała wynik poprzedniej akcji zamiast trwającego `Stop`.

Aktualny stan techniczny wymagający zmiany:

- VM używa systemowego `rclone 1.53.3`,
- konfiguracja Google Drive nie ma własnego `client_id` i `client_secret`,
- retry są zagnieżdżone na trzech poziomach: low-level, rclone i zewnętrzna pętla skryptu,
- pojedyncza próba dużego transferu może trwać do 4 godzin,
- postęp istnieje tylko wewnątrz procesu `rclone` i nie jest publikowany do backendu ani GUI,
- karta GUI nie wykrywa niezależnie akcji uruchomionej w innej karcie lub sesji.

## Cele

1. Używać wspieranej, przypiętej wersji `rclone` zamiast starego pakietu z Ubuntu.
2. Przenieść ruch Google Drive na własnego klienta OAuth projektu.
3. Ograniczyć retry tak, aby operacja kończyła się sukcesem albo czytelnym błędem w przewidywalnym czasie.
4. Pokazywać etap, liczbę przesłanych bajtów, prędkość, czas i retry w GUI.
5. Synchronizować stan akcji pomiędzy kartami i po ponownym wejściu na stronę.
6. Nie wyłączać VM i nie oznaczać backupu jako gotowego po niepełnym transferze.
7. Zachować możliwość odczytania dotychczasowych backupów i bezpiecznego wycofania wdrożenia.

## Decyzje projektowe

1. Google Drive pozostaje magazynem backupu w pierwszym etapie naprawy. GCS będzie wariantem awaryjnym, jeżeli test z aktualnym rclone i własnym OAuth nadal będzie niestabilny.
2. Własny OAuth wymaga ponownej autoryzacji. Istniejącego refresh tokenu wydanego dla współdzielonego klienta rclone nie wolno tylko przepisać pod nowy `client_id`.
3. `client_id`, `client_secret` i token pozostają wyłącznie w Secret Managerze. API i GUI nie mogą zwracać ich wartości.
4. Wersja rclone ma być przypięta, a pobrany artefakt weryfikowany sumą SHA-256. Aktualizacja nie może zależeć od przypadkowej najnowszej wersji w czasie startu VM.
5. Postęp jest zapisywany najpierw do lokalnego pliku statusu. Metadane GCE są aktualizowane nie częściej niż co 15-30 sekund, aby nie generować kolejnego problemu z quota API.
6. Sukces transferu wymaga potwierdzenia istnienia obiektu o oczekiwanym rozmiarze oraz zapisu manifestu. Dopiero potem wolno ustawić końcowy status i zatrzymać VM.
7. Nieudany backup podczas `Stop` pozostawia VM uruchomioną. Stos aplikacyjny powinien zostać ponownie uruchomiony, o ile jest to bezpieczne, a akcja ma zakończyć się stanem `failed` z możliwością ponowienia.

## Faza 1: kontrola bieżącej operacji i pomiar bazowy

1. Pozwolić aktualnemu transferowi zakończyć się albo osiągnąć jawny limit; nie usuwać częściowych danych ręcznie bez sprawdzenia sesji uploadu.
2. Zapisać dla porównania:
   - rozmiar archiwum,
   - czas kompresji,
   - czas uploadu,
   - liczbę bajtów wysłanych przez socket,
   - liczbę retry,
   - końcowy kod i komunikat rclone.
3. Sprawdzić, czy po sukcesie zdalny plik i manifest mają poprawny rozmiar i znacznik czasu.
4. Jeżeli operacja zakończy się błędem, zachować log diagnostyczny bez sekretów i upewnić się, że VM nie została wyłączona.

Kryterium wyjścia: znany rezultat bieżącej operacji i dane bazowe pozwalające porównać poprawkę.

## Faza 2: własny klient OAuth i aktualizacja rclone

1. Utworzyć dedykowanego klienta OAuth dla mechanizmu trwałości VM.
2. Wykonać ponowną autoryzację konta `mwodevelop@gmail.com` dla nowego klienta.
3. Zapisać osobno w Secret Managerze:
   - `client_id`,
   - `client_secret`,
   - token OAuth zawierający refresh token.
4. Nadać dostęp do sekretów wyłącznie service accountowi VM i operatorom administracyjnym.
5. Zmienić `ensure_rclone_remote`, aby jawnie wymagał własnego klienta i nie przechodził cicho na współdzielony klient rclone.
6. Dodać instalację przypiętej wersji rclone z kontrolą SHA-256 oraz raportowaniem aktywnej wersji.
7. Przed przełączeniem produkcyjnym wykonać test tylko do odczytu starych plików i mały testowy upload do osobnego katalogu.
8. Zachować poprzedni sekret przez okres wycofania, ale nie używać go po udanym przełączeniu.

Kryterium wyjścia: nowy klient potrafi listować stare backupy, przesłać i usunąć testowy obiekt, a sekrety nie pojawiają się w logach ani odpowiedziach API.

## Faza 3: sterowanie transferem i retry

1. Dodać do dużych transferów jawne parametry Google Drive, w tym większy `drive-chunk-size`, dobrany testowo do pamięci VM i pojedynczego transferu.
2. Usunąć nadmierne mnożenie retry:
   - mała liczba retry niskopoziomowych,
   - jedna kontrolowana pętla wysokopoziomowa,
   - wspólny maksymalny czas całej operacji zamiast 4 godzin na każdą próbę.
3. Klasyfikować błędy:
   - chwilowe `429` i `5xx`: retry z exponential backoff i jitterem,
   - limit uploadu lub brak autoryzacji: natychmiastowe przerwanie,
   - błąd integralności lub rozmiaru: usunięcie nieopublikowanego obiektu i błąd końcowy,
   - przerwanie operatora: kontrolowane zakończenie bez oznaczania backupu jako gotowego.
4. Przesyłać do tymczasowej nazwy i publikować docelowy plik/manifest dopiero po weryfikacji.
5. Dodać identyfikator transferu, aby ponowienie tej samej akcji nie uruchamiało równolegle drugiego uploadu.
6. Zapewnić usuwanie lokalnych plików roboczych i nieopublikowanych obiektów po sukcesie oraz po błędzie.

Kryterium wyjścia: transfer nie wykonuje wielokrotnych pełnych uploadów bez widocznego retry i zawsze kończy się jednoznacznym stanem przed globalnym timeoutem.

## Faza 4: model postępu backendu

1. Rozszerzyć status akcji o pola:
   - `action`, `token`, `phase`,
   - `startedAt`, `updatedAt`,
   - `bytesTotal`, `bytesTransferred`, `speedBytesPerSecond`,
   - `attempt`, `maxAttempts`,
   - `lastError`, `retryAt`,
   - `cancellable` i `terminal`.
2. Fazy dla `Stop` powinny obejmować co najmniej:
   - zatrzymywanie workloadu,
   - tworzenie archiwum,
   - przesyłanie,
   - weryfikację,
   - publikację manifestu,
   - zatrzymywanie Compute Engine,
   - sukces albo błąd z rollbackiem workloadu.
3. Parsować statystyki rclone w stabilnym formacie i aktualizować lokalny status cyklicznie.
4. Publikować ograniczony status do metadanych GCE lub dedykowanego endpointu bez sekretów i pełnych logów.
5. Backend Cloud Run ma rozpoznawać stan nieświeży: brak aktualizacji przez ustalony czas nie może być prezentowany jako normalny postęp.
6. Endpoint `status` ma zwracać aktywną akcję niezależnie od karty lub sesji, która ją uruchomiła.

Kryterium wyjścia: odświeżenie strony i druga karta pokazują ten sam etap, postęp i wynik końcowy.

## Faza 5: GUI i ergonomia

1. Przy wejściu na panel oraz przy każdym ręcznym `Status` pobierać aktywną akcję z backendu.
2. Gdy akcja jest aktywna, automatycznie odpytywać status z backoffem; polling ma działać także po przeładowaniu strony.
3. Użyć `BroadcastChannel` jako optymalizacji natychmiastowej synchronizacji kart, ale backend pozostaje źródłem prawdy.
4. Loader ma pokazywać:
   - aktualną fazę,
   - `przesłano / razem` i procent,
   - bieżącą prędkość oraz orientacyjny pozostały czas,
   - numer retry i powód oczekiwania.
5. Po przekroczeniu progu braku postępu pokazać ostrzeżenie `Transfer nie raportuje postępu`, a nie bezterminowe `Running`.
6. Po błędzie przywrócić dostępność przycisków i wyświetlić akcje `Ponów Stop` oraz administracyjne anulowanie, jeśli backend potwierdza, że jest bezpieczne.
7. Unikać podwójnych loaderów i dublowania komunikatów między odpowiedzią polecenia a pollingiem statusu.

Kryterium wyjścia: użytkownik rozumie, czy trwa kompresja, upload, retry czy zatrzymanie VM, bez zaglądania do logów GCE.

## Faza 6: testy

### Testy automatyczne

1. Parser postępu rclone dla sukcesu, retry, `429`, `5xx`, błędu OAuth, limitu uploadu i timeoutu.
2. Stan maszyny akcji oraz dozwolone przejścia między fazami.
3. Idempotencja ponowienia tego samego tokenu akcji.
4. Brak publikacji manifestu dla częściowego uploadu.
5. Redakcja sekretów w logach i API.
6. Synchronizacja komunikatów GUI bez duplikatów i bez wyłączania przycisku `Status`.

### Testy integracyjne

1. Mały plik z własnym OAuth: upload, weryfikacja, pobranie i usunięcie.
2. Archiwum około 3 GB: pomiar czasu, bajtów i retry względem wartości bazowej.
3. Kontrolowane przerwanie sieci podczas uploadu i poprawne wznowienie albo jednoznaczne ponowienie.
4. Symulacja `429`, `5xx`, wygasłego tokenu i braku uprawnień.
5. Globalny timeout: VM pozostaje uruchomiona, workload wraca, status jest `failed`.
6. Dwie równoległe próby `Stop`: tylko jeden transfer, druga odpowiedź informuje o aktywnej akcji.

### Testy E2E w przeglądarce

1. Uruchomić `Stop` w pierwszej karcie i obserwować postęp w drugiej.
2. Odświeżyć stronę w połowie transferu i potwierdzić odtworzenie loadera oraz stanu.
3. Poczekać do `TERMINATED` i sprawdzić końcowy komunikat, przyciski oraz kartę instancji.
4. Wykonać `Start` i potwierdzić zachowanie stanu Sunshine, Steam i aplikacji.
5. Wykonać test błędu transferu i potwierdzić brak wyłączenia VM oraz możliwość ponowienia.
6. Regresyjnie sprawdzić `Restart`, `Delete`, `Create Backup`, `Restore Backup`, migrację między strefami i skanowanie GPU.

## Faza 7: wdrożenie i wycofanie

1. Wdrożyć backend i GUI bez przełączania sekretu produkcyjnego.
2. Wykonać test canary nowego OAuth i rclone na testowym katalogu.
3. Przełączyć jedną testową VM i przeprowadzić pełny `Stop -> Start`.
4. Dopiero po sukcesie propagować skrypt i konfigurację do pozostałych VM.
5. Zweryfikować rewizję Cloud Run, GitHub Pages, status sekretów i wersję rclone raportowaną przez VM.
6. Zachować możliwość powrotu do poprzedniej rewizji i poprzedniego sekretu do czasu zakończenia testów odczytu starych backupów.
7. Po okresie stabilizacji wyłączyć stary token i usunąć go zgodnie z kontrolowaną procedurą.

## Kryteria ukończenia

1. Produkcyjny `Stop` kończy się `TERMINATED` albo jednoznacznym błędem przed globalnym limitem czasu.
2. Dla poprawnego uploadu liczba wysłanych bajtów nie wskazuje na niewidoczne wielokrotne pełne próby.
3. Backup jest publikowany dopiero po weryfikacji rozmiaru i manifestu.
4. GUI pokazuje aktualny postęp po odświeżeniu oraz w drugiej karcie.
5. Nieudany backup nie powoduje utraty stanu ani wyłączenia VM.
6. Stare backupy pozostają możliwe do odczytania po migracji OAuth.
7. Testy automatyczne, integracyjne i E2E przechodzą, a wdrożone artefakty odpowiadają zatwierdzonemu commitowi.

## Ryzyka i działania ograniczające

- Ponowna autoryzacja OAuth może odciąć stare dane: najpierw test odczytu, potem przełączenie, na końcu unieważnienie starego tokenu.
- Większy chunk zużywa więcej RAM: jeden transfer i pomiar pamięci przed wyborem wartości produkcyjnej.
- Częste metadane mogą wyczerpać quota Compute API: lokalny status oraz ograniczona częstotliwość publikacji.
- Automatyczny restart workloadu po błędzie może być niebezpieczny po częściowym przygotowaniu: rollback musi być idempotentny i testowany awaryjnie.
- Google Drive może pozostać niestabilny dla operacyjnych checkpointów: po niespełnieniu kryteriów canary przejść na GCS dla bieżącego stanu, pozostawiając Drive jako warstwę archiwalną.

## Korekta po niezależnym review

Poniższe decyzje są nadrzędne wobec wcześniejszych fragmentów dokumentu, jeżeli występuje między nimi sprzeczność. Review zostało wykonane niezależnie od autora planu i objęło semantykę akcji, bezpieczeństwo, integralność, współbieżność, rollout i fault injection.

### 1. Semantyka akcji bez blokującego backupu

1. `Stop` nie wykonuje uploadu do Google Drive. Zatrzymuje workload, wykonuje `sync`, bezpiecznie odmontowuje lub przygotowuje Persistent Disk i zatrzymuje VM.
2. `Restart` nie wykonuje uploadu do Google Drive. Zachowuje dane na Persistent Disk i uruchamia standardowy restart.
3. `Create Backup` pozostaje jedyną standardową akcją tworzącą zdalny backup. Może czasowo zatrzymać workload w celu uzyskania spójnego obrazu, ale po zakończeniu przywraca jego poprzedni stan.
4. `Create` nie przywraca backupu automatycznie. Przywrócenie jest wykonywane wyłącznie przez jawną akcję `Restore Backup`.
5. `Delete` nie tworzy backupu automatycznie. GUI pokazuje wiek ostatniego poprawnego backupu i wymaga jawnego potwierdzenia ryzyka usunięcia VM oraz dysku stanu.
6. Nie dodawać domyślnej opcji `backup-before-stop`. Jeżeli powstanie kiedyś taka polityka, musi być jawnie włączana przez administratora i nie może zmieniać semantyki zwykłego `Stop`.
7. Bieżący problem wielominutowego `Stop` powinien zostać usunięty przede wszystkim przez rozdzielenie akcji zasilania od backupu, a nie tylko przez przyspieszenie rclone.

Kryterium akceptacji: `Stop` i `Restart` działają bez dostępu do Google Drive, a awaria Drive nie blokuje zarządzania zasilaniem VM.

### 2. Szyfrowanie i minimalne uprawnienia

1. Backup `/home` zawiera tokeny Steam, klucze Sunshine i dane parowania, dlatego nowy format backupu musi być szyfrowany po stronie klienta.
2. Preferowany mechanizm to `age` albo osobny remote `rclone crypt`; wybór ma zostać poprzedzony testem restore, rotacji klucza i obsługi starych backupów.
3. Klucz szyfrujący ma być osobnym sekretem. Nie wolno łączyć go z tokenem OAuth ani umieszczać w manifeście.
4. Jawny manifest zawiera wyłącznie niesensytywne metadane. Nazwy plików, logi, status API i ścieżki tymczasowe nie mogą ujawniać sekretów ani nazw użytkowników aplikacji.
5. Dedykowana service account VM otrzymuje tylko `secretmanager.versions.access` do konkretnych sekretów. Zarządzanie wersjami sekretów pozostaje poza service accountem VM i poza zwykłym GUI.
6. Tymczasowy `rclone.conf` ma prawa `0600`, powstaje na czas operacji i jest bezpiecznie usuwany po jej zakończeniu.
7. OAuth ma używać minimalnego wystarczającego scope Drive, produkcyjnego klienta OAuth oraz opisanej procedury rotacji i revocation.

### 3. Format backupu, integralność i zgodność

1. Nie nadpisywać stałego `home.tar.zst` jako jedynej dobrej kopii.
2. Każdy backup jest niezmienną generacją:
   - `backups/<hardware>/<backup-id>/archive.tar.zst.enc`,
   - `backups/<hardware>/<backup-id>/manifest.json`,
   - `backups/<hardware>/<backup-id>/COMMITTED` publikowany jako ostatni.
3. Manifest zawiera co najmniej:
   - SHA-256 zaszyfrowanego archiwum,
   - rozmiar skompresowany oraz deklarowany maksymalny rozmiar po ekstrakcji,
   - format kompresji i szyfrowania,
   - wersję schematu,
   - identyfikator profilu hardware i endpointu,
   - czas utworzenia.
4. Backup jest widoczny jako gotowy dopiero po uploadzie, zdalnej weryfikacji rozmiaru i SHA-256 oraz publikacji `COMMITTED`.
5. Restore przed ekstrakcją sprawdza marker, schemat, rozmiar i SHA-256.
6. Restore odrzuca ścieżki absolutne, wpisy z `..`, niebezpieczne symlinki, urządzenia specjalne i przekroczenie limitu rozmiaru po ekstrakcji.
7. Dla `/home` najpierw powstaje lokalny, seekowalny artefakt; dopiero potem liczony jest hash i wykonywany upload. Przed kompresją sprawdzane jest wolne miejsce.
8. Streaming pozostaje opcją wyłącznie dla świadomie wybranych dużych danych i nie może obiecywać wznowienia od miejsca przerwania.
9. Wprowadzić macierz formatów:
   - `v1 legacy`: obecny nieszyfrowany format,
   - `v2 transactional`: niezmienne generacje i marker,
   - `v3 encrypted`: generacje szyfrowane po stronie klienta.
10. Migracja stosuje `dual-read/single-write`: odczyt obsługuje starsze formaty, zapis tworzy wyłącznie aktywny nowy format. Przełączenie zapisu jest chronione feature flagą.
11. Rollback kodu musi wskazywać ostatnią kompatybilną generację albo jawnie blokować downgrade; nie może próbować interpretować nieznanego formatu.

### 4. Konkretny budżet retry i timeoutów

Wartości są konfigurowalne, ale pierwsza wersja implementacji przyjmuje następujące limity:

- maksymalnie 3 próby całej operacji uploadu,
- maksymalnie 5 retry HTTP w ramach próby,
- backoff od 5 do 120 sekund z jitterem,
- ostrzeżenie po 2 minutach bez postępu,
- przerwanie bieżącej próby po 5 minutach bez postępu,
- limit uploadu jednej generacji: 45 minut,
- limit całej akcji `Create Backup`: 60 minut,
- brak nowej pełnej próby po wyczerpaniu globalnego budżetu czasu.

Błędy OAuth, brak uprawnień, limit dzienny uploadu, błąd integralności i brak miejsca lokalnego są fatalne i nie zużywają kolejnych pełnych prób. `429` i przejściowe `5xx` używają ograniczonego retry z backoffem.

### 5. Trwały lease i idempotencja

1. Token akcji zapewnia idempotencję pojedynczego żądania, ale nie jest blokadą współbieżności.
2. Wszystkie akcje modyfikujące VM, backup lub dyski używają wspólnego lease per VM/endpoint.
3. Lease jest przechowywany po stronie backendu i zawiera właściciela, typ akcji, token, monotoniczną generację, heartbeat, termin wygaśnięcia i status zwolnienia.
4. Przejęcie wygasłego lease wymaga porównania generacji/CAS. Aktywny lease blokuje inną destrukcyjną akcję czytelnym komunikatem.
5. Restart procesu VM lub Cloud Run nie może powodować równoległego wykonania tej samej albo konkurencyjnej akcji.

### 6. Jedno źródło prawdy dla postępu

1. Trwałym źródłem prawdy dla postępu akcji jest magazyn backendowy, preferencyjnie Firestore, a nie często aktualizowane metadane GCE.
2. VM publikuje heartbeat do dedykowanego endpointu Cloud Run przy użyciu ID tokenu swojej service account.
3. Backend sprawdza tożsamość service account, przypisanie instancji do endpointu, token akcji, lease i monotoniczną rewizję statusu.
4. Metadane GCE pozostają kanałem konfiguracji i uruchomienia akcji oraz mogą zawierać skrócony status końcowy, ale nie telemetryczny postęp co kilkanaście sekund.
5. GUI odpytuje magazyn statusu backendu z `ETag/If-None-Match`, jitterem i ograniczoną częstotliwością. Backend cache'uje odczyty GCE i współdzieli wynik pomiędzy kartami.
6. `BroadcastChannel` przyspiesza synchronizację kart, ale nie jest źródłem prawdy.
7. Przed wywołaniem zatrzymania Compute Engine agent zapisuje `stopping_compute` i czeka na potwierdzenie backendu. Końcowy stan `TERMINATED/succeeded` zapisuje backend po obserwacji GCE.

### 7. Kompensacja i stan workloadu

1. Przed `Create Backup` agent zapisuje listę działających workloadów i ich stan.
2. Po sukcesie albo błędzie przywraca wyłącznie te workloady, które działały przed akcją.
3. Dla każdej fazy powstaje jawna reguła kompensacji, w szczególności dla:
   - przerwania po zatrzymaniu kontenerów,
   - sukcesu uploadu i błędu manifestu,
   - sukcesu backupu i błędu ponownego uruchomienia workloadu,
   - utraty procesu lub rebootu VM.
4. Nieudana kompensacja kończy się stanem `failed_rollback`, a nie zwykłym `failed`.
5. Administracyjna akcja awaryjna może wymusić zatrzymanie VM przy problemie z flush/unmount, ale wymaga potwierdzenia ryzyka. Nie jest obejściem dla zwykłego backupu, ponieważ `Stop` nie wykonuje backupu.

### 8. Wersjonowanie agenta VM i rollout

1. Skrypty VM i rclone są wersjonowanym pakietem agenta, a status API zwraca `agentVersion`, `rcloneVersion` i wspierane wersje protokołu.
2. Upgrade istniejącej VM jest idempotentny i możliwy przed wykonaniem akcji wymagającej nowego protokołu.
3. Backend stosuje compatibility gate: nie wysyła nowej akcji do starego agenta i pokazuje wymaganą aktualizację.
4. Wdrożenie Cloud Run i GitHub Pages nie jest uznawane za pełne wdrożenie, dopóki testowa VM nie zgłosi oczekiwanej wersji agenta.
5. Canary obejmuje jedną istniejącą VM, pełny `Create Backup -> Stop -> Start -> Restore Backup` i odtworzenie na świeżej VM.

### 9. Rozszerzona macierz awarii

Do testów z wcześniejszej sekcji dodać obowiązkowo:

1. Kill procesu i reboot VM w każdej fazie akcji.
2. Pełny dysk przed kompresją i w trakcie tworzenia lokalnego artefaktu.
3. Utratę i przejęcie lease oraz spóźniony heartbeat starego właściciela.
4. Awarię po uploadzie archiwum, ale przed manifestem i przed `COMMITTED`.
5. Uszkodzony manifest, błędny SHA-256 i nieznaną wersję schematu.
6. Archiwum z path traversal, symlinkiem poza katalog oraz archive bomb.
7. Rotację OAuth i klucza szyfrującego, odczyt starej generacji oraz revocation starego tokenu.
8. Rollback backendu, GUI i agenta do poprzedniej wersji.
9. Równoległe `Stop`, `Create Backup`, `Delete`, migrację i zmianę konfiguracji.
10. Disaster restore na nowej VM wraz z porównaniem checksum i kluczowych plików Steam/Sunshine.
11. Test bez dostępu do Drive potwierdzający, że `Stop` i `Restart` nadal kończą się poprawnie.

### 10. Ulepszenia odłożone poza minimalną naprawę

Poniższe elementy są wartościowe, ale nie blokują pierwszego bezpiecznego wdrożenia:

- automatyczna retencja według liczby generacji i zajętości, poprzedzona trybem `dry-run`,
- metryki Cloud Monitoring dla czasu backupu, retry, throughput, wieku backupu i błędów restore/rollback,
- redukcja zakresu `/home` o odtwarzalne cache po wykonaniu osobnej analizy danych,
- estymacja czasu i rozmiaru przed rozpoczęciem backupu,
- decyzja o przeniesieniu operacyjnych backupów do GCS po porównawczym canary Google Drive i GCS.

## Zmieniona kolejność realizacji

1. Najpierw odłączyć `Stop` i `Restart` od Google Drive oraz naprawić status tych akcji w GUI.
2. Następnie wprowadzić lease i backendowe źródło prawdy dla akcji.
3. Przygotować wersjonowany agent oraz wspierany rclone z własnym OAuth.
4. Wprowadzić niezmienne, integralne generacje backupu i dopiero później szyfrowany zapis `v3` z dual-read.
5. Dodać dokładny postęp, retry i kompensację `Create Backup`.
6. Wykonać testy fault injection i disaster restore.
7. Przeprowadzić canary, wdrożenie etapowe i dopiero potem unieważnić stare dane OAuth.
