# Plan: Scan, rezerwacja oraz Create/Start dla dostępnych GPU

## Status dokumentu

Plan obejmuje istniejące wyniki skanowania z linkami `Scan & Create`, wdrożony
przepływ zachowania pierwszej rezerwacji dla `Create` oraz planowane
rozszerzenie pozwalające ponownie uruchomić wybraną zatrzymaną VM na pierwszej
znalezionej, zgodnej karcie GPU. Rozszerzenie ma rozwiązać wyścig, w którym
krótka rezerwacja zostaje zwolniona po sondzie, a GPU nie jest już dostępne,
gdy użytkownik uruchamia `Create` albo `Start`.

## Cel

Podczas każdego skanu pojemności GPU pokazywać wynik dodatni natychmiast po
sprawdzeniu pary `GPU + strefa`. Przy automatycznym hold pierwszy wynik otwiera
właściwy modal z aktywną rezerwacją. Bez automatycznego hold każdy wynik ma
wyłącznie przycisk `Reserve GPU`, aktywowany po pauzie i zwolnieniu sond;
dopiero świeża rezerwacja otwiera modal Create albo Start.

Przy wyłączonym utrzymaniu rezerwacji skan pozostaje testem pojemności, a nie
gwarancją utworzenia lub uruchomienia VM. Przy włączonym utrzymaniu pierwsza
skuteczna rezerwacja GPU pozostaje aktywna, skan zostaje wstrzymany, a wybrana
operacja `Create` albo `Start` ma skonsumować tę konkretną pojemność GCE.

## Założenia i granice

- Dotyczy trzech istniejących przepływów: wybrane GPU/strefy, wszystkie GPU w
  wybranej strefie oraz wszystkie GPU we wszystkich strefach.
- Checkbox `Make reservation after first available GPU` jest domyślnie zaznaczony i
  dotyczy każdego skanu wykonującego rzeczywistą próbę rezerwacji GPU. Nie
  zmienia operacji CPU ani wyłącznie katalogowych filtrów zgodności.
- Checkbox `Start selected VM after first available GPU` jest domyślnie
  odznaczony i aktywny wyłącznie po wybraniu zarządzanej instancji GPU w stanie
  `TERMINATED`. Nie jest zapisywany między sesjami ani automatycznie włączany.
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
   zewnętrznego IP. Moment jej utworzenia zależy od operacji i trybu zgodnie z
   macierzą endpointów w sekcji 6.1.
4. Dla automatycznego Create brak wolnego endpointu zwraca `NO_FREE_ENDPOINT`
   przed rozpoczęciem sond GPU. Dla ręcznego `Reserve GPU` Create kontrola
   następuje przed rezerwacją. Start nigdy nie wybiera wolnej domeny, lecz
   blokuje endpoint źródłowej VM.
5. Wszystkie operacje `prepare`, `consume`, `release` i cleanup używają
   transakcji lub warunku `state + generation`. Podpisany token zawiera
   nieprzewidywalne `leaseId`, ale podpis jest tylko ochroną integralności;
   jednokrotność i unieważnienie wynikają z rekordu Firestore.
6. Cykliczny reconciler czyści wygasłe dzierżawy, uzgadnia je z rzeczywistym
   stanem GCE i zapisuje zdarzenia w historii aktywności.

### 3. Wynik skanu i jawna rezerwacja

1. Przy odznaczonym `Make reservation after first available GPU` dodatni wynik
   nie udostępnia bezpośredniego linku Create ani Start. Wiersz wyniku zawiera
   GPU, strefę, czas wykrycia i przycisk `Reserve GPU`.
2. Podczas aktywnego skanowania przycisk jest widoczny, ale disabled, ponieważ
   bieżąca sonda może zużywać quota GPU. Opis wskazuje: `Pause scan and release
   probe reservations before reserving this result`.
3. Po pauzie oraz potwierdzeniu braku zarządzanych rezerwacji sond przyciski
   wyników zostają aktywowane. Kliknięcie zawsze tworzy świeżą rezerwację;
   wcześniejszy wynik capacity nie jest traktowany jako gwarancja.
4. Dla Create backend najpierw atomowo przygotowuje wolny endpoint, następnie
   rezerwuje dokładne `hardwareId + zone`. Dla Start używa endpointu wybranej
   źródłowej VM i sprawdza, że jego przypisanie się nie zmieniło.
5. Dopiero stan `HELD` otwiera właściwy modal: wybór aplikacji dla Create albo
   potwierdzenie Start/migracji dla wybranej VM. Ten sam `reservationName` jest
   przekazywany do dalszego workflow.
6. Nieudana rezerwacja ustawia wynik na `Unavailable now`, pokazuje prawdziwy
   błąd GCE i pozwala ponowić próbę z kontrolowanym cooldownem albo wybrać inny
   wynik. Nie uruchamia Create, Start ani migracji.
7. Stare parametry linków do przygotowanych wyników pozostają walidowane dla
   zgodności wstecznej, ale nowe skany w tym trybie ich nie generują.

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

### 5. Tryb `Make reservation after first available GPU`

#### 5.1. Sterowanie w GUI

1. Obok kontrolek skanowania utrzymywać checkbox `Make reservation after first available GPU`,
   domyślnie zaznaczony po pierwszym wejściu. Jawna zmiana użytkownika może być
   zachowana w `localStorage`, ale parametr linku ani poprzedni nieukończony
   skan nie może sam włączyć trybu.
2. Przy odznaczonym checkboxie wyniki pojawiają się na żywo, a rezerwacje sond
   są zwalniane. Wynik nie prowadzi bezpośrednio do `Scan & Create`; pokazuje
   przycisk `Reserve GPU`, który jest aktywny dopiero po pauzie skanu i
   potwierdzonym zwolnieniu wszystkich sond.
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
7. Workflow rozdziela `decisionExpiresAt` od `operationDeadline`.
   `decisionExpiresAt` jest krótkie, np. 5 minut, i ogranicza oczekiwanie na
   decyzję w modalu. Po zatwierdzeniu Create/Start backend atomowo przejmuje
   workflow i ustawia dłuższy, twardy `operationDeadline` odpowiedni dla
   migracji. Tylko backend może odnawiać heartbeat aktywnej operacji; nie może
   przesuwać twardego deadline. Po nim reconciler rozstrzyga operacje GCE i
   wykonuje cleanup. Samo wygaśnięcie nie oznacza zwolnienia quota: wymagany
   jest potwierdzony GET 404 rezerwacji.
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

### 6. Ponowne uruchomienie wybranej VM na znalezionej karcie

#### 6.1. Semantyka kontrolek GUI

1. Dodać checkbox `Start selected VM after first available GPU`, domyślnie
   odznaczony. Jest disabled, dopóki użytkownik nie wybierze karty w sekcji
   `Created instances`.
2. Po wybraniu instancji checkbox jest aktywny tylko wtedy, gdy VM jest
   zarządzana przez aplikację, ma GPU, znajduje się w stanie `TERMINATED`, nie
   ma aktywnej akcji ani migracji i wszystkie wymagane dyski są dostępne.
   W przeciwnym przypadku obok kontrolki pokazać konkretną przyczynę.
3. Odznaczenie wyboru, usunięcie VM, zmiana jej stanu lub wybranie innej VM
   automatycznie odznacza tryb. Checkbox nie może pozostać aktywny dla starego
   obiektu po odświeżeniu `Created instances`.
4. Po włączeniu trybu `Hardware` zostaje ustawiony i zablokowany na dokładnym
   profilu źródłowej VM: machine type, GPU type/count, accelerator mode,
   minimum CPU platform i pozostałe cechy wpływające na konsumpcję rezerwacji.
   Pierwsza wersja nie traktuje T4, T4 vWS, L4 i L4 vWS jako zamienników.
5. `GPU scan scope` nadal określa obszar wyszukiwania. Skanery, które szukają
   innych typów GPU niż profil źródłowy, są disabled w trybie Start z czytelnym
   wyjaśnieniem; podstawowym przepływem jest skan wybranego GPU po zgodnych
   strefach.
6. Checkbox `Make reservation after first available GPU` (przemianowany z
   `Create after first available GPU`) pozostaje niezależny od checkboxa
   wybierającego operację Start. Jego stan rozdziela dwa warianty opisane
   poniżej; nie zmienia wybranej źródłowej VM ani jej profilu sprzętowego.
7. Pod checkboxem pokazać opis: `When disabled, pause the scan and reserve a
   selected result manually.` Pełna macierz zachowania:

   | Start selected VM | Make reservation | Wynik |
   |---|---|---|
   | nie | zaznaczony | pierwszy wynik jest utrzymany i otwiera modal Create |
   | nie | odznaczony | wyniki mają `Reserve GPU`; sukces otwiera modal Create |
   | tak | zaznaczony | pierwszy zgodny wynik jest utrzymany i otwiera modal Start |
   | tak | odznaczony | wyniki mają `Reserve GPU`; sukces otwiera modal Start |

8. Macierz endpointów jest niezależna od sposobu prezentacji wyniku:

   | Operacja | Automatyczny hold | Endpoint |
   |---|---|---|
   | Create | tak | dzierżawa wolnego endpointu przed pierwszą sondą |
   | Create | nie | dzierżawa podczas kliknięcia `Reserve GPU` |
   | Start | tak lub nie | blokada endpointu źródłowej VM; bez wyboru wolnego DNS |

#### 6.2. Start z zachowaniem pierwszej rezerwacji

1. Gdy zaznaczone są `Start selected VM after first available GPU` oraz
   `Make reservation after first available GPU`, pierwszy dodatni wynik dla
   dokładnego profilu GPU zatrzymuje skan i pozostawia rezerwację w stanie
   `HELD`.
2. GUI automatycznie otwiera osobny modal Start. Pokazuje nazwę źródłowej VM,
   zarezerwowaną kartę, strefę, endpoint DNS, pozostały TTL rezerwacji oraz
   informację `Start in current zone` albo `Migrate and start`.
3. Modal ma główny przycisk `Start reserved VM` dla tej samej strefy albo
   `Migrate and start reserved VM` dla innej strefy. Nie pokazuje wyboru
   aplikacji, ponieważ oprogramowanie znajduje się już na dyskach VM.
4. Rezerwacja nie jest zwalniana pomiędzy sondą, modalem, ewentualną migracją i
   operacją Start. Ten sam rekord workflow i `reservationName` są przekazywane
   przez wszystkie etapy aż do potwierdzonej konsumpcji przez docelową VM.
5. Zamknięcie modala, `Skip`, `Pause` albo `Cancel` nie może pozostawić ukrytej
   rezerwacji. Najpierw przełącza workflow do `RELEASE_REQUESTED`, czeka na
   potwierdzony GET 404, a dopiero potem wznawia lub kończy skan.

#### 6.3. Start z wyniku skanu bez zachowania pierwszej rezerwacji

1. Gdy zaznaczony jest `Start selected VM after first available GPU`, ale
   `Make reservation after first available GPU` pozostaje odznaczony, skan
   działa dalej po wynikach dodatnich, a każda rezerwacja sondy jest od razu
   zwalniana.
2. Znalezione pary GPU/strefa pojawiają się na żywo z przyciskiem `Reserve GPU`,
   ale przycisk pozostaje disabled podczas skanowania. Nie jest prezentowany
   link ani akcja bezpośredniego Start.
3. Po `Pause Scan and Release Reservations` i potwierdzeniu licznika rezerwacji
   równego zero użytkownik może kliknąć `Reserve GPU` przy wybranym wyniku.
4. Przycisk wykonuje nową, atomową próbę rezerwacji dla wybranej pary. Dopiero
   po stanie `HELD` otwiera modal Start pokazujący, czy będzie to zwykły Start,
   czy migracja i Start. Historyczny dodatni wynik nie gwarantuje capacity.
5. Jeżeli rezerwacja nie jest już możliwa, źródłowa VM pozostaje bez zmian,
   wiersz wyniku i główny obszar komunikatów pokazują prawdziwy błąd GCE, a
   użytkownik może ponowić próbę, wybrać inny wynik albo wznowić skan.

#### 6.4. Walidacja źródłowej VM

1. Przed skanem backend odczytuje VM bezpośrednio z GCE, a nie ufa wyłącznie
   danym z przeglądarki. Zapisuje jej `instanceId`, nazwę, strefę, status,
   fingerprint metadanych, dyski, endpoint i kanoniczny kształt sprzętu.
2. Backend odrzuca workflow, jeżeli źródło nie jest `TERMINATED`, ma aktywną
   operację, korzysta z Local SSD bez jawnej obsługi utraty danych, nie ma
   kompletnego zestawu dysków albo jego endpoint jest przypisany innej VM.
3. Bezpośrednio przed zachowaniem rezerwacji oraz przed Start/cutover backend
   ponownie sprawdza `instanceId`, status i konfigurację. Zmiana źródła w innej
   karcie przerywa operację bez usuwania VM.
4. Kanoniczny kształt rezerwacji jest wyliczany z rzeczywistej VM i porównywany
   z katalogiem sprzętu. Rozbieżność jest błędem wymagającym jawnego
   odświeżenia profilu, a nie cichym podstawieniem wartości domyślnych.

#### 6.5. Znaleziona pojemność w tej samej strefie

1. Udana rezerwacja musi dokładnie odpowiadać właściwościom zatrzymanej VM.
   Backend zapewnia, że jej `reservationAffinity` pozwala konsumować pasującą
   rezerwację automatyczną; starsza VM wymagająca aktualizacji affinity jest
   przygotowywana przed skanem, gdy pozostaje `TERMINATED`.
2. Przed implementacją wymagany jest eksperyment GCE aktualizacji
   `reservationAffinity` istniejącej `TERMINATED` VM, osobno dla attached GPU i
   machine type z GPU wbudowanym. Jeśli aktualizacja nie jest obsługiwana,
   lokalny Start używa potwierdzonej domyślnej affinity albo odtwarza VM z tych
   samych dysków; nie wolno zakładać mutowalności tej właściwości.
3. Po potwierdzeniu użytkownika workflow przechodzi przez
   `HELD -> START_CLAIMED -> START_PENDING -> VM_CONFIRMED -> COMPLETED` i
   używa trwałego `requestId`, aby ponowienie nie wysłało dwóch operacji Start.
4. Po osiągnięciu `RUNNING` backend sprawdza
   `resourceStatus.reservationConsumptionInfo`, a następnie usuwa zarządzaną
   rezerwację i czeka na GET 404. Brak potwierdzonej konsumpcji jest błędem,
   nawet jeśli VM przypadkowo wystartowała z ogólnej pojemności.
5. GUI używa istniejącego loadera Start i pokazuje etapy: rezerwacja,
   uruchamianie VM, konsumpcja rezerwacji, start usług i sprzątanie rezerwacji.
   Modal aplikacji nie jest wyświetlany, bo aplikacje należą już do dysków VM.

#### 6.6. Znaleziona pojemność w innej strefie

1. VM i Persistent Disk są strefowe, dlatego nie wolno wykonywać zwykłego
   `Start` z innym parametrem `zone`. Operacja jest bezpiecznym
   `copy-then-cutover`: źródło pozostaje nietknięte do potwierdzenia celu.
2. Implementacja współdzieli niskopoziomowe kroki istniejącej manualnej
   migracji `TERMINATED` VM: walidację, snapshoty, odtwarzanie dysków, liczniki
   i cleanup. Publiczne `copy` i `move` zachowują dotychczasową semantykę.
   Automatyczny przepływ używa osobnej operacji `RELOCATE_AND_START`, której
   kontrakt od początku przewiduje zachowanie endpointu i usunięcie źródła
   dopiero po cutover.
3. Skan zawsze sprawdza najpierw strefę źródłową. Jeśli zakres obejmuje inne
   strefy i lokalna sonda nie znalazła capacity, skan zostaje wstrzymany,
   backend tworzy spójny zestaw tymczasowych snapshotów, a potem kontynuuje
   pozostałe strefy. Jeśli zakres nie obejmuje źródła, snapshoty powstają przed
   pierwszą sondą. To ogranicza czas płatnego hold podczas późniejszej relokacji.
4. Po znalezieniu innej strefy i zachowaniu rezerwacji `RELOCATE_AND_START`
   odtwarza docelowe dyski oraz zgodną VM w stanie `TERMINATED`, po czym
   uruchamia ją przez `ANY_RESERVATION`.
5. Po zatwierdzeniu modala backend przechodzi z krótkiego `decisionExpiresAt`
   do ograniczonego `operationDeadline`. Heartbeat backendu działa tylko w
   stanach aktywnej relokacji; utrata sesji przeglądarki nie zatrzymuje
   workflow ani nie usuwa twardego limitu czasu.
6. Sukces jest podzielony na trzy poziomy. Infrastruktura wymaga `RUNNING`,
   potwierdzonej konsumpcji rezerwacji i właściwych dysków. Agent wymaga nowego
   boot ID oraz zgodnej tożsamości docelowej VM w metadanych. Sunshine,
   Minecraft i inne usługi są raportowane informacyjnie i nie blokują cutover,
   jeśli zgodnie z konfiguracją mogą być wyłączone lub niezainstalowane.
7. Endpoint pozostaje zablokowany przez CAS na
   `sourceInstanceId + workflowId`. Target nie może publikować DuckDNS przed
   cutover. Po sukcesie infrastruktury i agenta transakcja CAS zmienia
   logicznego właściciela endpointu; dopiero wtedy target publikuje DNS, a
   źródło może zostać usunięte. Po zatwierdzonym cutover nie wykonuje się
   automatycznego rollbacku DNS do źródła.
8. Niepowodzenie przed cutover usuwa wyłącznie niekompletny cel, jego dyski,
   rezerwację i snapshoty; źródłowa VM oraz przypisanie DNS pozostają bez
   zmian. Niepowodzenie po cutover przechodzi do stanu wymagającego reconcile,
   a nie automatycznego usuwania obu kopii.
9. Wszystkie snapshoty tymczasowe są usuwane po jednoznacznym sukcesie lub
   błędzie. Stan niejednoznaczny zachowuje je do czasu rozstrzygnięcia przez
   reconciler, po czym wykonuje cleanup.
10. Jawny automat relokacji to:
    `HELD -> RELOCATION_CLAIMED -> SNAPSHOTS_PENDING -> DISKS_PENDING ->
    TARGET_PENDING -> START_PENDING -> TARGET_CONFIRMED -> CUTOVER_PENDING ->
    CUTOVER_COMMITTED -> SOURCE_CLEANUP -> COMPLETED`. Każdy etap GCE ma stan
    `*_UNKNOWN`, deterministyczną nazwę zasobu i osobny trwały `requestId`.
    Retry najpierw uzgadnia rzeczywisty stan zasobu, nigdy nie powtarza operacji
    w ciemno.

#### 6.7. Workflow, współbieżność i anulowanie

1. Rekord Firestore dostaje `operation=CREATE_NEW|START_EXISTING`,
   `sourceInstanceId`, `sourceZone`, `targetZone`, `canonicalShape`, endpoint,
   snapshoty, zasoby docelowe, generację i trwałe `requestId` każdej operacji.
2. Projektowy admission control nadal dopuszcza tylko jeden workflow
   konsumujący GPU. Dodatkowo blokada źródłowej VM uniemożliwia równoległy
   Start, migrację, Delete lub drugi skan tej samej instancji.
3. Licznik rezerwacji w GUI jest wyłącznie informacyjny. Każde kliknięcie
   `Reserve GPU` atomowo zdobywa projektowy admission lock, ponownie odczytuje
   aktywne workflow oraz rezerwacje GCE, w tym obce, i dopiero potem tworzy
   rezerwację. Wartość licznika nigdy nie jest warunkiem bezpieczeństwa.
4. Przy braku utrzymywanej rezerwacji akcja wyniku jest dostępna dopiero po
   pauzie skanu i potwierdzonym zwolnieniu wszystkich sond. Start ponownie
   waliduje źródło i tworzy świeżą rezerwację, wyraźnie komunikując, że wynik
   historyczny nie gwarantuje capacity. Przy aktywnej rezerwacji modal jest
   dostępny dopiero po potwierdzonym `HELD`.
5. `Pause`, `Skip`, `Cancel`, wygaśnięcie i `Release All` nie mogą usuwać
   źródłowej VM. Zwalniają rezerwację oraz niepotrzebne snapshoty dopiero po
   rozstrzygnięciu operacji GCE; skan wznawia się po potwierdzonym GET 404.
6. Nadal obowiązuje globalna zasada jednej uruchomionej VM. Przed Start backend
   wymaga zatrzymania innej działającej instancji na podstawie istniejącego
   mechanizmu potwierdzenia administratora.

### 7. UX i dostępność

1. Wiersz wyniku zawiera GPU, strefę z nazwą miasta, czas znalezienia, stan
   świeżości oraz przycisk `Reserve GPU`. DNS jest pokazywany po przygotowaniu
   endpointu dla Create albo pochodzi z wybranej źródłowej VM dla Start.
2. `Reserve GPU` jest disabled podczas skanu, procesu release i innej próby
   rezerwacji. Stany przycisku to `Reserve GPU`, `Reserving...`, `Reserved` i
   `Unavailable`; kolor nie może być jedynym nośnikiem informacji.
3. `Pause` zachowuje historyczne wyniki, ale nie utrzymuje rezerwacji sond ani
   dzierżaw endpointów bez modala w stanie `HELD`. `Cancel Scan and Release
   Reservations` unieważnia wyniki operacyjne i zwalnia wszystkie zasoby
   workflow po rozstrzygnięciu operacji GCE.
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

### Audyt rozszerzenia Start i ręcznego Reserve GPU

Drugi niezależny audyt wykonano po rozszerzeniu planu o ponowne uruchamianie
wybranej VM. Przyjęto następujące korekty:

1. Rozdzielono krótki `decisionExpiresAt` od twardego `operationDeadline` i
   ograniczono heartbeat do backendu oraz aktywnych stanów workflow.
2. Dodano kompletny automat `RELOCATE_AND_START`, stany `*_UNKNOWN`, trwałe
   request IDs, deterministyczne zasoby i obowiązkowy reconcile przed retry.
3. Endpoint jest blokowany przez `sourceInstanceId + workflowId`; target nie
   publikuje DNS przed transakcyjnym cutover i nie wykonuje automatycznego
   rollbacku DNS po zatwierdzonym przejęciu.
4. Publiczne `copy` i `move` nie zmieniają semantyki. Nowa operacja współdzieli
   ich niskopoziomowe kroki, ale ma osobny kontrakt `RELOCATE_AND_START`.
5. Usunięto nowe linki operacyjne z wyników bez hold. Pozostaje wyłącznie
   `Reserve GPU`; Pause zachowuje dane historyczne, a Cancel sprząta workflow.
6. Ustalono macierz endpointów dla Create/Start i automatycznego/ręcznego hold.
7. Licznik GUI pozostaje informacyjny; decyzję chroni atomowy admission lock i
   ponowny odczyt GCE.
8. Dodano obowiązkowy eksperyment mutowalności `reservationAffinity` dla
   attached GPU i GPU wbudowanego.
9. Zachowano wymaganą nazwę `Make reservation after first available GPU`, ale
   dodano opis ręcznego Reserve oraz macierz czterech kombinacji checkboxów.
10. Snapshoty powstają dopiero po nieudanej sondzie strefy źródłowej, jeśli
    skan ma przejść do innych stref, albo przed skanem, gdy źródło jest poza
    zakresem.
11. Sukces infrastruktury, agenta i usług ma osobne kryteria; status usług nie
    blokuje poprawnego cutover.

Nie przyjęto propozycji zmiany etykiety na `Automatically reserve first
available GPU`, ponieważ użytkownik wskazał nazwę `Make reservation after first
available GPU`. Niejednoznaczność usuwa tekst pomocniczy i macierz zachowania.

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

1. Zachowaj obsługę starszych parametrów linku i ich walidację, ale nowe wyniki
   bez aktywnej rezerwacji obsługuj przyciskiem `Reserve GPU`.
2. Rozszerz `Create` o opcjonalne przygotowanie oraz atomowe zużycie po stronie
   backendu.
3. Testy: otwarcie linku, poprawne wypełnienie endpointu/GPU/strefy, usunięty
   endpoint, wygasła dzierżawa i konflikt dwóch kart.

### Faza 3: Wyniki na żywo podczas skanów

1. Dodaj wspólny model wyników do wszystkich trzech skanerów.
2. Renderuj wynik dodatni natychmiast i dodaj nieaktywny podczas skanu przycisk
   `Reserve GPU`; endpoint przygotowuj dopiero przy próbie rezerwacji Create.
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

### Faza 5: Rezerwacja przekazywana do `Start`

1. Dodać rozdzielony model celu `CREATE_NEW|START_EXISTING`, walidację wybranej
   karty `Created instances` oraz nietrwały checkbox trybu Start.
2. Dodać ścieżkę tej samej strefy: przygotowanie reservation affinity,
   idempotentny Start, potwierdzenie konsumpcji i cleanup.
3. Rozszerzyć i wywołać istniejącą manualną migrację terminated VM w trybie
   copy-then-cutover, przekazując zachowaną rezerwację oraz zachowując pełny
   rollback przed cutover. Wspólne kroki migracji pozostają jednym kodem.
4. Dodać stan Firestore, blokadę źródła, cleanup snapshotów i reconciliation
   wszystkich timeoutów oraz operacji `*_UNKNOWN`.
5. Dodać loader i modal potwierdzenia pokazujące źródło, cel, DNS, koszt,
   migrację między strefami i moment nieodwracalnego cutover.

### Faza 6: E2E i wdrożenie

1. E2E przez zalogowaną przeglądarkę: skan, wynik na żywo, pauza, `Reserve GPU`,
   sprawdzenie modala i `Create` dla dostępnej pary.
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
13. Regresja nowego checkboxa: brak wyboru, CPU, RUNNING, STOPPING, TERMINATED,
    usunięcie wybranej VM i przełączenie między kartami `Created instances`.
14. E2E Start w strefie źródłowej: hold, start, potwierdzona konsumpcja,
    gotowość Sunshine i licznik rezerwacji równy zero.
15. E2E Start w innej strefie: snapshoty, dyski, instancja docelowa, cutover
    endpointu, usunięcie źródła i pełny cleanup. Osobno zasymulować błąd na
    każdym etapie i potwierdzić, że źródło pozostaje używalne przed cutover.
16. E2E bez utrzymywania rezerwacji: link Start działa jak ponowna próba bez
    gwarancji capacity i nie przedstawia historycznego wyniku jako aktywnej
    rezerwacji.
17. E2E z utrzymaniem rezerwacji: pierwszy wynik otwiera modal zawierający
    właściwą VM, GPU i strefę; identyczny `reservationName` przechodzi od
    `HELD`, przez migrację opcjonalną i Start, do potwierdzonej konsumpcji oraz
    cleanupu.
18. E2E bez utrzymania rezerwacji: wyniki pojawiają się podczas skanu, lecz są
    nieaktywne; po Pause i liczniku zero można wybrać wynik, a Start tworzy nową
    rezerwację. Zasymulować zarówno sukces, jak i utratę capacity przed Start.
19. Oba warianty wykonać dla strefy źródłowej bez migracji i dla innej strefy z
    użyciem istniejącej migracji `copy`, pozostawiając źródło nienaruszone przy
    każdym błędzie przed cutover.
20. Zasymulować utratę odpowiedzi po `CUTOVER_PENDING` i po
    `CUTOVER_COMMITTED`; reconciler musi jednoznacznie ustalić właściciela DNS i
    nie może automatycznie cofnąć zatwierdzonego cutover.
21. Zasymulować błąd publikacji DuckDNS po CAS endpointu. Źródło nie może zostać
    usunięte bez zapisanego stanu naprawczego, a retry DNS musi być idempotentny.
22. Przetestować wygaśnięcie `decisionExpiresAt` w modalu oraz przekroczenie
    `operationDeadline` podczas wolnego odtwarzania dysków. W obu przypadkach
    reconciler ma doprowadzić zasoby do jednoznacznego stanu bez osieroconej
    rezerwacji.
23. Po relokacji wariantów vWS potwierdzić zachowanie właściwego typu GPU,
    machine type, obrazu, licencji, metadanych sterownika i konfiguracji
    Sunshine.
24. Dwóch administratorów równocześnie klika `Reserve GPU` dla tego samego i
    różnych wyników; tylko jeden workflow może zdobyć projektowy admission lock
    przy quota GPU równej 1.
25. Odświeżyć lub zamknąć kartę w każdym stanie automatu relokacji, a następnie
    potwierdzić poprawne odtworzenie loadera, działań dostępnych użytkownikowi i
    dalszą pracę backendowego workflow.
26. Powtórzyć identyczne żądanie po timeoutach każdego wywołania GCE i
    potwierdzić brak zduplikowanych snapshotów, dysków, VM, operacji Start,
    przypisań endpointu i cleanupów.

## Kryteria akceptacji

- Dostępny wynik GPU/strefy pojawia się przed zakończeniem skanu, ale nie daje
  bezpośredniej akcji Create ani Start bez aktywnej rezerwacji.
- Przy odznaczonym automatycznym hold przycisk `Reserve GPU` jest disabled do
  czasu pauzy i potwierdzonego zwolnienia sond; sukces otwiera właściwy modal z
  poprawnym endpointem, GPU i strefą.
- Dwie karty nie mogą otrzymać tej samej aktywnej dzierżawy endpointu.
- `Create` nie ufa starym wynikom skanu i poprawnie raportuje utratę pojemności.
- Przy włączonym trybie pierwszy wynik zatrzymuje skan, zachowuje rezerwację i
  automatycznie otwiera modal wyboru aplikacji.
- Potwierdzony `Create` konsumuje jedyną dopuszczoną automatyczną rezerwację,
  co jest sprawdzone przez `reservationConsumptionInfo`; przy quota GPU `1`
  nie wykonuje konkurencyjnej sondy.
- `Cancel` zwalnia rezerwację przed wznowieniem skanu, a TTL sprząta wynik po
  opuszczeniu strony lub braku decyzji.
- Nowy checkbox jest disabled bez poprawnie wybranej zatrzymanej VM GPU i nie
  zachowuje się po zmianie lub usunięciu źródła.
- Start w tej samej strefie konsumuje zachowaną rezerwację, a Start w innej
  strefie wykonuje copy-then-cutover bez ryzyka utraty źródła przed
  potwierdzeniem celu.
- W trybie zachowania pierwszej rezerwacji modal pokazuje rzeczywiście
  utrzymywaną parę GPU/strefa, a rezerwacja nie znika przed Start ani podczas
  migracji.
- W trybie bez zachowania rezerwacji wybór wyniku jest możliwy dopiero po
  pauzie i zwolnieniu sond, a Start nie ufa historycznej dostępności i wykonuje
  nową próbę rezerwacji.
- Żaden błąd, timeout ani Cancel nie usuwa źródłowej VM przed jednoznacznym
  cutover; snapshoty i niekompletne zasoby są finalnie sprzątane przez
  idempotentny reconciler.
- Zero i wszystkie aplikacje działają tak samo jak w zwykłym modalu Create.
- Brak wolnych endpointów nie wybiera zajętego DNS.
- Każdy zasób w stanie niejednoznacznym jest wykrywany przez reconciler i
  doprowadzany do stanu zgodnego w ustalonym SLO; test potwierdza brak
  dzierżaw, rezerwacji GPU i testowych VM po zakończeniu okna reconcile.
