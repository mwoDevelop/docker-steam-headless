# Plan: Scan & Create dla dostępnych GPU

## Cel

Podczas każdego skanu pojemności GPU pokazywać wynik dodatni natychmiast po
sprawdzeniu pary `GPU + strefa`. Każdy wynik ma oferować link otwierający nową
kartę GUI z ustawionymi: sprzętem, strefą, backendem i pierwszym wolnym
punktem końcowym DuckDNS. Użytkownik może dzięki temu szybko uruchomić `Create`
zanim skan całej listy się zakończy.

Skan pozostaje testem pojemności, a nie gwarancją utworzenia VM. `Create` musi
ponownie potwierdzić możliwość utworzenia wybranej pary.

## Założenia i granice

- Dotyczy trzech istniejących przepływów: wybrane GPU/strefy, wszystkie GPU w
  wybranej strefie oraz wszystkie GPU we wszystkich strefach.
- Wynik jest identyfikowany zawsze przez `hardwareId + zone`; nie wolno
  przenosić wyniku między profilami GPU ani strefami.
- Link nie zawiera tokenu Google, sekretów, hasła Sunshine ani adresu IP.
- Nie jest tworzona VM ani trwała rezerwacja IP w chwili skanowania.
- Brak wolnego punktu końcowego jest normalnym, widocznym wynikiem, a nie
  wyborem już używanej domeny.

## Projekt

### 1. Rejestr wyników skanu po stronie GUI

1. Dla każdego aktywnego skanu utrzymuj listę znalezionych par:
   `hardwareId`, etykieta GPU, `zone`, czas znalezienia, wynik sprzątania
   krótkiej rezerwacji i stan przygotowania endpointu.
2. Aktualizuj listę po każdej udanej odpowiedzi `scan-zone`, bez czekania na
   koniec pętli skanującej.
3. Renderuj listę pod komunikatem postępu jako `Available now` z rosnącą liczbą
   wyników. Pozostaw listę po anulowaniu jako wynik częściowy.
4. Nie duplikuj wpisów, gdy profil lub strefa pojawi się ponownie w wyniku
   odświeżenia albo wznowionego skanu.

### 2. Atomowy wybór pierwszego wolnego endpointu

1. Backend udostępnia operację przygotowania endpointu dla szybkiego utworzenia,
   np. `POST /api/endpoints/prepare-scan-create` z `hardwareId` i `zone`.
2. Operacja pod blokadą odczytuje rejestr endpointów oraz rzeczywisty stan GCE,
   wybiera pierwszy endpoint bez utworzonej VM i bez aktywnego przygotowania.
3. Backend zwraca identyfikator endpointu, DNS, czas wygaśnięcia i niejawny
   identyfikator krótkiej dzierżawy. Dzierżawa nie rezerwuje zewnętrznego IP i
   wygasa automatycznie, np. po 5 minutach.
4. Jeżeli nie ma wolnego endpointu, backend zwraca błąd domenowy
   `NO_FREE_ENDPOINT`; GUI pokazuje go przy wyniku, bez linku `Create`.
5. Backend czyści wygasłe dzierżawy przed każdym przydziałem i przy każdym
   odczycie endpointów. Zdarzenie jest zapisywane w historii aktywności.

### 3. Link Scan & Create

1. Po udanym przygotowaniu renderuj link `Open ready-to-create VM` otwierany w
   nowej karcie.
2. Link prowadzi do kanonicznego GUI administracyjnego z parametrami zapytania:
   `endpointId`, `hardwareId`, `zone`, opcjonalny identyfikator przygotowania i
   istniejący adres backendu. Parametry są walidowane względem katalogu
   sprzętu i rejestru endpointów przed zastosowaniem.
3. Po załadowaniu GUI ustawia dokładnie wskazany endpoint, GPU i strefę oraz
   pokazuje komunikat: `Capacity was observed at <czas>; Create will recheck it.`
4. Nieważna, zajęta lub wygasła dzierżawa nie może podmienić bieżącego wyboru
   bez czytelnego komunikatu. GUI pozostaje używalne i pozwala wybrać inny
   endpoint.

### 4. Utworzenie VM z przygotowanego wyniku

1. `Create` przekazuje identyfikator przygotowania tylko dla zgodnej pary
   `endpointId + hardwareId + zone`.
2. Backend atomowo zużywa dzierżawę i przed utworzeniem VM wykonuje bieżącą
   kontrolę konfliktu endpointu oraz pojemności GCE.
3. Sukces utworzenia zapisuje docelowy endpoint jak dziś. Niepowodzenie
   pojemności pokazuje prawdziwy błąd GCE w miejscu komunikatów i zwalnia
   dzierżawę.
4. Jeśli dzierżawa wygasła, `Create` może nadal wykonać zwykłe utworzenie tylko
   po ponownym atomowym wyborze wolnego endpointu; GUI komunikuje, że wynik
   skanu nie był już świeży.

### 5. UX i dostępność

1. Wiersz wyniku zawiera GPU, strefę z nazwą miasta, DNS wybranego endpointu,
   czas znalezienia oraz stan: `ready`, `endpoint unavailable`, `expired` albo
   `create started`.
2. Link jest aktywny dopiero po uzyskaniu dzierżawy endpointu. W trakcie
   przygotowania ma opis `Preparing free endpoint...`.
3. Anulowanie skanu nie anuluje istniejących dzierżaw natychmiast, aby linki z
   częściowych wyników pozostały użyteczne przez ich krótki TTL. Osobne
   zamknięcie/wygaszenie zwalnia je automatycznie.
4. Dodaj ograniczenie liczby równoległych przygotowań endpointów oraz cache
   wyniku dla identycznej pary, aby szybki skan nie obciążał rejestru.

## Niezależny przegląd planu

### Korekty przyjęte po review

Rejestr endpointów jest zapisany jako kolejne wersje sekretu Secret Manager i
nie zapewnia transakcyjnego compare-and-swap. Z tego powodu implementacja nie
może uczciwie obiecać wyłącznej dzierżawy DNS wyłącznie na bazie tego rejestru.
Zamiast tego przygotowanie wydaje podpisany, dziesięciominutowy kontekst dla
konkretnego administratora, endpointu, GPU i strefy. `Create` weryfikuje jego
podpis, wygaśnięcie, zgodność parametrów oraz aktualną wolność endpointu.

W rzadkim wyścigu dwóch kart mogą one chwilowo otrzymać link do tego samego
wolnego DNS. Pierwsze skuteczne utworzenie VM zajmuje zasób GCE; kolejne jest
odrzucone z czytelnym konfliktem i nie może przejąć ani podmienić endpointu.
Endpoint z ręcznie przypiętym IP w innym regionie nie jest kandydatem. Nadal
nie jest to rezerwacja GPU: skan zwalnia ją natychmiast, a `Create` może
zakończyć się prawdziwym błędem pojemności GCE.

1. **Wyścig kart przeglądarki:** wybór „pierwszego wolnego” tylko w JavaScript
   pozwoliłby dwóm kartom wybrać ten sam DNS. Dlatego przydział i dzierżawa
   muszą być obsłużone atomowo przez backend.
2. **Fałszywa gwarancja pojemności:** dotychczasowy test zwalnia rezerwację od
   razu. Wynik GUI jest więc obserwacją z czasem, a `Create` zawsze powtarza
   kontrolę pojemności i pokazuje ewentualną utratę capacity.
3. **Zużycie endpointów:** przygotowanie nie może rezerwować statycznego IP ani
   zostawiać trwałego wpisu po zamknięciu karty. Wymagany jest TTL, odśmiecanie
   i historia audytu.
4. **Mieszanie wyników:** filtrowanie tylko według strefy jest błędne dla
   różnych GPU. Wszystkie klucze i linki muszą zawierać `hardwareId + zone`.
5. **Uprawnienia:** przygotowanie endpointu i link do administracyjnego GUI są
   operacjami administratora. Backend ponownie sprawdza konto niezależnie od
   widoczności elementu strony.
6. **Nowa karta i sesja:** `sessionStorage` jest izolowane między kartami.
   Link Scan & Create musi więc jednorazowo pobrać sesję przez
   `window.opener.postMessage`, wyłącznie przy zgodnym originie, zanim załaduje
   kontrolki; token nie może trafić do URL ani `localStorage`.

## Fazy implementacji

### Faza 1: Kontrakt backendu i testy jednostkowe

1. Dodaj trwały, ograniczony czasowo rejestr dzierżaw endpointów i funkcje
   atomowego wyboru, zużycia oraz czyszczenia.
2. Dodaj endpoint przygotowania i walidację parametrów GPU/strefy.
3. Dodaj testy: pierwszy wolny endpoint, brak wolnych endpointów, dwie
   równoległe prośby, wygaśnięcie, ponowne użycie oraz niezgodna para GPU/strefa.

### Faza 2: Parametry GUI i bezpieczne Create

1. Dodaj obsługę parametrów linku, walidację katalogu i komunikaty po
   wygaśnięciu dzierżawy.
2. Rozszerz `Create` o opcjonalne przygotowanie oraz atomowe zużycie po stronie
   backendu.
3. Testy: otwarcie linku, poprawne wypełnienie endpointu/GPU/strefy, usunięty
   endpoint, wygasła dzierżawa i konflikt dwóch kart.

### Faza 3: Wyniki na żywo podczas skanów

1. Dodaj wspólny model wyników do wszystkich trzech skanerów.
2. Renderuj wynik dodatni natychmiast, przygotuj endpoint z ograniczoną
   współbieżnością i utwórz link w nowej karcie.
3. Testy: sukces, anulowanie z wynikami częściowymi, błąd przygotowania
   endpointu, błąd zwolnienia rezerwacji GPU i odświeżanie licznika rezerwacji.

### Faza 4: E2E i wdrożenie

1. E2E przez zalogowaną przeglądarkę: skan, wynik na żywo, otwarcie linku,
   sprawdzenie ustawionych pól i `Create` dla dostępnej pary.
2. E2E równoległych kart: tylko jedna otrzymuje ten sam endpoint; druga dostaje
   kolejny wolny endpoint albo `NO_FREE_ENDPOINT`.
3. E2E braku wolnych endpointów, anulowania skanu i wygaśnięcia dzierżawy.
4. Przed końcem zwolnij wszystkie testowe rezerwacje GPU, usuń testowe VM,
   uruchom CI, wykonaj deploy i sprawdź produkcyjny GUI.

## Kryteria akceptacji

- Dostępny wynik GPU/strefy pojawia się przed zakończeniem skanu.
- Link w nowej karcie otwiera GUI z poprawnym endpointem, GPU i strefą.
- Dwie karty nie mogą otrzymać tej samej aktywnej dzierżawy endpointu.
- `Create` nie ufa starym wynikom skanu i poprawnie raportuje utratę pojemności.
- Brak wolnych endpointów nie wybiera zajętego DNS.
- Anulowanie zachowuje częściowe wyniki przez TTL, a po jego upływie nie ma
  osieroconych dzierżaw, rezerwacji GPU ani testowych VM.
