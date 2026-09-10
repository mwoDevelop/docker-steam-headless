# Wyniki synchronizacji statusow i testow E2E (2026-09-10)

Plan: [Synchronizacja statusow i testy E2E](action-status-sync-e2e-plan.md).

## Podsumowanie

Wdrozone poprawki synchronizacji statusow przeszly testy lokalne oraz testy
przegladarkowe. Rzeczywisty start i stop istniejacej VM CPU zakonczyl sie
poprawnie, z automatyczna aktualizacja drugiej karty przegladarki.

Pelny test GPU pozostaje niezrealizowany: GCP odmowilo startu istniejacej L4
w europe-west3-a z powodu braku zasobow. Nie wykonywano nieuzgodnionej migracji,
recreacji ani usuwania dyskow uzytkownika.

## Plan i niezalezny przeglad

- Plan poddano niezaleznemu przegladowi przez agy-yolo, model
  `gemini-3.8-flash-high`, sesja `f28b15e8-8d18-490d-988a-f2d894dfe068`.
- Przeglad byl tylko do odczytu. Uwzgledniono opoznienia propagacji metadanych,
  bledy odczytu statusu, zmiane endpointu podczas zapytania, aktywne i ukryte
  karty oraz rozroznienie testow izolowanych od rzeczywistych operacji VM.
- Powiadomienia miedzy kartami sa sygnalem do odswiezenia, nie zrodlem
  autorytatywnego statusu. Stan nadal pochodzi z backendu.

## Wdrozone poprawki

- Stara odpowiedz statusu nie nadpisuje widoku po zmianie wybranego endpointu
  lub konfiguracji docelowej VM.
- Chwilowy blad albo pusta odpowiedz odczytu nie konczy sledzenia operacji.
- Zmiana endpointu konczy komunikat `Loading selected VM status...` rzeczywistym
  wynikiem odswiezenia, zamiast pozostawiac komunikat ladowania.
- Powiadomienia dzialaja miedzy kartami oraz pomiedzy modulami tej samej strony.
  Odswiezanie po zdarzeniu ma ograniczone czasowo przyspieszenie i debounce.
- Operacje administracyjne, w tym migracje, wysylaja sygnaly uniewazniajace
  odpowiednie widoki. Migracja moze dotyczyc obu endpointow.
- Sunshine dla dzialajacej VM CPU pozostaje `Disabled` takze podczas operacji
  cyklu zycia. Ogolny status startu, restartu lub zatrzymywania nie sugeruje
  uruchamiania Sunshine, ktorego na tym profilu nie ma.

## Wersje wdrozenia

| Element | Wersja / wynik |
| --- | --- |
| Frontend i testy synchronizacji | `f9f13703b6f02cac2c2bc77656c224656e792381` |
| GitHub Pages | Workflow `34489412412`: success; nowy frontend sprawdzony w przegladarce |
| Poprawka statusu Sunshine na CPU | `4e41054ee9b4268689951bf023144a943b700231` |
| Cloud Run | `steam-vm-control-api-00403-zar`, 100% ruchu |
| Healthcheck | `/api/healthz`: `ok: true`, commit `4e41054ee9b4268689951bf023144a943b700231` |

## Testy automatyczne

| Zestaw | Wynik |
| --- | --- |
| Python: `cloud-run-vm-control/` | 127 testow i 64 subtesty: PASS |
| `test_action_status_sync_edges.cjs` | 15 przypadkow: PASS |
| `test_cross_tab_status_sync.cjs` | 12 sprawdzen: PASS |
| `test_runtime_catalog_ui.cjs` | 10 sprawdzen: PASS |
| Skladnia zmienionego JavaScript | PASS |

Testy obejmuja m.in. puste i bledne odpowiedzi, ochrone przed starym wynikiem
po zmianie wyboru, filtrowanie endpointow, zachowanie przy aktywnym loaderze,
obsluge zdarzen oraz status Sunshine dla profili CPU i GPU.

## Testy przegladarkowe i rzeczywiste operacje

| Scenariusz | Wynik i zakres dowodu |
| --- | --- |
| Trzy izolowane karty z rzeczywistym BroadcastChannel i CustomEvent | PASS: odswiezanie zgodnego endpointu, izolacja innego endpointu, globalny sygnal migracji; bez operacji produkcyjnych |
| Zmiana endpointu w panelu administratora | PASS: loader znika, komunikat pokazuje finalny status |
| Start istniejacej VM CPU przez GUI | PASS: okolo 202 s; loader pozostaje do zakonczenia, VM RUNNING |
| Druga karta na Software podczas startu CPU | PASS: bez recznego odswiezania TERMINATED -> STAGING -> RUNNING; Minecraft dziala |
| Ukryty modul VM Control drugiej karty z innym endpointem | PASS: nie przejmuje komunikatow operacji CPU |
| Refresh version list na Software | PASS: katalog odswiezony, loader znika, brak dodatkowego zdarzenia operacji VM |
| Stop CPU przez GUI po wdrozeniu backendu | PASS: okolo 63 s; obie karty pokazuja stan koncowy TERMINATED |
| Sunshine podczas stop CPU | PASS: odpowiedz API dla VM RUNNING i fazy stopping zawiera Sunshine Disabled; po STOPPING pokazuje VM not running |
| Start istniejacej L4 w europe-west3-a | ZABLOKOWANY PRZEZ GCP: ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS |
| Obsluga nieudanego startu L4 w GUI | PASS: odzyskana rzeczywista przyczyna bledu, loader znika, Start ponownie aktywny |

Wskazanie przez GCP europe-west3-b jako alternatywy nie stanowi potwierdzenia
biezacej dostepnosci. W tym tescie nie migrowano VM do tej strefy.

## Zakres nadal do wykonania

- Aktualizacja obrazu Sunshine i manualny rollback na rzeczywiscie uruchomionej
  VM GPU po nowych poprawkach synchronizacji.
- Automatyczny rollback po kontrolowanym niepowodzeniu healthchecka.
- Rzeczywiste polaczenie Moonlight: obraz, dzwiek, mysz i klawiatura.
- Migracja oraz instalacja/deinstalacja aplikacji jako dodatkowa regresja
  rzeczywistych mutacji. Test komunikatow migracji nie zastepuje takiego E2E.

Powyzszych przypadkow nie oznaczono jako PASS. Wymagaja dostepnej karty GPU
lub osobnego, bezpiecznego scenariusza zmiany danych istniejacych VM.

## Stan po testach

- `steam-mwo-vm1-cpu-europe-central2-c`: TERMINATED.
- `steam-mwo-vm2-l4-europe-west3-a`: TERMINATED.
- Lista rezerwacji Compute Engine w projekcie `docker-414215`: pusta.
- Nie usunieto istniejacych maszyn ani ich dyskow; nie utworzono nowych VM.
- Zamknieto pomocnicze karty testowe i usunieto tymczasowe hooki diagnostyczne.
- W glownej karcie przywrocono endpoint `mwo-vm2` i Auto-stop hours = 3.
  Loader nie jest widoczny, a status wskazuje TERMINATED.

To datowany wynik testow, nie gwarancja niezmiennego stanu zasobow GCP.
