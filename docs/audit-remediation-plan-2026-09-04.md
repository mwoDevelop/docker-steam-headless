# Plan usuniecia usterek po audycie z 2026-09-04

Status: **REVIEWED - poprawiony po niezaleznym review, przyjety do realizacji**

## Wynik niezaleznego review

Review zakonczylo sie werdyktem `NO-GO` dla pierwszego draftu. Przyjeto
zalecenia dotyczace operacji GCE trwajacej dluzej niz dzierzawa, wszystkich
bocznych sciezek startu, wyscigu DNS, lost update rejestru endpointow,
bezpiecznego rollout/rollbacku i rzeczywistych testow wspolbieznosci.

Nie przyjeto pelnej migracji konfiguracji endpointow i migracji z Secret
Managera do Firestore w tym wydaniu. Jest to osobna zmiana modelu danych.
Aktualny rejestr pozostaje kompatybilny, ale kazdy jego zapis otrzyma generacje
i bedzie wykonywany pod wspolnym koordynatorem lifecycle; GET-y przestana go
mutowac. Pozwala to zamknac potwierdzone bledy bez niekontrolowanej migracji.

## Cel

Usunac potwierdzone rozbieznosci pomiedzy zalozeniami architektury, backendem,
rejestrem endpointow, DuckDNS, wdrozeniem Cloud Run i statycznym GUI bez
naruszania danych dwoch zatrzymanych VM ani zasobow `auchan-*` we wspoldzielonym
projekcie `docker-414215`.

## Stan bazowy

- Galaz `master`, HEAD `20a7f60`, repozytorium czyste i zgodne z
  `origin/master`.
- Cloud Run `steam-vm-control-api`, rewizja `00355-79z`, 100% ruchu.
- VM `steam-mwo-vm1-cpu-europe-central2-c` i
  `steam-mwo-vm2-t4-europe-central2-c` sa `TERMINATED`.
- Nie ma statycznych adresow IP, snapshotow ani custom images.
- Rejestr `steam-vm-control-endpoints` przechowuje stary efemeryczny adres dla
  `mwo-vm1` i `mwo-vm2`; wszystkie trzy domeny DuckDNS nadal rozwiazuja sie do
  historycznych adresow.
- Aktualny kod ma routy `/healthz` i `/api/healthz`, ale wdrozona rewizja zwraca
  404 dla `/healthz`, co wskazuje na dryf wdrozenia.

## Niezmienne zasady bezpieczenstwa

1. Nie odczytywac ani nie logowac wartosci sekretow poza kontrolowanym,
   zredagowanym przetwarzaniem rejestru endpointow i tokenu DuckDNS.
2. Nie usuwac VM, dyskow ani danych uzytkownika.
3. Nie uruchamiac VM GPU w tym zakresie.
4. Zasoby `auchan-*` sa poza zakresem.
5. Kazdy test, ktory uruchomi VM CPU, ma zapisac stan bazowy i przywrocic
   `TERMINATED` w `finally`.
6. Nie przesuwac ruchu Cloud Run przed przejsciem testow kandydata.

## Implementacja

### 1. Atomowy koordynator lifecycle jednej VM

1. Zachowac istniejace `ensure_no_other_running_instances_or_stop()` jako
   walidacje stanu i obsluge jawnego potwierdzenia zatrzymania innej VM.
2. Dodac trwaly rekord `managed-vm-admission` w kolekcji Firestore
   `vm-control-locks`, zawierajacy `operationId`, token wlasciciela, generacje,
   komende, endpoint, cel, stan, heartbeat i stabilny GCE `requestId`.
3. Stany koordynatora to co najmniej `ACQUIRED`, `MUTATING`, `UNKNOWN`,
   `RECONCILING`, `COMPLETED` i `FAILED`. Timeout klienta nie oznacza
   automatycznego zwolnienia operacji.
4. Dzierzawe pozyskiwac transakcyjnie przed kazda sciezka zmieniajaca lifecycle.
   Aktywna operacja zwraca HTTP 409. Wygasly heartbeat nie pozwala na przejecie,
   dopoki reconciler nie odczyta stanu GCE i nie zakonczy albo nie wznowi
   poprzedniego `operationId`.
5. Wszystkie mutacje GCE uzywaja stabilnego `requestId` wyprowadzonego z
   `operationId`. Ponowienie requestu nie moze utworzyc drugiej VM.
6. Petle oczekiwania na GCE odnawiaja heartbeat. Wyjatek po zaakceptowaniu
   mutacji zapisuje `UNKNOWN`, a nie zwalnia blokady w ciemno.
7. Zwolnienie lub zakonczenie rekordu jest transakcyjne i dozwolone tylko dla
   aktualnego tokenu oraz generacji, co blokuje ABA i starego wlasciciela.
8. Wewnatrz koordynatora ponownie pobrac liste VM i wywolac
   `ensure_no_other_running_instances_or_stop()` bezposrednio przed mutacja GCE.
   Inna zarzadzana VM w dowolnym stanie innym niz `TERMINATED` blokuje operacje
   albo musi zostac jawnie zatrzymana i w pelni rozliczona.
9. Objac mechanizmem `create`, oba warianty create-start, `start`, `restart`,
   materializacje migracji, `relocate-start`, `stop`, `delete` i automatyczne
   zatrzymanie. Awaryjny stop zapisuje `cancelRequested`, zamiast omijac stan.
10. Zinwentaryzowac wszystkie wywolania Compute `insert`, `/start`, `/stop` i
    `delete`, lacznie z `deploy-gce.sh`, `vm-ctl.sh` i legacy workflow. Skrypty
    operujace na zarzadzanej flocie maja jawnie przejsc przez API albo wymagac
    flagi break-glass i ostrzezenia, ze omijaja koordynator.
11. Ustalona kolejnosc blokad: istniejacy workflow GPU jest pozyskiwany przed
    koordynatorem lifecycle, ale zadna blokada nie czeka na druga. Konflikt
    zwraca 409, co zapobiega deadlockowi.
12. `status` i inne GET-y pozostaja tylko do odczytu.

### 2. Efemeryczne IP i DuckDNS

1. Rozszerzyc aktualizacje DuckDNS o jawna operacje `clear=true`, z retry,
   timeoutem i redakcja tokenu w bledach.
2. Po potwierdzonym `TERMINATED` albo usunieciu VM wyczyscic DNS tylko dla
   endpointu w trybie `ephemeral`. Rekord recznie zarezerwowanego statycznego IP
   pozostaje bez zmian.
3. GET `status` nie moze czyscic DNS. Naprawa starszego stanu trafia do
   uwierzytelnionego reconciler endpointow wywolywanego po mutacji i przez
   Scheduler.
4. Kazdy endpoint dostaje `generation`, `desiredState`, `desiredIp`,
   `dnsSyncState`, `lastDnsAttempt` i zredagowany `lastDnsError`. Reconciler
   przed i po wywolaniu DuckDNS sprawdza aktualna generacje oraz ponownie czyta
   GCE, aby stary cleanup nie wyczyscil adresu nowszego startu.
5. Wszystkie zapisy calego rejestru Secret Manager sa wykonywane pod
   koordynatorem i warunkowane oczekiwana generacja. Administracja endpointow,
   migracja i lifecycle nie moga wykonywac niezaleznego read-modify-write.
6. Publiczne `/api/config` i pozostale GET-y przestaja wykonywac mutujaca
   rekonsyliacje.
7. GUI administratora ma pokazywac dla endpointu bez VM `No VM assigned`, a dla
   zatrzymanej VM `Offline - ephemeral IP released`, zamiast sugerowac aktywny
   adres.
8. Blad czyszczenia DNS nie cofa poprawnego zatrzymania VM, ale jest widoczny w
   odpowiedzi/statusie i pozostawia stan umozliwiajacy ponowienie.
9. Helper sprzatajacy przyjmuje jawny endpoint/instance. `stopRunningInstances`
   musi posprzatac DNS i rejestr kazdej zatrzymanej innej VM, a nie endpoint
   aktualnie wybrany w request context.
10. Po wdrozeniu wykonac dry-run rekonsyliacji, ponownie odczytac GCE i dopiero
    potem kontrolowane `clear=true` dla domen bez dzialajacej VM, w tym starego
    wpisu `mwo-vm3`.

### 3. Healthcheck i dryf wdrozenia

1. Nie dodawac kolejnego routingu: aktualny kod juz obsluguje `/healthz` oraz
   `/api/healthz`.
2. Dodac test kontraktowy obu sciezek.
3. Wdrozyc aktualny commit jako kandydata, sprawdzic oba endpointy na URL
   kandydata, a dopiero potem skierowac 100% ruchu.
4. Po promocji potwierdzic 200 na obu sciezkach produkcyjnych i zgodnosc rewizji
   z wdrozonym commitem.
5. `/healthz` zwraca `BUILD_COMMIT_SHA`, nazwe rewizji i nieujawniajacy sekretow
   identyfikator obrazu, aby wykryc dryf bez zgadywania.

### 4. Favicon

1. Dodac jeden lokalny, lekki plik SVG w `docs/vm-control/`.
2. Dodac relatywny `<link rel="icon">` do wszystkich stron HTML panelu, lacznie
   ze stronami przekierowujacymi.
3. Zweryfikowac HTTP 200 i brak nowego bledu konsoli po publikacji Pages.

### 5. Dokumentacja

1. Usunac z `docs/architecture.md` nietrwale twierdzenie, ze aktualnie nie ma
   VM ani dyskow.
2. Pozostawic architekture niezalezna od chwilowego inwentarza i wskazac GUI lub
   bezpieczne komendy `gcloud` jako zrodlo biezacego stanu.
3. Nie dodawac nieistniejacego `runbook.md`; poprawic tylko istniejace dokumenty.

## Testy

1. Testy jednostkowe koordynatora: pierwsze pozyskanie, konflikt, heartbeat,
   timeout po przyjeciu operacji GCE, `UNKNOWN`, reconcile, ABA oraz bezpieczne
   zakonczenie z obcym tokenem/generacja.
2. Testy backendu: `create` i `start` zwracaja 409 przy innej dzialajacej VM;
   jawne `stopRunningInstances` zatrzymuje ja przed dalsza operacja.
3. Test wspolbieznosci na emulatorze Firestore albo dwoma klientami: dwa
   rownolegle zadania `create/start` nie moga oba przejsc sekcji przyjecia.
4. Test migracji: uruchomienie przygotowanego celu korzysta z tej samej blokady.
5. Testy DuckDNS: update, clear, retry, redakcja tokenu i brak clear dla
   recznego statycznego IP.
6. Testy rekonsyliacji endpointow dla VM RUNNING, PROVISIONING, STAGING,
   STOPPING, TERMINATED i usunietej oraz wyscig starego clear z nowszym startem.
7. Testy `stopRunningInstances` obejmuja IP, DNS i rejestr zatrzymanej innej VM.
8. Pelny zestaw `cloud-run-vm-control`.
9. Test kandydata Cloud Run: auth, CORS, `/healthz`, `/api/healthz`, status i
   blokada wielu VM na mockowanej lub bezpiecznej sciezce.
10. E2E GUI przez CDP 9222: administrator, zwykly uzytkownik, endpointy, odswiezenie
   statusu, favicon i brak bledow konsoli.
11. Kontrolowany E2E CPU: Start -> gotowosc -> Status -> Stop, z potwierdzeniem
    czyszczenia IP/DNS i obowiazkowym przywroceniem obu VM do `TERMINATED`.
12. Po tescie: delta zasobow nalezacych do `steam-*` nie zawiera aktywnych
    rezerwacji GPU, snapshotow migracyjnych ani nieplanowanych statycznych IP.
    Nie stawiac asercji obejmujacej obce zasoby calego wspoldzielonego projektu.

## Wdrozenie i rollback

1. Zapisac stan bazowy rewizji Cloud Run, ruchu, VM, DNS i endpointow.
2. Uruchomic testy lokalne.
3. Zakomitowac i wypchnac sprawdzony stan.
4. Zmienic deploy na jawne fazy: deploy bez ruchu, test konkretnej nazwanej
   rewizji i promocja tej rewizji, nigdy nieokreslonego `latest`.
5. Pierwsza rewizja pomostowa rozumie nowy protokol, ale mutacje pozostaja
   czasowo zablokowane. Po odczekaniu maksymalnego timeoutu starej rewizji i
   reconcile mozna wlaczyc lifecycle. Rollback kieruje tylko do rewizji
   znajacej nowy protokol.
6. Przeniesc 100% ruchu dopiero po sukcesie testow kandydata i drenażu starych
   requestow.
7. Backend/funkcjonalnosc wdrozyc i zatwierdzic osobno. Favicon i dokumentacje
   opublikowac w drugim, niezaleznym commicie, aby nie powiekszac rollbacku
   backendu.
8. Przy regresji cofnac ruch do bezpiecznej rewizji pomostowej; nie cofac
   poprawnie wyczyszczonych rekordow DNS do historycznych efemerycznych IP.
9. Koncowy raport ma zawierac commit, dokladna rewizje, image digest, testy,
   stan VM i pozostale
   ryzyka lub testy pominiete.
