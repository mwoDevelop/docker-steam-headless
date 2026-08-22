# Plan: Scan & Create dla dostępnych GPU

## Status dokumentu

Plan obejmuje zarówno istniejące wyniki skanowania z linkami `Scan & Create`,
jak i planowane rozszerzenie `Create after first available GPU`. Rozszerzenie
ma rozwiązać wyścig, w którym krótka rezerwacja zostaje zwolniona po sondzie,
a GPU nie jest już dostępne, gdy użytkownik uruchamia `Create`.

## Cel

Podczas każdego skanu pojemności GPU pokazywać wynik dodatni natychmiast po
sprawdzeniu pary `GPU + strefa`. Każdy wynik ma oferować link otwierający nową
kartę GUI z ustawionymi: sprzętem, strefą, backendem i pierwszym wolnym
punktem końcowym DuckDNS. Użytkownik może dzięki temu szybko uruchomić `Create`
zanim skan całej listy się zakończy.

Przy wyłączonym trybie automatycznym skan pozostaje testem pojemności, a nie
gwarancją utworzenia VM. Przy włączonym trybie automatycznym pierwsza skuteczna
rezerwacja GPU pozostaje aktywna, skan zostaje wstrzymany, a `Create` ma
utworzyć VM przez tę konkretną rezerwację GCE.

## Założenia i granice

- Dotyczy trzech istniejących przepływów: wybrane GPU/strefy, wszystkie GPU w
  wybranej strefie oraz wszystkie GPU we wszystkich strefach.
- Checkbox `Create after first available GPU` jest domyślnie zaznaczony i
  dotyczy każdego skanu wykonującego rzeczywistą próbę rezerwacji GPU. Nie
  zmienia operacji CPU ani wyłącznie katalogowych filtrów zgodności.
- Wynik jest identyfikowany zawsze przez `hardwareId + zone`; nie wolno
  przenosić wyniku między profilami GPU ani strefami.
- Link nie zawiera tokenu Google, sekretów, hasła Sunshine ani adresu IP.
- Nie jest tworzona VM ani trwała rezerwacja IP w chwili skanowania.
- Brak wolnego punktu końcowego jest normalnym, widocznym wynikiem, a nie
  wyborem już używanej domeny.
- Limit GPU równy `1` jest scenariuszem podstawowym. Po znalezieniu karty nie
  wolno tworzyć drugiej sondy ani zwykłej VM konkurującej z utrzymywaną
  rezerwacją.

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

### 2. Transakcyjny koordynator workflow i endpointów

1. Secret Manager pozostaje rejestrem konfiguracji endpointów, ale nie pełni
   funkcji blokady. Trwały stan skanu, dzierżawy endpointu i przejść workflow
   przechowuje Firestore Native w regionie zgodnym z Cloud Run.
2. Dokument endpointu zawiera `endpointId`, `owner`, `scanId`, `generation`,
   `state` i `expiresAt`. Transakcja Firestore wybiera pierwszy endpoint bez VM
   i aktywnej dzierżawy oraz warunkowo przełącza go do `LEASED`.
3. Backend udostępnia operację przygotowania endpointu, np.
   `POST /api/endpoints/prepare-scan-create`, i zwraca identyfikator endpointu,
   DNS, `leaseId`, generację oraz czas wygaśnięcia. Dzierżawa nie rezerwuje
   zewnętrznego IP.
4. Jeżeli nie ma wolnego endpointu, backend zwraca `NO_FREE_ENDPOINT` przed
   rozpoczęciem sond GPU. GUI nie może wybrać endpointu tylko po stronie
   przeglądarki ani użyć już zajętej domeny.
5. Wszystkie operacje `prepare`, `consume`, `release` i cleanup używają
   transakcji lub warunku `state + generation`. Podpisany token zawiera
   nieprzewidywalne `leaseId`, ale podpis jest tylko ochroną integralności;
   jednokrotność i unieważnienie wynikają z rekordu Firestore.
6. Cykliczny reconciler czyści wygasłe dzierżawy, uzgadnia je z rzeczywistym
   stanem GCE i zapisuje zdarzenia w historii aktywności.

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
   kontrolę konfliktu endpointu. W zwykłym trybie ponawia kontrolę pojemności;
   w trybie utrzymywanej rezerwacji przechodzi przez opisany niżej workflow.
3. Sukces utworzenia zapisuje docelowy endpoint jak dziś. Niepowodzenie
   pojemności pokazuje prawdziwy błąd GCE w miejscu komunikatów i zwalnia
   dzierżawę.
4. Jeśli dzierżawa wygasła, `Create` może nadal wykonać zwykłe utworzenie tylko
   po ponownym atomowym wyborze wolnego endpointu; GUI komunikuje, że wynik
   skanu nie był już świeży.

### 5. Tryb `Create after first available GPU`

#### 5.1. Sterowanie w GUI

1. Obok kontrolek skanowania dodać checkbox `Create after first available GPU`,
   domyślnie zaznaczony po pierwszym wejściu. Jawna zmiana użytkownika może być
   zachowana w `localStorage`, ale parametr linku ani poprzedni nieukończony
   skan nie może sam włączyć trybu.
2. Przy odznaczonym checkboxie zachować obecne zachowanie: wyniki pojawiają się
   na żywo, rezerwacje sond są zwalniane, a linki prowadzą do zwykłego
   `Scan & Create`.
3. Przy zaznaczonym checkboxie pierwszy dodatni wynik zatrzymuje planowanie
   kolejnych prób. GUI pokazuje stan `GPU reserved; choose applications` i
   automatycznie otwiera istniejący modal aplikacji dla `Create`.
4. Modal pokazuje nieedytowalne GPU, strefę, endpoint DNS oraz widoczny czas
   pozostały do wygaśnięcia rezerwacji. W trakcie modala nie można zmienić
   sprzętu, strefy ani endpointu w tle.

#### 5.2. Przygotowanie przed skanem

1. Przed rozpoczęciem prób GPU backend wybiera pierwszy wolny endpoint i wydaje
   podpisany kontekst endpointu. Brak endpointu kończy operację przed
   utworzeniem kosztownej rezerwacji GPU.
2. Kontekst skanu zawiera administratora, identyfikator skanu, endpoint,
   dozwolony zakres GPU/stref, czas utworzenia i wygaśnięcia. Nie zawiera tokenu
   Google ani sekretów w URL.
3. Backend ponownie sprawdza wolność endpointu po znalezieniu GPU i bezpośrednio
   przed `Create`. Konflikt zwalnia rezerwację GPU i pozwala wznowić skan po
   przydzieleniu kolejnego wolnego endpointu.
4. Transakcja admission control zakłada blokadę projektową dla operacji
   zużywających GPU. Uwzględnia aktywne workflow, działające VM GPU,
   zarządzane rezerwacje oraz wykryte rezerwacje obce. Druga karta, drugi
   administrator, ręczne `Create` i inny skan nie mogą ominąć blokady.
5. Quota GPU `1` nie gwarantuje capacity i nie obejmuje osobnych limitów CPU,
   dysków, adresów IP ani limitów regionalnych i globalnych GPU. Ich błędy są
   raportowane niezależnie.

#### 5.3. Utrzymanie rezerwacji GPU

1. Udana sonda nie usuwa rezerwacji. Backend zapisuje zarządzany rekord:
   `scanId`, `reservationName/selfLink`, `hardwareId`, `zone`, parametry
   maszyny i akceleratora, właściciela, endpoint, stan oraz TTL.
2. Trwały automat używa stanów `PROBE_CREATING -> HELD -> CREATE_CLAIMED ->
   INSERT_PENDING -> VM_CONFIRMED -> COMPLETED` oraz ścieżek
   `HELD -> RELEASE_REQUESTED/EXPIRE_REQUESTED -> RELEASED`. Niepewny wynik
   GCE przechodzi do `PROBE_UNKNOWN` albo `INSERT_UNKNOWN`, nigdy bezpośrednio
   do zwalniania zasobów.
3. Każde przejście jest transakcją warunkową po `state + generation`.
   `Cancel` podczas `PROBE_CREATING` ustawia `cancelRequested`; przerwanie HTTP
   nie jest traktowane jako anulowanie operacji GCE.
4. Skan w stanie `HELD` jest wstrzymany, a nie zakończony. Nie wolno
   uruchamiać następnych sond, ponieważ przy quota `1` powodowałyby fałszywe
   błędy lub blokowały docelowy `Create`.
5. `canonicalReservationShape` jest budowany z jednego katalogu sprzętu i
   używany przez `reservations.insert` oraz `instances.insert`. Obejmuje
   strefę, machine type, typ i liczbę GPU, minimum CPU platform, Local SSD oraz
   właściwości właściwe dla GPU dołączanych do N1 i accelerator-optimized VM.
6. Rezerwacja do tego workflow jest automatycznie konsumowalna
   (`specificReservationRequired=false`). Przed `HELD` backend odczytuje ją z
   GCE i potwierdza `READY`, `assuredCount=1`, zgodny kształt oraz brak
   nieoczekiwanych konsumentów.
7. TTL powinien być krótki, np. 5 minut. GUI pokazuje koszt naliczany od chwili
   rezerwacji i odlicza czas na podstawie serwerowego `expiresAt`. Wygaśnięcie
   unieważnia `Create`, ale nie oznacza jeszcze zwolnienia quota: workflow
   przechodzi do `EXPIRE_REQUESTED`, wykonuje DELETE i czeka na GET 404.
8. Aktywna karta może wznowić skan dopiero po potwierdzonym usunięciu. Po
   zamknięciu i ponownym wejściu użytkownik może wznowić skan od trwałego
   kursora; backend nie próbuje sam uruchamiać pętli działającej w przeglądarce.
9. Zamknięcie karty wysyła jedynie best-effort release. Źródłem gwarancji
   sprzątania pozostaje backendowy TTL i Cloud Scheduler, nie zdarzenie
   `beforeunload`.

#### 5.4. Potwierdzenie `Create`

1. Istniejący modal zachowuje wybór: zero, jedna lub wiele aplikacji. Żadna
   aplikacja nie jest instalowana przed utworzeniem i gotowością VM.
2. Kliknięcie `Create` wysyła pojedyncze idempotentne żądanie zawierające
   `scanId`, podpisany kontekst, dokładny endpoint, `hardwareId`, `zone`,
   `reservationName`, `applicationIds` oraz trwały `idempotencyKey`.
3. Backend weryfikuje właściciela, TTL, zgodność wszystkich parametrów,
   istnienie i stan rezerwacji oraz brak innej uruchomionej VM. Nie wykonuje
   kolejnej sondy pojemności GPU.
4. Przyjęty model używa rezerwacji automatycznej i
   `reservationAffinity.consumeReservationType = ANY_RESERVATION`. Projektowa
   blokada nie dopuszcza równoległej pasującej rezerwacji, a backend po
   utworzeniu sprawdza `resourceStatus.reservationConsumptionInfo`. Zapewnia to
   zgodność z obecnym stop/start bez utrzymywania płatnej rezerwacji przez cały
   cykl życia VM. Model `SPECIFIC_RESERVATION` został odrzucony, ponieważ takiej
   rezerwacji nie można usunąć, gdy konsumuje ją działająca VM.
5. `reservations.insert` i `instances.insert` używają trwałych `requestId` UUID
   związanych z `idempotencyKey` oraz deterministycznej nazwy zasobu. Retry
   używa tego samego UUID i nie tworzy duplikatu.
6. Po wysłaniu `instances.insert` skan nie jest już wznawiany. Modal znika, a
   globalny loader przełącza się na `Create`, ale zasoby pozostają chronione aż
   do rozstrzygnięcia operacji.
7. Timeout, 5xx lub utrata odpowiedzi daje `INSERT_UNKNOWN`. Backend nie zwalnia
   endpointu ani rezerwacji, lecz uzgadnia wynik przez operację GCE,
   `instances.get` i `resourceStatus.reservationConsumptionInfo`.
8. Po potwierdzeniu, że działająca VM skonsumowała rezerwację automatyczną,
   backend usuwa obiekt rezerwacji bez zatrzymywania VM i czeka na GET 404.
   Reconciler ponawia cleanup, jeśli odpowiedź jest niejednoznaczna.
9. Błąd przed `instances.insert` lub jednoznaczne odrzucenie zwalnia rezerwację i
   dzierżawę endpointu. Skan pozostaje zakończony z prawdziwym błędem; ponowne
   skanowanie wymaga jawnej decyzji użytkownika, aby uniknąć nieskończonej
   pętli kosztownych prób.

#### 5.5. Anulowanie modala

1. Modal udostępnia osobne akcje: `Create`, `Skip and continue scanning`,
   `Pause scan` oraz `Cancel scan`. Escape działa jak `Pause scan`, nie jak
   automatyczne pominięcie.
2. Każda akcja poza `Create` przełącza wynik do `RELEASE_REQUESTED`, blokuje
   możliwość utworzenia VM i żąda zwolnienia konkretnej rezerwacji.
3. Skan może zostać wznowiony dopiero po potwierdzeniu przez backend, że
   rezerwacja nie istnieje i licznik zarządzanych rezerwacji został
   odświeżony. Sam timeout odpowiedzi nie jest potwierdzeniem zwolnienia.
4. `Skip` kontynuuje od następnej kombinacji. `Pause` pozostawia trwały stan
   `PAUSED`, a `Cancel scan` kończy workflow. TTL nie może nadpisać wcześniej
   wybranej pauzy ani anulowania.
5. Jeśli release się nie powiedzie, modal pozostaje widoczny, a GUI jest w
   bezpiecznym stanie
   `release pending`, pokazuje błąd i udostępnia ponowienie lub globalne
   `Release All GPU Reservations`; nie wznawia skanu równolegle.

### 6. UX i dostępność

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
5. W trybie automatycznym znaleziony i utrzymywany wynik jest wyraźnie
   odróżniony od historycznych wyników, których rezerwacje zostały zwolnione.
6. `Pause Scan and Release Reservations` oraz `Cancel Scan and Release
   Reservations` zachowują pierwszeństwo: zamykają modal, unieważniają jego
   przyciski i czekają na potwierdzone sprzątnięcie.
7. Odświeżenie strony odtwarza aktywny stan `held_for_create` z backendu dla
   tego administratora albo pokazuje, że rezerwacja wygasła; nie otwiera
   bezwarunkowo drugiego modala i nie uruchamia drugiego skanu.

## Wynik niezależnego audytu planu

Audyt wykonał osobny agent w trybie tylko do odczytu. Za obowiązkowe uznano i
przyjęto następujące korekty:

1. **Model rezerwacji:** odrzucono `SPECIFIC_RESERVATION`, ponieważ nie można
   usunąć jej podczas konsumpcji przez działającą VM, a pozostawienie zmienia
   koszt i zachowanie stop/start. Plan używa automatycznej rezerwacji,
   `ANY_RESERVATION`, projektowej wyłączności oraz weryfikacji faktycznej
   konsumpcji przed usunięciem rezerwacji.
2. **Transakcyjny stan:** Secret Manager nie zapewnia CAS. Firestore przejmuje
   workflow, dzierżawy endpointów, generacje, kursory i wynik wyścigów;
   Secret Manager pozostaje wyłącznie rejestrem konfiguracji.
3. **Operacje niejednoznaczne:** timeout lub 5xx po wywołaniu GCE nie oznacza
   porażki. `requestId`, deterministyczne nazwy, stany `*_UNKNOWN` i reconciler
   chronią przed duplikacją oraz przedwczesnym cleanupem.
4. **Projektowy admission control:** blokada obejmuje wszystkie karty,
   administratorów, skany, ręczne Create, działające VM i obce rezerwacje.
   Zatrzymanie pojedynczej pętli JavaScript nie wystarcza przy quota GPU `1`.
5. **TTL i cleanup:** `expiresAt` unieważnia Create, ale quota jest uznana za
   zwolnioną dopiero po GET 404 rezerwacji. Cloud Scheduler działa at-least-once,
   dlatego reconciler i każde sprzątanie są idempotentne.
6. **Semantyka modala:** rozdzielono `Skip`, `Pause` i `Cancel`; Escape oznacza
   Pause. TTL nie może wznowić workflow wbrew trwałej decyzji użytkownika.
7. **Token i sesja:** podpisany token nie zastępuje serwerowej dzierżawy.
   Preferowane jest ponowne uwierzytelnienie w nowej karcie. Jeśli istniejący
   `postMessage` pozostanie, wymaga jednorazowego nonce, kontroli `origin` i
   `source`, krótkiego timeoutu, allowlisty backendu i odłączenia `opener`.
8. **Kanoniczny sprzęt:** rezerwacja i VM powstają z tego samego
   `canonicalReservationShape`, z osobną obsługą attached GPU i typów maszyn z
   GPU wbudowanym.

Nie przyjęto sugestii domyślnego wyłączenia checkboxa, ponieważ użytkownik
jednoznacznie wymaga wartości domyślnie zaznaczonej. Ryzyko kosztowe ogranicza
krótki TTL, widoczna informacja o naliczaniu kosztu, projektowa wyłączność i
potwierdzony cleanup. Globalne `Release All` nie może usuwać rezerwacji należącej
do aktywnego workflow innego administratora bez jawnego potwierdzenia.

Przyjęto również opcjonalne zalecenia: eksperyment GCE przed pełnym wdrożeniem,
etykiety `scanId`, `endpointId`, `workflowGeneration` i `managedBy` bez danych
osobowych, odliczanie oparte na czasie serwera oraz metryki czasu hold, opóźnień
cleanup, `INSERT_UNKNOWN`, konfliktów CAS i zasobów odzyskanych przez reconciler.

## Fazy implementacji

### Faza 1: Kontrakt backendu i testy jednostkowe

1. Wykonaj mały eksperyment GCE dla jednego profilu GPU i quota `1`: rezerwacja
   automatyczna, `ANY_RESERVATION`, konsumpcja, odczyt
   `reservationConsumptionInfo`, usunięcie rezerwacji oraz stop/start VM.
2. Dopiero po potwierdzeniu eksperymentu dodaj Firestore jako trwały
   koordynator workflow, dzierżaw endpointów i admission control.
3. Dodaj automat stanów, warunkowe przejścia `state + generation`, trwałe
   `requestId`, reconciler i walidację `canonicalReservationShape`.
4. Dodaj endpoint przygotowania oraz testy: pierwszy wolny endpoint, brak
   endpointów, równoległe prośby, wygaśnięcie, replay, niezgodny właściciel,
   generacja i para GPU/strefa.

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

### Faza 4: Rezerwacja przekazywana do `Create`

1. Rozszerzyć rekord zarządzanej rezerwacji o właściciela, `scanId`, endpoint,
   stan i TTL oraz udostępnić idempotentne operacje `hold`, `consume`, `release`
   i odtworzenie stanu.
2. Dodać checkbox i automat stanów w GUI, integrując go z istniejącym modalem
   wyboru aplikacji, pauzą, wznowieniem, anulowaniem oraz globalnym loaderem.
3. Rozszerzyć `Create` o walidowany kontekst rezerwacji, `ANY_RESERVATION`,
   trwały `requestId` i weryfikację konsumpcji; wyłączyć dodatkową sondę
   capacity w tej ścieżce.
4. Dodać TTL, odliczanie i sprzątanie przez istniejący harmonogram. Cleanup nie
   może zwolnić rekordu będącego w atomowym przejściu `create_submitted`.
5. Ujednolicić liczniki i komunikaty w GUI, panelu aktywności i endpointach
   administracyjnych.

### Faza 5: E2E i wdrożenie

1. E2E przez zalogowaną przeglądarkę: skan, wynik na żywo, otwarcie linku,
   sprawdzenie ustawionych pól i `Create` dla dostępnej pary.
2. E2E równoległych kart: tylko jedna otrzymuje ten sam endpoint; druga dostaje
   kolejny wolny endpoint albo `NO_FREE_ENDPOINT`.
3. E2E braku wolnych endpointów, anulowania skanu i wygaśnięcia dzierżawy.
4. Przed końcem zwolnij wszystkie testowe rezerwacje GPU, usuń testowe VM,
   uruchom CI, wykonaj deploy i sprawdź produkcyjny GUI.
5. E2E z checkboxem włączonym i quota GPU `1`: pierwsza dostępna para otwiera
   modal bez zwolnienia rezerwacji, `Create` z zerem aplikacji wykorzystuje
   rezerwację i nie wykonuje dodatkowej sondy.
6. E2E z wszystkimi aplikacjami: ten sam przepływ kończy utworzenie VM, a
   istniejący post-create bootstrap raportuje instalacje niezależnie od stanu
   rezerwacji GPU.
7. E2E `Cancel`: rezerwacja zostaje potwierdzenie zwolniona, licznik spada, a
   skan wznawia się od kolejnej pary. Powtórzyć dla Escape, TTL i odświeżenia
   strony.
8. E2E błędów: brak endpointu, konflikt endpointu, wygaśnięta rezerwacja,
   równoległe Cancel/Create, 429/403 quota odczytów, odrzucone
   `instances.insert` i awaria cleanup. W żadnym przypadku nie może zostać
   osierocona rezerwacja ani uruchomić się druga sonda podczas hold.
9. Regresja z checkboxem wyłączonym dla wszystkich metod skanowania oraz
   regresja ręcznego Create CPU/GPU, pause/resume/cancel i linków wyników.
10. Testy awarii obejmują restart Cloud Run pomiędzy każdym przejściem, dwie
    instancje Cloud Run wykonujące równoległy CAS, utratę odpowiedzi po
    `reservations.insert` i `instances.insert`, Cancel podczas tworzenia sondy,
    TTL równoległy z Create oraz wielokrotne wywołanie cleanup.
11. Testy GCE potwierdzają `ANY_RESERVATION`, pełny kształt rezerwacji,
    `resourceStatus.reservationConsumptionInfo`, stop/start, quota globalną i
    regionalną `1`, rezerwację obcą oraz awarię zapisu endpointu po faktycznym
    utworzeniu VM.
12. Odświeżyć GUI w każdym stanie nieterminalnym i sprawdzić replay oraz
    podmianę właściciela, tokenu, endpointu, GPU i strefy.

## Kryteria akceptacji

- Dostępny wynik GPU/strefy pojawia się przed zakończeniem skanu.
- Link w nowej karcie otwiera GUI z poprawnym endpointem, GPU i strefą.
- Dwie karty nie mogą otrzymać tej samej aktywnej dzierżawy endpointu.
- `Create` nie ufa starym wynikom skanu i poprawnie raportuje utratę pojemności.
- Przy włączonym trybie pierwszy wynik zatrzymuje skan, zachowuje rezerwację i
  automatycznie otwiera modal wyboru aplikacji.
- Potwierdzony `Create` konsumuje jedyną dopuszczoną automatyczną rezerwację,
  co jest sprawdzone przez `reservationConsumptionInfo`; przy quota GPU `1`
  nie wykonuje konkurencyjnej sondy.
- `Cancel` zwalnia rezerwację przed wznowieniem skanu, a TTL sprząta wynik po
  opuszczeniu strony lub braku decyzji.
- Zero i wszystkie aplikacje działają tak samo jak w zwykłym modalu Create.
- Brak wolnych endpointów nie wybiera zajętego DNS.
- Każdy zasób w stanie niejednoznacznym jest wykrywany przez reconciler i
  doprowadzany do stanu zgodnego w ustalonym SLO; test potwierdza brak
  dzierżaw, rezerwacji GPU i testowych VM po zakończeniu okna reconcile.
